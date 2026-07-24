// The HTTP boundary for POST /comments. It owns exactly two things the pipeline
// does not: bounding the raw request body before anything parses it, and mapping a
// SubmitResult onto a status code and content type. The pipeline owns the order of
// everything in between.
// Enforced by test/worker/submit/route.test.ts.

import type { Context } from 'hono'
import { runSubmission } from './pipeline'
import type { SubmitResult } from './pipeline'
import type { SpamCheck } from './spam'

/**
 * The largest raw body accepted, checked before Zod and before JSON.parse. A valid
 * submission is a ~10,000-character body plus a few short fields — well under this.
 * Cloudflare's edge already refuses bodies over 100 MB (free plan, verified
 * 2026-07-24); this is the Worker's own, far tighter, bound so that a megabyte of
 * attacker JSON is dropped without the parser or the validator ever running.
 */
export const MAX_BODY_BYTES = 64 * 1024

const TEXT = 'text/plain; charset=utf-8'
const HTML = 'text/html; charset=utf-8'

function tooLarge(): Response {
  return new Response('That request was too large.', {
    status: 413,
    headers: { 'content-type': TEXT },
  })
}

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
 * The size guard is two checks, because either alone has a hole: a declared
 * Content-Length past the cap is refused without reading the body, and the bytes
 * actually read are checked too, so an absent or understated Content-Length cannot
 * smuggle a large body past the first check. Only then is the text parsed as JSON —
 * malformed JSON is a 400, never a 500.
 */
export async function handleSubmit(
  c: Context<{ Bindings: Env }>,
  config: SubmitRouteConfig,
): Promise<Response> {
  const declared = c.req.header('content-length')
  if (declared !== undefined) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) return tooLarge()
  }

  const buffer = await c.req.arrayBuffer()
  if (buffer.byteLength > MAX_BODY_BYTES) return tooLarge()

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(buffer))
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
