// Bounding a raw request body before anything parses it.
//
// One module rather than a constant each public POST copies, because the failure
// mode of copying is not a crash: a second endpoint with its own, looser number
// looks entirely reasonable in isolation and is a way to spend the first
// endpoint's budget. The write and the preview share this cap for that reason
// (#7, #78), and card rule 5 is the rule it implements — size caps everywhere,
// fail closed, before the parser and before the validator.
// Enforced by test/worker/submit/route.test.ts and test/worker/preview/route.test.ts.

/**
 * The largest raw body any public endpoint accepts, checked before Zod, before
 * JSON.parse and before the renderer. A valid submission is a ~10,000-character
 * body plus a few short fields — well under this. Cloudflare's edge already
 * refuses bodies over 100 MB (free plan, verified 2026-07-24); this is the
 * Worker's own, far tighter, bound, so that a megabyte of attacker input is
 * dropped without anything downstream ever running.
 */
export const MAX_BODY_BYTES = 64 * 1024

const TEXT = 'text/plain; charset=utf-8'

/** The refusal. Plain text and a 413, matching the route house style. */
function tooLarge(): Response {
  return new Response('That request was too large.', {
    status: 413,
    headers: { 'content-type': TEXT },
  })
}

export type CappedBody = { ok: true; text: string } | { ok: false; response: Response }

/**
 * Reads a request body as text, or refuses it for being too large.
 *
 * Two checks, because either alone has a hole: a declared Content-Length past the
 * cap is refused without reading the body at all, and the bytes actually read are
 * counted too, so an absent or understated Content-Length — a chunked body carries
 * no Content-Length whatsoever — cannot smuggle a large body past the first check.
 *
 * The decode is deliberately lossy rather than strict: `TextDecoder` replaces
 * invalid UTF-8 with U+FFFD instead of throwing, so malformed bytes become a
 * validation failure the caller can be told about rather than a 500.
 * Enforced by test/worker/submit/route.test.ts and test/worker/preview/route.test.ts.
 */
export async function readCappedText(request: Request): Promise<CappedBody> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > MAX_BODY_BYTES)
      return { ok: false, response: tooLarge() }
  }

  const buffer = await request.arrayBuffer()
  if (buffer.byteLength > MAX_BODY_BYTES) return { ok: false, response: tooLarge() }

  return { ok: true, text: new TextDecoder().decode(buffer) }
}
