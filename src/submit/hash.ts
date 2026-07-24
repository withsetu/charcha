// The body hash the data layer stores for duplicate detection.
//
// `comments.body_hash` is NOT NULL and indexed as (thread_id, body_hash), so
// #8's duplicate-body layer can ask "has this exact body already been posted to
// this thread?" with one indexed lookup. The only property required is that
// identical bodies hash identically and distinct bodies effectively never do —
// this is not a secret and does not need a key. SHA-256 gives that, is available
// in workerd via the Web Crypto API, and adds no dependency.
//
// The caller hashes the *stored* body (already trimmed), so this function does no
// normalisation of its own — trimming here would let two different stored strings
// share a hash. Enforced by test/worker/submit/hash.test.ts.

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'))

export async function computeBodyHash(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const view = new Uint8Array(digest)

  let hex = ''
  for (let index = 0; index < view.length; index++) hex += HEX[view[index] as number]
  return hex
}
