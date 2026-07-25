// The dashboard session: a signed expiry in a cookie, and no server-side state.
//
// **Stateless, and that is a budget decision as much as a simplicity one.** A
// session table in D1 would cost one query on every authenticated request against
// the 50-per-invocation budget, and one write per login against the 100k/day write
// budget that the public comment path also spends. A signed token costs neither.
// The price is that there is no per-session revocation: rotating
// CHARCHA_DASHBOARD_PASSWORD invalidates every session at once, because the signing
// key is derived from it. For a single-owner dashboard that is the whole of the
// revocation story anyone needs.
//
// Enforced by test/worker/admin/session.test.ts and test/worker/admin/cookie-scope.test.ts.

/**
 * The session cookie's name.
 *
 * `__Secure-` and deliberately not `__Host-`. Both prefixes require the `Secure`
 * attribute and an HTTPS setter; `__Host-` additionally "must not have a `Domain`
 * attribute specified, and the `Path` attribute must be set to `/`"
 * (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie,
 * checked 2026-07-25) — and `Path=/` is exactly what this design must not do. See
 * SESSION_COOKIE_PATH.
 */
export const SESSION_COOKIE_NAME = '__Secure-charcha_session'

/**
 * The path the session cookie is scoped to, and the mechanical answer to card
 * rule 8.
 *
 * Rule 8 is "no reader-side cookies, ever". The dashboard is the owner's
 * authenticated surface and a session cookie there is expected — but a cookie set
 * at `Path=/` on this Worker's origin would be attached by the browser to
 * `GET /comments` and `POST /comments` as well, and those are reader requests. The
 * promise would then be false in the one place it is made.
 *
 * `Path` is what prevents it, not a convention: it "indicates the path that must
 * exist in the requested URL for the browser to send the `Cookie` header", and for
 * `Path=/docs` the paths `/`, `/docsets` and `/fr/docs` do not match (MDN, above).
 * So `/admin` reaches `/admin`, `/admin/` and `/admin/api/...` and reaches nothing
 * else on this origin — the reader-facing endpoints included.
 *
 * That property is asserted rather than described: test/worker/admin/cookie-scope.test.ts
 * drives a real browser-shaped cookie jar over a login and then a read, and fails
 * if the session cookie appears on `/comments`.
 */
export const SESSION_COOKIE_PATH = '/admin'

/**
 * How long a session lasts. Twelve hours is a working day of moderation and not a
 * standing key: a stolen token expires without anyone having to notice, which
 * matters more here than usual because there is no per-session revocation.
 */
export const SESSION_LIFETIME_SECONDS = 43_200

/**
 * The longest cookie value this will look at.
 *
 * A real token is around 55 characters. The cap is generous and still bounds the
 * work an unauthenticated caller can ask for before anything is parsed, decoded or
 * hashed — a cookie header is untrusted input like any other (card rule 5).
 */
const MAX_TOKEN_LENGTH = 128

/**
 * The most cookie pairs this will look at, and the most candidate tokens it will
 * verify.
 *
 * **Deliberately a bound on the work, not on the header.** The first version of this
 * refused to parse a `Cookie` header over 4096 bytes, which is not a guard at all:
 * browsers allow roughly that much *per cookie* and well over a hundred cookies per
 * domain, so an ordinary custom-domain deployment carrying analytics or CDN cookies
 * would exceed it in normal use — and its owner would be signed out of their own
 * dashboard with a 401 and nothing to diagnose. Anyone able to write one large cookie
 * on a sibling host could do it deliberately. The token's own length cap already
 * bounds the expensive part; this bounds the number of times it is paid.
 * Enforced by test/worker/admin/session.test.ts.
 */
const MAX_COOKIE_PAIRS = 128

/** The most session candidates verified per request. Each one costs two HMACs. */
const MAX_SESSION_CANDIDATES = 4

/** Ten digits of unix seconds runs to the year 2286. Anything longer is not a time. */
const EXPIRY_PATTERN = /^\d{1,10}$/

/** A signature is one SHA-256 HMAC: 32 bytes, always, whatever it signed. */
const SIGNATURE_BYTES = 32

/**
 * The label the signing key is derived under.
 *
 * Domain separation, and it is not ceremony: CHARCHA_DASHBOARD_PASSWORD is also
 * compared directly against a submitted password, and the day something else in
 * this Worker signs with the same secret, a token from one use would verify under
 * the other. The `/v1` is what lets the derivation change later without a silent
 * cross-version forgery.
 */
const SESSION_KEY_LABEL = 'charcha/session-key/v1'

/** The prefix the signed message carries, so a bare number is never what is signed. */
const SESSION_MESSAGE_PREFIX = 'charcha/session/v1:'

const encoder = new TextEncoder()

/**
 * The HMAC key for session tokens: HMAC(secret, label), imported as a key.
 *
 * Derived rather than used raw so the secret itself never signs anything. See
 * SESSION_KEY_LABEL.
 */
async function sessionKey(secret: string): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const derived = await crypto.subtle.sign('HMAC', root, encoder.encode(SESSION_KEY_LABEL))
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

/** base64url, unpadded — a cookie value may not contain `=`, `+` or `/` unquoted. */
function toBase64Url(bytes: ArrayBuffer): string {
  let binary = ''
  const view = new Uint8Array(bytes)
  for (let index = 0; index < view.length; index++)
    binary += String.fromCharCode(view[index] as number)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The bytes a base64url string stands for, or null if it is not the *canonical*
 * spelling of them.
 *
 * Two checks, and the second exists because the first is not enough. The alphabet
 * test rejects what `atob` would tolerate — whitespace, base64's `+` and `/`,
 * padding — so a signature respelled in standard base64 is not a second spelling of
 * the same session. But base64 is still not injective at the tail: 43 characters
 * carry 258 bits where a signature is 256, so `atob` silently ignores two bits and
 * **four different final characters decode to identical bytes**. A fresh-context
 * review of this file found three other cookie values that verified against a valid
 * token.
 *
 * Re-encoding and comparing closes that: only the spelling this module would itself
 * have produced is accepted. No forgery was possible either way — the bytes still
 * have to be the right HMAC — but a verifier that accepts more strings than it issues
 * has a token that cannot be used as an identity, which is what a revocation list or
 * a deduplicated log line would quietly assume it could be.
 * Enforced by test/worker/admin/session.test.ts.
 */
function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null

  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  let binary: string
  try {
    binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  } catch {
    return null
  }

  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)

  return toBase64Url(bytes.buffer) === value ? bytes : null
}

async function sign(secret: string, expiry: number): Promise<ArrayBuffer> {
  return crypto.subtle.sign(
    'HMAC',
    await sessionKey(secret),
    encoder.encode(`${SESSION_MESSAGE_PREFIX}${expiry}`),
  )
}

export interface IssuedSession {
  token: string
  expiresAt: number
}

/**
 * A fresh token, valid for SESSION_LIFETIME_SECONDS from `now`.
 *
 * `now` is passed in and never read from a clock here, matching the data layer, so
 * the expiry boundary is a test's to pin rather than a race to reproduce.
 * Enforced by test/worker/admin/session.test.ts.
 */
export async function issueSession(secret: string, now: number): Promise<IssuedSession> {
  const expiresAt = now + SESSION_LIFETIME_SECONDS
  return { token: `${expiresAt}.${toBase64Url(await sign(secret, expiresAt))}`, expiresAt }
}

/**
 * Whether `token` is a session this deployment issued and has not outlived.
 *
 * Checked in this order, and the order is the design — everything cheap and
 * structural happens before a byte is hashed, so an unauthenticated caller cannot
 * make this endpoint do HMAC work by sending rubbish:
 *
 *   1. it is a string, and no longer than MAX_TOKEN_LENGTH
 *   2. exactly two dot-separated parts
 *   3. the expiry is one to ten digits, so `Number` cannot produce `Infinity`,
 *      `NaN`, or a value from `'0x10'` or `'1e9'`
 *   4. the signature decodes from base64url to exactly SIGNATURE_BYTES
 *   5. the signature matches, compared with timingSafeEqual on two equal-length
 *      buffers — the only case Workers documents
 *   6. the expiry is in the future
 *
 * **Signature before expiry, deliberately.** Checking expiry first would answer
 * "was this ever a valid shape and when did it expire?" to a caller holding a
 * forgery, and it would let an attacker skip the comparison entirely by sending a
 * stale timestamp. The signature covers the expiry, so verifying it first is what
 * makes the expiry trustworthy enough to act on.
 * Enforced by test/worker/admin/session.test.ts.
 */
export async function verifySession(token: unknown, secret: string, now: number): Promise<boolean> {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return false
  }

  const parts = token.split('.')
  if (parts.length !== 2) return false
  const [expiryText, signatureText] = parts as [string, string]

  if (!EXPIRY_PATTERN.test(expiryText)) return false
  const expiry = Number(expiryText)
  if (!Number.isSafeInteger(expiry)) return false

  const supplied = fromBase64Url(signatureText)
  if (supplied === null || supplied.byteLength !== SIGNATURE_BYTES) return false

  const expected = await sign(secret, expiry)
  if (!crypto.subtle.timingSafeEqual(supplied, expected)) return false

  return expiry > now
}

/**
 * The `Set-Cookie` value that starts a session.
 *
 * Every attribute is a guard, none is a default:
 *   - `HttpOnly` — script on the dashboard page cannot read the token, so an XSS
 *     in the React app (#13) cannot exfiltrate a working session.
 *   - `Secure` — required by the `__Secure-` prefix, and the token is a bearer
 *     credential that must never cross plaintext.
 *   - `SameSite=Strict` — the first of the two CSRF layers, and the only one that
 *     covers a cross-site *GET*: browsers omit `Origin` on same-origin GET and HEAD
 *     (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin,
 *     checked 2026-07-25), so an Origin check cannot tell a cross-site GET from an
 *     ordinary one. See src/admin/csrf.ts for the second layer.
 *   - `Path=/admin` — card rule 8, held mechanically. See SESSION_COOKIE_PATH.
 *   - `Max-Age` — a bounded lifetime, matching the signed expiry, so a browser
 *     drops the cookie at roughly the moment the Worker would stop accepting it.
 * Enforced by test/worker/admin/session.test.ts and test/worker/admin/cookie-scope.test.ts.
 */
export function sessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Path=${SESSION_COOKIE_PATH}`,
    `Max-Age=${SESSION_LIFETIME_SECONDS}`,
  ].join('; ')
}

/**
 * The `Set-Cookie` value that ends one.
 *
 * The same name, path and flags with `Max-Age=0`. The path has to match or the
 * browser keeps the original cookie and adds an expired one beside it, which is a
 * logout button that does nothing.
 * Enforced by test/worker/admin/session.test.ts.
 */
export function clearedSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Path=${SESSION_COOKIE_PATH}`,
    'Max-Age=0',
  ].join('; ')
}

/**
 * Every session token the request carries, in the order the header lists them.
 *
 * **Plural, and that is the fix for a real lockout rather than a nicety.** A request
 * may carry more than one cookie of the same name: the `__Secure-` prefix constrains
 * the `Secure` attribute and the setting scheme, and says nothing whatsoever about
 * `Domain`, so on a custom-domain deployment anything able to write a cookie on a
 * sibling host can plant one. A reader that took only the first match would let that
 * planted value sign the owner out of their own dashboard indefinitely — a 401 with
 * no explanation, for as long as it sat there. The caller tries them all; see
 * sessionAuthenticator.
 *
 * A value that cannot be a token is dropped here rather than counted against the
 * candidate budget, so a jar full of same-named junk cannot crowd out the real one.
 * A name match is exact: `x__Secure-charcha_session` and
 * `__Secure-charcha_session_old` are different cookies and neither is this one.
 * Enforced by test/worker/admin/session.test.ts.
 */
export function readSessionCookies(request: Request): string[] {
  const header = request.headers.get('cookie')
  if (header === null) return []

  const tokens: string[] = []
  const pairs = header.split(';')
  const scanned = Math.min(pairs.length, MAX_COOKIE_PAIRS)

  for (let index = 0; index < scanned; index++) {
    const pair = pairs[index] as string
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    if (pair.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue

    const value = pair.slice(separator + 1).trim()
    if (value === '' || value.length > MAX_TOKEN_LENGTH) continue

    tokens.push(value)
    if (tokens.length === MAX_SESSION_CANDIDATES) break
  }
  return tokens
}
