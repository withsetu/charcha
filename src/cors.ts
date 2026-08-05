// The origin policy for the public endpoints. Designed on issue #47.
//
// The embed runs on the site owner's own domain and calls this Worker on another,
// so without CORS response headers the reader's browser discards every answer and
// the widget cannot load or submit at all. What the headers say is owner
// configuration rather than a constant, so the allowlist lives in `settings`.
//
// **What this is, and what it is not.** CORS is a browser rule, not a server-side
// authorisation check: anything that is not a browser — curl, a script, the v1.1
// build-time renderer — sends no `Origin` and ignores every header in this file. So the
// allowlist is a misuse guard rather than a security boundary; the defence against a
// script is #8's spam layers and the moderation queue. What this does stop is another
// site's *page* posting into this deployment's queue from a reader's browser, which is the
// case a reader cannot see and did not consent to.
//
// **Since #224 the settings this file reads are also matched against something a script
// cannot opt out of**: the address a submission *reports*. `submittedUrlRefusal` below is
// that check, and it is the one that holds for a caller with no `Origin` header at all —
// the gap that made `threads.page_url` attacker-chosen. The two are complementary and
// neither replaces the other: one asks which page posted, the other which site the comment
// claims to be on, and a request can pass either while failing the other.
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
 * One indexed read of a single-row primary-key lookup. A deployment that has configured
 * nothing gets an empty list, which allows nothing.
 *
 * **Not what the request paths read any more.** Since #224 the allowlist is one half of
 * what the owner has declared — the site address is the other — and both halves are read
 * together, in one statement, by `readDeclaredOrigins` in src/settings.ts. This remains
 * because the dashboard's write path is about the allowlist alone and its tests read back
 * exactly the row they wrote.
 * Enforced by test/worker/cors.test.ts.
 */
export async function readAllowedOrigins(db: D1Database): Promise<string[]> {
  return parseAllowedOrigins(await readSetting(db, ALLOWED_ORIGINS_SETTING))
}

/**
 * The same declaration spelled the other way: `https://www.maya.build` for
 * `https://maya.build`, and back again. Null when there is no other spelling.
 *
 * **One label, added or removed, and nothing else.** A site is reachable at its apex and
 * at www, an owner types one of them, and being refused on the other is #57 by another
 * door — so the pair is treated as one declaration at match time rather than by rewriting
 * what the owner stored, which the Setup tab still shows them verbatim.
 *
 * **It is not a subdomain rule, and the asymmetry is deliberate.** Declaring
 * `https://maya.build` admits `https://www.maya.build` and nothing else; it does not admit
 * `https://blog.maya.build`, because that is a wildcard and `matchOrigin` refuses
 * wildcards for a stated reason. Going the other way is the same single label:
 * `https://blog.maya.build` gets `https://www.blog.maya.build`, never `https://maya.build`,
 * so no host ever matches something *shorter* than what a label-stripping rule would
 * produce from it.
 *
 * The scheme and the port ride along untouched, so a declared `https://maya.build` still
 * does not admit `http://www.maya.build`.
 * Enforced by test/worker/cors.test.ts.
 */
export function wwwSibling(origin: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return null
  }
  if (parsed.origin === 'null') return null

  const host = parsed.hostname
  if (host.startsWith('www.')) {
    const apex = host.slice(4)
    // `www.` alone would leave nothing behind, and an empty host is not a declaration.
    if (apex === '' || apex === 'www.') return null
    parsed.hostname = apex
  } else {
    if (host === '' || host === 'www') return null
    parsed.hostname = `www.${host}`
  }

  // **The assignment above is a silent no-op for a host the parser will not accept**, and
  // an IP literal is exactly that: `www.` cannot be prefixed to `127.0.0.1` (a trailing
  // numeric label is refused) or to `[::1]` (brackets are not a label), so `parsed` comes
  // back unchanged and this would answer with its own input. Returning the input as
  // somebody's "other spelling" would make one origin match itself twice through a
  // function whose contract is that there *is* a second spelling. There is no second
  // spelling of an address, so: null.
  // Enforced by test/worker/cors.test.ts.
  const sibling = normaliseOrigin(parsed.origin)
  return sibling === origin ? null : sibling
}

/**
 * The origin to accept, or null — the owner's declarations, with www and the apex
 * counted as one (#224).
 *
 * The answer is the origin **as it was given**, never the sibling that matched it: this is
 * echoed into `Access-Control-Allow-Origin`, which a browser compares against the origin it
 * sent, so answering with the other spelling would refuse the request it just allowed.
 *
 * `matchOrigin` does both comparisons, so the empty and literal-`null` origins are refused
 * by the same guard on both, and there is still exactly one place that decides what
 * "listed" means.
 *
 * **The canonical-form check is what keeps the two comparisons the same comparison.**
 * `matchOrigin` compares the given string against a canonicalised list, so it refuses
 * `https://WWW.MAYA.BUILD` and `https://www.maya.build:443` outright — while `wwwSibling`
 * re-parses, which *canonicalises*, so without this guard the sibling path would admit
 * spellings the exact path had just refused. A browser only ever sends the canonical form,
 * so nothing legitimate is turned away; what is refused is a hand-made header, on the one
 * branch that would otherwise have been laxer than the rule above it.
 * Enforced by test/worker/cors.test.ts.
 */
export function matchDeclaredOrigin(
  requestOrigin: string | null,
  declared: readonly string[],
): string | null {
  const exact = matchOrigin(requestOrigin, declared)
  if (exact !== null) return exact
  if (requestOrigin === null) return null
  if (normaliseOrigin(requestOrigin) !== requestOrigin) return null

  const sibling = wwwSibling(requestOrigin)
  if (sibling === null) return null
  return matchOrigin(sibling, declared) === null ? null : requestOrigin
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
 *     whose origin is this Worker's is a page the *owner* is responsible for. Of the
 *     documents this project itself serves there are exactly two, `/` and `/admin`, and
 *     neither can run injected script: `/admin` is `script-src 'self'` with no inline
 *     and no nonce, and `/` is `default-src 'none'` with no script directive at all
 *     (test/worker/root/page.test.ts and test/worker/dashboard/document.test.ts assert
 *     both). Every other HTML this project emits carries
 *     `Content-Security-Policy: … sandbox`, which forces the document into an opaque
 *     origin, so a browser navigated to `GET /comments` is not on this origin at all
 *     (src/response-headers.ts).
 *
 *     **That is a claim about this project's own responses and not about the origin.**
 *     On `*.workers.dev` or a Custom Domain the Worker owns the whole origin and the two
 *     coincide. On a *path-scoped* Worker Route — `example.com/comments*`, with the
 *     owner's site on the same host — they do not: `selfOrigin` is then
 *     `https://example.com`, and every page of that site is same-origin. The trust is
 *     still not misplaced, because that is the owner's own site and it is the origin they
 *     would list here anyway; but the ceiling is "an XSS on the owner's own pages could
 *     post a comment", which is a thing such an XSS could already do by driving the
 *     embed's form. Worth knowing before anyone reads the two-document sentence as a
 *     property of the origin. Found by review, not by a test — nothing here can detect
 *     the deployment's routing shape.
 *   - **It cannot be widened by a *page*.** `selfOrigin` reads `request.url`, so the
 *     comparison is "did this request's own address match its own `Origin`" — a browser
 *     sets both from the same URL, `Origin` is a forbidden header name and `Host` is one
 *     too, so no page can set either. That is the whole of what this check needs, because
 *     both of its consumers are browser-only: anything that is not a browser omits
 *     `Origin` and was never subject to CORS.
 *
 *     Reaching this Worker under a hostname the owner never routed to it would need a
 *     route in the owner's own Cloudflare zone, and Cloudflare separately refuses a
 *     cross-account CNAME by default (Error 1014,
 *     https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1014,
 *     checked 2026-07-25 — that page is about cross-account CNAMEs specifically, and is
 *     cited for that and not as a statement about `request.url`).
 *   - **It is per-request and remembers nothing**, which is why it is derived here
 *     rather than seeded into `settings` on first contact. A stored seed taken from the
 *     same header would be the strictly worse trade: if the hostname were ever wrong
 *     once, a comparison forgets it and a row hands it to every request afterwards.
 *     It also keeps the read path free of writes (#20) — the write budget is 100k/day
 *     against 5M reads, so a write reachable from a read lets traffic exhaust the
 *     day's comments.
 *
 * The same-origin answer comes before the declared-origins read, so it costs no D1 query.
 * What the owner declared is still the whole of the cross-origin policy: the seed makes a
 * fresh deployment work, and the settings are what make it work for their site.
 *
 * **`readDeclared` is injected rather than imported, and that is a module-graph fact
 * rather than a seam anybody replaces.** Since #224 the declaration is two rows — the
 * allowlist and the site address — and the site address's key is owned by src/settings.ts,
 * which already imports this file. Importing it back would be a cycle whose module-scope
 * constants read each other before either is initialised. So the caller passes the reader
 * (`readDeclaredOrigins`) already bound to this request's bindings, the read stays lazy, and
 * a request with no `Origin` still pays for nothing. The binding is not a parameter here for
 * the same reason: this function has no use for a database except to hand it to that reader.
 *
 * **The site address is in that list on purpose.** The dashboard's loud notice names
 * exactly one action — set your site's address — and if setting it did not also let that
 * site's pages through CORS, the notice would be telling an owner to do something that
 * does not work.
 * Enforced by test/worker/cors.test.ts.
 */
export async function resolveOrigin(
  request: Request,
  readDeclared: () => Promise<readonly string[]>,
): Promise<OriginDecision> {
  const requestOrigin = request.headers.get('origin')
  if (requestOrigin === null) return { requestOrigin: null, allowedOrigin: null }

  // Through matchOrigin rather than a bare `===`, so the empty and literal-"null"
  // origins are refused by the same guard that refuses them against a real list. Exact,
  // not `matchDeclaredOrigin`: the argument for this branch is that the request's own
  // address matched its own `Origin`, and an equality argument does not survive being
  // widened to a second host nobody routed here.
  const self = selfOrigin(request)
  const sameOrigin = self === null ? null : matchOrigin(requestOrigin, [self])
  if (sameOrigin !== null) return { requestOrigin, allowedOrigin: sameOrigin }

  return {
    requestOrigin,
    allowedOrigin: matchDeclaredOrigin(requestOrigin, await readDeclared()),
  }
}

/**
 * What the owner has said is theirs, for one request.
 *
 * Two sources, because they are two different acts: `declared` is what they typed into the
 * dashboard (the allowlist and the site address, resolved by src/settings.ts), and `self`
 * is this deployment's own address, which is theirs by derivation and was never typed
 * anywhere (#57).
 */
export interface DeclaredOrigins {
  /** The `allowed_origins` and `site_url` settings, as origins. Empty means none. */
  declared: readonly string[]
  /** This deployment's own origin, or null when `request.url` will not normalise. */
  self: string | null
}

/**
 * Why the submitted `url` was refused, or null when it was not (#224).
 *
 * **This is the check `allowed_origins` was always read as making and never made.** CORS
 * binds browsers only: `resolveOrigin` returns early on a missing `Origin` header, so a
 * request that simply omits it — curl, a script, anything that is not a browser — used to
 * reach the write with `url` unexamined. `derivePageKey` drops the origin from the thread
 * key, so such a comment landed on the legitimate thread for that path while
 * `threads.page_url` kept whatever address it claimed, and every consumer of that column
 * had to work around it.
 *
 * **Fail closed, including when nothing is declared.** A deployment that has declared no
 * addresses accepts no comments for any address but its own. That is card rule 5 rather
 * than #57 repeated: #57 was a deployment that refused everything and *explained nothing*,
 * and what makes this safe is the notice the Setup tab carries while it is true
 * (src/dashboard/components/setup/sections/declared.tsx).
 *
 * **Three reasons rather than a boolean**, because the log has to separate a
 * misconfiguration from an attack — a deployment nobody has configured yet, an address
 * that is not one of the owner's, and a submission with no address at all. The *reader*
 * is told none of it: see `undeclaredUrlResponse`.
 * Enforced by test/worker/cors.test.ts and test/worker/submit/declared-origin.test.ts.
 */
export type SubmittedUrlRefusal = 'no-url' | 'nothing-declared' | 'undeclared-origin'

export function submittedUrlRefusal(
  pageUrl: string | null,
  origins: DeclaredOrigins,
): SubmittedUrlRefusal | null {
  // Checked first, and separately: "the owner declared nothing" is a fact about the
  // deployment, and it must not be reported for a submission that carried no address to
  // check in the first place.
  if (pageUrl === null) return 'no-url'

  const { declared, self } = origins
  const origin = normaliseOrigin(pageUrl)

  // **The www rule applies to what the owner declared, and `self` is matched exactly.**
  // `resolveOrigin` makes the argument for this deployment's own origin and it is an
  // equality argument — "the request's own address matched its own address" — which does
  // not survive being widened to a second host nobody routed here. Two comparisons rather
  // than one list, so this file cannot say one thing about `self` in one function and the
  // other thing two functions down.
  if (matchOrigin(origin, self === null ? [] : [self]) !== null) return null
  if (matchDeclaredOrigin(origin, declared) !== null) return null

  return declared.length === 0 ? 'nothing-declared' : 'undeclared-origin'
}

/**
 * Whether this is a browser on a page the owner has not authorised.
 *
 * True only when an `Origin` arrived and did not match. A request with no `Origin`
 * is not a browser page and is not this check's business — refusing it would block
 * curl, the importer and the v1.1 build-time renderer while stopping no attack,
 * since anything that can omit the header was never subject to CORS in the first
 * place.
 *
 * **That is still true, and it is no longer the whole story.** What such a caller is held
 * to instead is `submittedUrlRefusal`: it may omit the header, and it may not claim to be
 * on an address the owner never declared. An importer and a build-time renderer both carry
 * URLs from the owner's own site, so both land inside that rule rather than needing an
 * exemption from it — a Disqus export of a domain the owner has since left is the case to
 * think about when #15 is built, and the answer there is a declaration, not a bypass.
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
 * The refusal for a comment whose reported address is not one the owner declared (#224).
 *
 * **One answer for all three reasons, and that is the deliberate part.** Which check fired
 * — nothing declared, the wrong address, no address at all — goes to the log, where the
 * audience is the site owner. Putting it in the body would report this deployment's
 * configuration state to anyone willing to post a comment, which is the readout #145 took
 * off `/` for the same reason.
 *
 * It names the site address rather than the allowlist, because that is the one action the
 * dashboard's notice names too and the one that also lets a browser on that site through
 * `resolveOrigin`. The allowlist is named second for an owner who has one.
 *
 * A message rather than a `Response`, unlike the two refusals above it: this one is
 * returned by the submission pipeline, which owns no HTTP, and src/submit/route.ts maps
 * the outcome onto the 403 and the #98 headers that every other answer on that path gets.
 * Enforced by test/worker/cors.test.ts and test/worker/submit/declared-origin.test.ts.
 */
export const UNDECLARED_URL_MESSAGE =
  'This site is not accepting comments from that address. ' +
  'Site owner: set your site’s address on the Setup tab of your Charcha dashboard at ' +
  '/admin, or add the address to Allowed origins. That is a Charcha setting, not ' +
  'Turnstile’s hostname list.'

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
