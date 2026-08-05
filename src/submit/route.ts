// The HTTP boundary for POST /comments. It owns the three things the pipeline does
// not: bounding the raw request body before anything parses it, mapping a
// SubmitResult onto a status code and content type, and assembling the two
// per-request dependencies that exist only on the Context — the notifier built from
// `c.env`, and the `waitUntil` that runs it after the response (#125). The pipeline
// owns the order of everything in between.
// Enforced by test/worker/submit/route.test.ts.

import type { Context } from 'hono'
import { createNotifier } from '../notify'
import { readCappedText } from '../request-body'
import { declaredOrigins } from '../settings'
import type { SiteSettings } from '../settings'
import { withFragmentHeaders } from '../response-headers'
// Generic isolate-scoped observability, despite the path — see src/spam/log.ts. Its
// dedupe set is shared across callers, so the key used here is namespaced.
import { announceOnce } from '../spam/log'
import { runSubmission } from './pipeline'
import type { SubmitResult } from './pipeline'
import type { SpamCheck } from './spam'

const TEXT = 'text/plain; charset=utf-8'
const HTML = 'text/html; charset=utf-8'

function unreadable(): Response {
  return new Response('That request could not be read.', {
    status: 400,
    headers: { 'content-type': TEXT },
  })
}

/**
 * Maps a pipeline outcome to a response. Success bodies are HTML — the rendered
 * comment, from the one renderer (card rule 4). Error bodies are plain text with a
 * reader-facing message, matching the existing route house style.
 *
 * The status code carries the taxonomy so the embed can branch without parsing a
 * body: 201 published, 202 accepted-and-pending, 400 the reader's input, 403 refused.
 * A failed submission never shares a status with a successful one.
 *
 * **`rejected` has two producers and one status, deliberately.** A spam rejection and an
 * address this deployment does not take comments for (#224) are both a 403 the reader
 * cannot act on, and splitting them would be a status code that tells a script which of
 * the two it hit. What differs is the message — the spam one is deliberately generic, the
 * address one names the setting for the owner reading it — and, in the log, the reason.
 *
 * **It does not add the #98 headers, and a caller other than handleSubmit would
 * therefore ship without them.** They are added once, around this function, for the
 * reason #98 exists — a header spread at each of four returns is a header missing
 * from the fifth. This is exported for the tests below it; the route is the only
 * caller, and a second one should go through handleSubmit rather than around it.
 * Enforced by test/worker/response-headers.test.ts.
 */
export function renderResult(result: SubmitResult): Response {
  switch (result.outcome) {
    case 'published':
      return new Response(result.html, { status: 201, headers: { 'content-type': HTML } })
    case 'pending':
      return new Response(result.html, { status: 202, headers: { 'content-type': HTML } })
    case 'invalid':
      return new Response(result.message, { status: 400, headers: { 'content-type': TEXT } })
    case 'rejected':
      return new Response(result.message, { status: 403, headers: { 'content-type': TEXT } })
  }
}

export interface SubmitRouteConfig {
  spamCheck: SpamCheck
  significantParams?: readonly string[]
  /**
   * Every `settings` row this request needs, read once by the route in one statement
   * (#207).
   *
   * It is passed in rather than read here because the spam check is assembled from the
   * same read — layer 8's site URL is one of these rows — and doing it twice would be two
   * statements for one answer. Absent means an unconfigured deployment: `hold-all`, no
   * notifications, layer 8 off, and — since #224 — no declared address, so no comment is
   * accepted for any address but this deployment's own. Every one of those is the
   * fail-closed direction.
   */
  settings?: SiteSettings
  /** Injectable for tests; defaults to the wall clock in unix seconds. */
  now?: () => number
}

/**
 * Reads and size-caps the body, then hands the parsed JSON to the pipeline.
 *
 * The size guard is src/request-body.ts, shared with the preview route so that the
 * two public POSTs cannot drift to different limits. Only a body inside the cap is
 * parsed as JSON — malformed JSON is a 400, never a 500.
 */
export async function handleSubmit(
  c: Context<{ Bindings: Env }>,
  config: SubmitRouteConfig,
): Promise<Response> {
  // One wrap point rather than a spread at each return (#98). The 201 and 202
  // bodies are the reader's own comment rendered back to them, so this response
  // carries attacker-influenced HTML on this Worker's origin exactly as the read
  // does. src/index.ts re-wraps the result with withCors, which copies headers
  // rather than replacing them, so these survive it.
  // Enforced by test/worker/response-headers.test.ts.
  return withFragmentHeaders(await submitAnswer(c, config))
}

/**
 * The one method this file needs from an execution context.
 *
 * Structural rather than `ExecutionContext`, because there are two of those: Hono
 * declares its own and `c.executionCtx` is typed with it, while the generated binding
 * types declare Cloudflare's, and they are not assignable to each other. Neither
 * difference has anything to do with deferring work.
 */
export interface WaitUntilContext {
  waitUntil(work: Promise<unknown>): void
}

/**
 * Runs `work` after the reader's response has gone out, and makes its failure report
 * itself.
 *
 * `ctx.waitUntil` "extends the lifetime of your Worker, allowing you to perform work
 * without blocking returning a response", with a 30-second limit after the invocation
 * ends. What Cloudflare documents about a promise passed to it *rejecting* is only
 * that other `waitUntil` promises keep running — nothing surfaces the rejection
 * itself (https://developers.cloudflare.com/workers/runtime-apis/context/, checked
 * 2026-07-28). So a bare `ctx.waitUntil(work)` is the discarded-rejection bug
 * CLAUDE.md names, and the `.catch` here is the whole of what stops it: an email that
 * never sent says so in the log rather than vanishing. #128 is where these become
 * visible in the dashboard.
 *
 * `Notifier.commentCreated` already promises never to reject, and this deliberately
 * does not trust it — that promise is a comment in another module, and this is the
 * call site that would pay for it being wrong. Exported for the test below; the only
 * caller is `deferFor`.
 * Enforced by test/worker/notify/route-wiring.test.ts.
 */
export function reportingDefer(ctx: WaitUntilContext): (work: Promise<unknown>) => void {
  return (work) => {
    ctx.waitUntil(
      work.catch((error: unknown) => {
        console.error('notify: deferred work failed', error)
      }),
    )
  }
}

/**
 * The Context's `waitUntil`, or nothing at all.
 *
 * Read inside the handler, never at module scope, and never stored: `c.executionCtx`
 * is a getter that **throws** when the invocation has none rather than returning
 * undefined, so asking is the only way to find out. A Worker Cloudflare invoked
 * always has one; an app driven directly — `app.fetch(request, env)` — does not.
 *
 * Returning undefined leaves the pipeline's seam inert, which is its documented
 * answer and not a degradation: the two alternatives are awaiting the send, which
 * puts Resend's uptime in front of the reader's POST, and dropping the promise, which
 * discards its failures. Announced once per isolate because a deployment that
 * silently stopped being able to defer would otherwise look exactly like one with no
 * Resend key. See src/submit/pipeline.ts.
 * Enforced by test/worker/notify/route-wiring.test.ts.
 */
function deferFor(c: Context<{ Bindings: Env }>): ((work: Promise<unknown>) => void) | undefined {
  let ctx: WaitUntilContext
  try {
    ctx = c.executionCtx
  } catch {
    announceOnce('submit-no-execution-context', {
      event: 'notify_config',
      enabled: false,
      reason: 'this invocation has no ExecutionContext, so nothing can run after the response',
    })
    return undefined
  }
  return reportingDefer(ctx)
}

async function submitAnswer(
  c: Context<{ Bindings: Env }>,
  config: SubmitRouteConfig,
): Promise<Response> {
  const read = await readCappedText(c.req.raw)
  if (!read.ok) return read.response

  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    return unreadable()
  }

  const now = config.now ? config.now() : Math.floor(Date.now() / 1000)
  const result = await runSubmission(parsed, {
    db: c.env.DB,
    spamCheck: config.spamCheck,
    request: c.req.raw,
    now,
    significantParams: config.significantParams,
    // The same secret the per-IP rate limit hashes with, so the value written here
    // and the value counted there are the same key. Unset on a deployment that has
    // not run `wrangler secret put IP_HASH_SECRET`, and then nothing is stored.
    ipSecret: c.env.IP_HASH_SECRET,
    // The moderation policy, from the same read the notifier's addresses came from
    // (#207) — see SubmitRouteConfig.settings.
    moderationPolicy: config.settings?.moderationPolicy,
    // The addresses the owner declared as theirs (#224), from that same read. Derived
    // here rather than in the pipeline so the pipeline takes a list and nothing else, and
    // an absent `settings` — an unconfigured deployment, or a caller that did not read —
    // resolves to none, which refuses. Fail closed, card rule 5.
    declaredOrigins: config.settings === undefined ? [] : declaredOrigins(config.settings),
    // Email notifications (#125). Both halves are assembled here rather than passed
    // in as config, unlike `spamCheck`: the key is on the Context and the `waitUntil`
    // exists nowhere else, and neither is a seam a caller replaces. Since #207 the two
    // addresses and the display name are settings rather than secrets, so they arrive
    // already resolved rather than being read off `c.env` here. `createNotifier` still
    // returns a notifier that does nothing when any of the three is unset, which is the
    // default on every deployment, so this line is not a switch to check first.
    // Enforced by test/worker/notify/route-wiring.test.ts.
    notifier: createNotifier(c.env, {
      from: config.settings?.notifyFrom ?? null,
      to: config.settings?.notifyTo ?? null,
      fromName: config.settings?.notifyFromName ?? null,
    }),
    defer: deferFor(c),
  })

  return renderResult(result)
}
