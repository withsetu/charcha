// The credential check. One comparison, and it is the whole of the dashboard's
// front door — so every property of it is load-bearing.
// Enforced by test/worker/admin/password.test.ts.

/**
 * The longest supplied password this will compare.
 *
 * The request body is already bounded by src/request-body.ts, so this is not the
 * DoS guard; it is a guard on the shape of the input. A "password" of 60,000
 * characters is not a password, and hashing it to find that out spends work an
 * unauthenticated caller chose. The bound is on the *supplied* value only — it is
 * a constant, never the secret's length, so nothing about the secret leaks through
 * it.
 */
export const MAX_SUPPLIED_PASSWORD_LENGTH = 1024

/**
 * The configured password, or null when there is none.
 *
 * Trimmed, following usableIpSecret in src/spam/ip.ts and for the same reason: a
 * secret pasted into a deploy form or a dashboard field arrives with a trailing
 * newline more often than anyone would like, and a credential that silently
 * differs from what the owner thinks they set is a locked-out dashboard with no
 * diagnosis. The supplied value is deliberately *not* trimmed — the owner types
 * what they set, and quietly accepting `"hunter2 "` for `"hunter2"` would widen
 * the credential rather than normalise it.
 *
 * Blank is null, not a password. An empty secret compared against an empty
 * submission would match, which is an open dashboard that every test of the
 * comparison still passes.
 * Enforced by test/worker/admin/password.test.ts.
 */
export function usableDashboardPassword(secret: string | undefined): string | null {
  const trimmed = secret?.trim()
  return trimmed === undefined || trimmed === '' ? null : trimmed
}

/** SHA-256 of a string, as the 32 raw bytes. */
async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
}

/**
 * Whether `supplied` is the configured password, compared in constant time.
 *
 * **Both sides are hashed first, and the two 32-byte digests are what get
 * compared.** `crypto.subtle.timingSafeEqual` is a real, documented Web Crypto
 * extension in Workers — "Compare two buffers in a way that is resistant to timing
 * attacks. This is a non-standard extension to the Web Crypto API"
 * (https://developers.cloudflare.com/workers/runtime-apis/web-crypto/, checked
 * 2026-07-25) — but its behaviour on buffers of *unequal length* is not documented
 * at all. Hashing sidesteps that entirely: two SHA-256 digests are always 32 bytes,
 * so the comparison is only ever the case the documentation covers.
 *
 * It buys the second property as well, and that one is the point. Comparing the raw
 * strings would need a length check first, and a length check is a length oracle:
 * an attacker learns how long the secret is before guessing a character of it.
 * Digests are the same length whatever they digest.
 *
 * A missing or blank secret never reaches here — see usableDashboardPassword and
 * the callers in src/admin/authenticate.ts.
 * Enforced by test/worker/admin/password.test.ts.
 */
export async function passwordMatches(supplied: unknown, secret: string): Promise<boolean> {
  if (typeof supplied !== 'string') return false
  if (supplied.length > MAX_SUPPLIED_PASSWORD_LENGTH) return false

  const [a, b] = await Promise.all([digest(supplied), digest(secret)])
  return crypto.subtle.timingSafeEqual(a, b)
}
