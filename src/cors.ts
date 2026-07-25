// The origin policy for the public endpoints. Designed on issue #47.
//
// The embed runs on the site owner's own domain and calls this Worker on another,
// so without CORS response headers the reader's browser discards every answer and
// the widget cannot load or submit at all. What the headers say is owner
// configuration rather than a constant, so the allowlist lives in `settings`.
//
// **What this is, and what it is not.** CORS is a browser rule, not a server-side
// authorisation check: anything that is not a browser — curl, a script, the v1.1
// build-time renderer — sends no `Origin` and ignores every header in this file. So
// the allowlist is a misuse guard, not a security boundary; the defence against a
// script is #8's spam layers and the moderation queue, and it always was. What this
// does stop is another site's *page* posting into this deployment's queue from a
// reader's browser, which is the case a reader cannot see and did not consent to.
//
// **The preflight is not that gate, and assuming it was is the bug this file was
// written with.** The embed sends `application/json`, which is not CORS-safelisted,
// so the embed's own submissions are preflighted — but an attacker chooses their own
// content type, and `text/plain` makes the very same POST a *simple request* that no
// browser preflights at all. A policy enforced only at `OPTIONS` is therefore a
// policy an attacker opts out of by changing one header. So the write refuses a
// present-but-unlisted `Origin` on the real request too, which is the check that
// holds whatever the content type is, and which also makes de-listing an origin take
// effect immediately rather than after a cached preflight expires.
// https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS
//
// The read does not refuse, deliberately: it has no side effect, its HTML is public
// to anything that can make a request at all, and refusing would break the v1.1
// server-rendering paths for nothing. Withholding the header is the whole of the
// read's policy; the write needs more because a write happens whether or not the
// caller can read the answer.
//
// Fail closed: an unconfigured deployment allows no **cross**-origin page. Card rule 5.
//
// **Its own origin is the one exception, and it is not a widening of the allowlist —
// it is the observation that CORS is a cross-origin rule.** See resolveOrigin. This
// is what #57 was: nothing in the one-click deploy flow can put a row in `settings`,
// so a deployment whose only answer came from that row refused every comment from the
// moment it went live, and the documented escape hatch ran through a D1-scoped API
// token the intended audience does not have.
// Enforced by test/worker/cors.test.ts and test/worker/read/route.test.ts.

import { readSetting } from './db'
import { fragmentHeaders } from './response-headers'

/** The `settings` key holding the owner's allowlist. */
export const ALLOWED_ORIGINS_SETTING = 'allowed_origins'

/**
 * The longest allowlist value this will read. A value past this is not something a
 * site owner typed into a settings box, and matching against it would be unbounded
 * work on the hot path of a public endpoint — so it is treated as unconfigured
 * rather than parsed. Card rule 5: size caps everywhere, fail closed.
 */
export const MAX_ALLOWED_ORIGINS_LENGTH = 2048

/**
 * The most origins one deployment will hold. One site is one apex, usually a www,
 * a staging host and a dev port; twenty is far past that and bounds the per-request
 * comparison at a constant.
 */
export const MAX_ALLOWED_ORIGINS = 20

/**
 * How long a browser may reuse a successful preflight. A day is the value most
 * browsers cap at anyway, and every reuse is one fewer OPTIONS request against the
 * free tier's 100,000 Worker requests/day — a preflight is a billable request like
 * any other.
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Max-Age
 */
export const PREFLIGHT_MAX_AGE_SECONDS = 86_400

/** The methods the public endpoints answer. OPTIONS is the preflight itself. */
const ALLOWED_METHODS = 'GET, POST, OPTIONS'

/**
 * The request headers the embed is permitted to set. `content-type` is the only one
 * it needs, and it is the reason the submission is preflighted at all. Listed
 * explicitly rather than reflecting Access-Control-Request-Headers back, which
 * would approve whatever was asked for and make the list decorative.
 */
const ALLOWED_HEADERS = 'content-type'

/**
 * One entry as an origin a browser could actually send, or null when it is not one.
 *
 * The canonicalisation every origin in this project passes through, in one function so
 * that the allowlist reader and the dashboard's settings write cannot disagree about
 * what `https://Maya.Build/` means. Scheme and host lowercased, a default port and any
 * path dropped — `URL.origin` is the canonical serialisation and is what a browser
 * puts in the `Origin` header.
 *
 * Non-http(s) schemes are refused because no browser sends one as a page origin, and
 * the literal `null` — what a sandboxed iframe, a `file://` page and some redirects
 * send — can never be admitted, whatever a settings row or an owner typed.
 * Enforced by test/worker/cors.test.ts.
 */
export function normaliseOrigin(entry: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(entry)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.hostname === '') return null

  // `URL.origin` is "null" for opaque origins, which the scheme check above already
  // excludes — the guard is here anyway because admitting that string once would allow
  // every sandboxed frame at once.
  if (parsed.origin === 'null') return null
  return parsed.origin
}

/**
 * Turns the stored settings value into the origins it names.
 *
 * Comma or whitespace separated, because a settings box invites one per line and a
 * README invites one line. Each entry goes through normaliseOrigin, which is also
 * what the dashboard's settings write uses — one canonicalisation, so a value the
 * owner saved is the value this reads back.
 *
 * A malformed entry is dropped rather than failing the whole list: one typo should
 * not take the site's real origin down with it. The dashboard, whose caller is the
 * owner and can be told, refuses the typo instead — see src/admin/settings.ts.
 * Enforced by test/worker/cors.test.ts.
 */
export function parseAllowedOrigins(value: string | null): string[] {
  if (value === null) return []
  if (value.length > MAX_ALLOWED_ORIGINS_LENGTH) return []

  const origins: string[] = []
  for (const entry of value.split(/[\s,]+/)) {
    if (entry === '') continue
    if (origins.length >= MAX_ALLOWED_ORIGINS) break

    const origin = normaliseOrigin(entry)
    if (origin !== null) origins.push(origin)
  }
  return origins
}

/**
 * The owner's allowlist, or none.
 *
 * One indexed read of a single-row primary-key lookup, and only on requests that
 * carry an `Origin` — see the caller. A deployment that has configured nothing gets
 * an empty list, which allows nothing.
 * Enforced by test/worker/cors.test.ts.
 */
export async function readAllowedOrigins(db: D1Database): Promise<string[]> {
  return parseAllowedOrigins(await readSetting(db, ALLOWED_ORIGINS_SETTING))
}

/**
 * The origin to echo back, or null when there is none to echo.
 *
 * Exact equality on the whole canonical origin, never a suffix or substring test:
 * `maya.build` is a suffix of `evilmaya.build` and a prefix of
 * `maya.build.evil.example`, and either test hands both of them the header. The
 * scheme and the port are part of the origin and are compared with it, so an
 * allowlisted `https://maya.build` does not admit `http://maya.build`.
 *
 * There is no wildcard, by construction. `*` is unnecessary on the read — the
 * comment HTML is public and anything that is not a browser can fetch it anyway —
 * and on the write it would let any page in any tab post into this deployment's
 * queue from a reader's browser. An owner with several origins lists them.
 * Enforced by test/worker/cors.test.ts.
 */
export function matchOrigin(
  requestOrigin: string | null,
  allowed: readonly string[],
): string | null {
  if (requestOrigin === null || requestOrigin === '' || requestOrigin === 'null') return null
  return allowed.includes(requestOrigin) ? requestOrigin : null
}

/**
 * The CORS headers for a response, given the origin that matched — or the headers
 * for a response that allows nobody, given null.
 *
 * `Vary: Origin` is emitted either way, including when nothing is allowed. The
 * response genuinely does depend on the request's `Origin`, and a cache that
 * learned otherwise from a refusal would serve that refusal to the allowed origin
 * next. There is deliberately no `Access-Control-Allow-Credentials`: card rule 8
 * means this project sets no reader-side cookie, so there is nothing for a
 * credentialed request to carry and no reason to widen the policy to permit one.
 * Enforced by test/worker/read/route.test.ts.
 */
export function corsHeaders(allowedOrigin: string | null): Record<string, string> {
  const headers: Record<string, string> = { vary: 'Origin' }
  if (allowedOrigin !== null) headers['access-control-allow-origin'] = allowedOrigin
  return headers
}

/**
 * The same response, carrying the CORS headers for the origin that matched.
 *
 * A new Response rather than a mutation, so a handler that built its own headers
 * keeps them and this function cannot silently drop one.
 */
export function withCors(response: Response, allowedOrigin: string | null): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(corsHeaders(allowedOrigin))) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * What the request's `Origin` was, and what may be echoed back for it.
 *
 * Both, because "no Origin at all" and "an Origin that is not listed" are different
 * situations that need different answers, and a single nullable string cannot tell
 * them apart. The first is a script or a build; the second is a browser on a page
 * the owner never authorised.
 */
export interface OriginDecision {
  /** The `Origin` header, or null when the request carried none — not a browser. */
  requestOrigin: string | null
  /** The origin to echo back, or null when there is nothing to echo. */
  allowedOrigin: string | null
}

/**
 * The origin this Worker is answering on, for this request, or null if that cannot be
 * parsed.
 *
 * Taken from `request.url`, which Cloudflare builds from the request line and the Host
 * the edge resolved — **never from a header a caller chose**, which is the whole reason
 * it can be compared against `Origin` at all. src/admin/csrf.ts asks the same question
 * for the dashboard's CSRF check and takes its answer from here, so there is one
 * definition of "this deployment" rather than two that can drift.
 * Enforced by test/worker/cors.test.ts and test/worker/admin/csrf.test.ts.
 */
export function selfOrigin(request: Request): string | null {
  return normaliseOrigin(request.url)
}

/**
 * Resolves the inbound request's origin against this deployment's own origin and then
 * the owner's allowlist.
 *
 * A request with no `Origin` header skips the settings read entirely: it is not a
 * cross-origin browser request, so no header this file emits would change what it
 * sees, and the v1.1 build-time renderer should not pay a D1 read for a policy that
 * cannot apply to it.
 *
 * **A same-origin request is allowed with no settings row and no write, and that is
 * #57's fix.** Three things make it the correct default rather than a permissive one:
 *
 *   - **It is not what CORS refuses.** The harm this file exists to stop is *another*
 *     site's page posting into this deployment's queue from a reader's browser. A page
 *     whose origin is this Worker's is a page this Worker served, and there are only
 *     two: `/` and `/admin`. Every other HTML this project emits carries
 *     `Content-Security-Policy: … sandbox`, which forces the document into an opaque
 *     origin, so a browser navigated to `GET /comments` is not on this origin at all
 *     (src/response-headers.ts). Neither of the two documents can run injected script:
 *     `/admin` is `script-src 'self'` with no inline and no nonce, and `/` is
 *     `default-src 'none'` with no script directive at all.
 *   - **It cannot be widened by anybody.** `selfOrigin` reads `request.url`, so the
 *     comparison is "did this request's own address match its own `Origin`" — a
 *     browser sets both from the same URL and a page cannot set either. Reaching this
 *     Worker under a hostname the owner did not route to it is not something an
 *     attacker can arrange: Cloudflare refuses a cross-account CNAME outright (Error
 *     1014, https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1014,
 *     checked 2026-07-25).
 *   - **It is per-request and remembers nothing**, which is why it is derived here
 *     rather than seeded into `settings` on first contact. A stored seed taken from the
 *     same header would be the strictly worse trade: if the hostname were ever wrong
 *     once, a comparison forgets it and a row hands it to every request afterwards.
 *     It also keeps the read path free of writes (#20) — the write budget is 100k/day
 *     against 5M reads, so a write reachable from a read lets traffic exhaust the
 *     day's comments.
 *
 * The same-origin answer comes before the allowlist read, so it costs no D1 query. The
 * owner's list is still the whole of the cross-origin policy: the seed makes a fresh
 * deployment work, and the setting is what makes it work for their site.
 * Enforced by test/worker/cors.test.ts.
 */
export async function resolveOrigin(db: D1Database, request: Request): Promise<OriginDecision> {
  const requestOrigin = request.headers.get('origin')
  if (requestOrigin === null) return { requestOrigin: null, allowedOrigin: null }

  // Through matchOrigin rather than a bare `===`, so the empty and literal-"null"
  // origins are refused by the same guard that refuses them against a real list.
  const self = selfOrigin(request)
  const sameOrigin = self === null ? null : matchOrigin(requestOrigin, [self])
  if (sameOrigin !== null) return { requestOrigin, allowedOrigin: sameOrigin }

  return {
    requestOrigin,
    allowedOrigin: matchOrigin(requestOrigin, await readAllowedOrigins(db)),
  }
}

/**
 * Whether this is a browser on a page the owner has not authorised.
 *
 * True only when an `Origin` arrived and did not match. A request with no `Origin`
 * is not a browser page and is not this check's business — refusing it would block
 * curl, the importer and the v1.1 build-time renderer while stopping no attack,
 * since anything that can omit the header was never subject to CORS in the first
 * place.
 * Enforced by test/worker/read/route.test.ts.
 */
export function isUnlistedBrowserOrigin(decision: OriginDecision): boolean {
  return decision.requestOrigin !== null && decision.allowedOrigin === null
}

/**
 * What a refusal says, and why it says this much.
 *
 * The audience for both strings is the site owner: the response carries no
 * allow-origin header, so the page that was refused cannot read the body, and the
 * person looking at a 403 during setup is the person who deployed it. #57 found out
 * what the old one-sentence version cost — the owner went looking for an allowlist,
 * found Turnstile's **Hostname Management** screen, added four hostnames to it, and had
 * no way to tell they were in the wrong product. Two allowlists, both Cloudflare
 * adjacent, both about hostnames, and only one of them discoverable in a dashboard.
 *
 * So it names the surface, names the setting, and rules out the wrong one by name. It
 * discloses nothing: `/admin` is a fixed path in this repository, and a caller learns
 * only that the origin it already knows is not listed.
 * Enforced by test/worker/cors.test.ts.
 */
const WHERE_THE_LIST_LIVES =
  'Site owner: add it to Allowed origins in your Charcha dashboard at /admin. ' +
  'That is a Charcha setting, not Turnstile’s hostname list.'

/**
 * The refusal for a write from an unlisted browser origin.
 *
 * Plain text and a 403, matching the preflight's refusal and the route house style.
 * It carries no allow-origin header, so the page that sent it cannot read this
 * message either — it is for the site owner reading logs or driving curl, which is
 * the only audience that can act on it.
 *
 * It carries the #98 headers too, which is that issue's open question answered:
 * uniformity is the cheaper rule, and `nosniff` is not decorative on a plain-text
 * body — it is what stops a browser inferring HTML out of one.
 * Enforced by test/worker/response-headers.test.ts and test/worker/cors.test.ts.
 */
export function unlistedOriginResponse(): Response {
  return new Response(
    `That origin is not allowed to comment on this site. ${WHERE_THE_LIST_LIVES}`,
    {
      status: 403,
      headers: {
        ...corsHeaders(null),
        ...fragmentHeaders(),
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  )
}

/**
 * The preflight answer for `OPTIONS` on a public endpoint.
 *
 * An allowed origin gets 204 and the permissions; anyone else gets a 403 carrying
 * no CORS headers at all, which is what makes the browser refuse to send the real
 * request. The 403 is deliberate rather than a silent 204-with-nothing: to a
 * browser the two are identical, and to the site owner debugging their embed with
 * curl the status code is the difference between a diagnosis and a mystery. It
 * discloses nothing — the allowlist is the owner's own site, and a caller learns
 * only whether the origin it already knows is listed.
 * Enforced by test/worker/read/route.test.ts.
 */
export function preflightResponse(allowedOrigin: string | null): Response {
  if (allowedOrigin === null) {
    return new Response(
      `That origin is not allowed to use this Charcha deployment. ${WHERE_THE_LIST_LIVES}`,
      {
        status: 403,
        headers: {
          ...corsHeaders(null),
          ...fragmentHeaders(),
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    )
  }

  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(allowedOrigin),
      ...fragmentHeaders(),
      'access-control-allow-methods': ALLOWED_METHODS,
      'access-control-allow-headers': ALLOWED_HEADERS,
      'access-control-max-age': String(PREFLIGHT_MAX_AGE_SECONDS),
    },
  })
}
