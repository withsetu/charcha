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

/**
 * The length below which a configured password is reported as short (#120).
 *
 * Fifteen, because that is the number NIST states for this exact situation:
 * "Verifiers and CSPs SHALL require passwords that are used as a single-factor
 * authentication mechanism to be a minimum of 15 characters in length"
 * (https://pages.nist.gov/800-63-4/sp800-63b.html, checked 2026-07-29). The
 * eight-character figure beside it in the same document is for passwords used
 * *within* multi-factor authentication, and this dashboard has no second factor —
 * the password is the whole of the credential, and rotating it is the whole of the
 * revocation story (src/admin/session.ts).
 *
 * Length and nothing else, from the same source: "Verifiers and CSPs SHALL NOT
 * impose other composition rules (e.g., requiring mixtures of different character
 * types) for passwords." So there is no rule here about digits, case or symbols,
 * and adding one would be a change against the cited guidance rather than a
 * tightening of it.
 * Enforced by test/worker/admin/password.test.ts.
 */
export const MIN_DASHBOARD_PASSWORD_LENGTH = 15

/**
 * Whether the configured password is shorter than the floor.
 *
 * **An advisory, and never a gate.** Nothing on the authentication path calls this,
 * and nothing may: there is no password reset, no second factor and no account, so a
 * deployment already running on a four-character password has no way back in if this
 * ever decides a login. The name says what is measured rather than passing a verdict —
 * `false` means "not short", which is a narrower claim than "not weak" and the only one
 * a length test can support. A fifteen-character password out of a breach corpus is
 * exactly as compromised as a four-character one and this returns `false` for it.
 * The floor is what a deployer can be held to at the moment they are choosing; the
 * defences that cover the rest are the login throttle (src/admin/throttle.ts) and
 * rotation.
 *
 * Measured on the *trimmed* value, because that is the string that would be compared:
 * counting the padding would call `"    abcd    "` long enough, which is about the one
 * input a hurried deployer produces by accident. Counted in code points rather than
 * `.length`, so a password of astral characters is not credited twice for each one.
 *
 * Unset and blank are `false` — absent is not short, it is the harder state, and the
 * dashboard already fails closed on it (src/admin/env.ts). No caller can observe this
 * case anyway: the only one is `GET /admin/api/setup`, which an unconfigured deployment
 * authenticates nobody for.
 * Enforced by test/worker/admin/password.test.ts and test/worker/admin/setup.test.ts.
 */
export function dashboardPasswordIsShort(secret: string | undefined): boolean {
  const usable = usableDashboardPassword(secret)
  return usable !== null && [...usable].length < MIN_DASHBOARD_PASSWORD_LENGTH
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
