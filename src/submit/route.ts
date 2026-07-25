// The HTTP boundary for POST /comments. It owns exactly two things the pipeline
// does not: bounding the raw request body before anything parses it, and mapping a
// SubmitResult onto a status code and content type. The pipeline owns the order of
// everything in between.
// Enforced by test/worker/submit/route.test.ts.

import type { Context } from 'hono'
import { readCappedText } from '../request-body'
import { withFragmentHeaders } from '../response-headers'
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
 * body: 201 published, 202 accepted-and-pending, 400 the reader's input, 403 a
 * spam rejection. A failed submission never shares a status with a successful one.
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
  })

  return renderResult(result)
}
