// The headers that stop a public response being treated as a document. Designed on
// issue #98.
//
// Three public responses put attacker-influenced HTML on this Worker's own origin:
// `GET /comments`, which is navigable by URL because it is a GET with query
// parameters; `POST /comments`, which echoes the reader's own comment back; and
// `POST /comments/preview`, which is POST-only but which a cross-site
// `<form enctype="text/plain">` still navigates a victim's browser to. Every one of
// them is meant to be `fetch`ed by the embed and injected into the *host* page, and
// never to be a document here.
//
// **This is a second lock, not a fix for an open one.** The renderer is
// escape-then-build (src/render/markdown.ts) and test/worker/render/vocabulary.test.ts
// asserts nothing outside the declared element list can reach the page whatever the
// input. There is no known payload that executes. That is precisely the situation in
// which the second lock is cheap, and in which shipping without one is a decision
// rather than an oversight.
//
// It is applied across all three endpoints at once, deliberately: a header on one of
// three siblings reads as protection while the larger door stands open.
// Enforced by test/worker/response-headers.test.ts.

/**
 * The policy every public response carries, and what each half of it does.
 *
 * `sandbox` with no tokens is the whole sandboxing flag set. It "is used to populate
 * the CSP-derived sandboxing flags"
 * (https://w3c.github.io/webappsec-csp/#directive-sandbox), and those flags include
 * the sandboxed origin browsing context flag — "This flag forces content into an
 * opaque origin, thus preventing it from accessing other content from the same
 * origin" (https://html.spec.whatwg.org/multipage/browsers.html#sandboxing) — and
 * the sandboxed scripts flag, which blocks script execution outright. So a browser
 * navigated straight to one of these endpoints does not get a document on this
 * Worker's origin at all; it gets an inert one on an opaque origin. That is the
 * exact harm #98 names, removed rather than mitigated.
 *
 * `default-src 'none'` is the belt: no fetch directive resolves, so that document
 * can load no script, style, image, frame or connection of any kind.
 *
 * **And it costs the embed nothing, which is the half that had to be checked rather
 * than assumed.** The CSP-derived sandboxing flags are read only when a document or
 * a worker is created — CSP initialization runs inside "create and initialize a new
 * `Document` object" and "run a worker" (same spec section) — and a `fetch` does
 * neither. A response's own CSP never governs a string handed to `innerHTML`
 * somewhere else; on the host page the host's policy governs, and it always did.
 * Verified 2026-07-25.
 * Enforced by test/worker/response-headers.test.ts.
 */
export const FRAGMENT_CSP = "default-src 'none'; sandbox"

/**
 * `nosniff`, which is doing separate work from the CSP above rather than repeating
 * it.
 *
 * It "blocks a request if the request destination is of type `style` and the MIME
 * type is not `text/css`, or of type `script` and the MIME type is not a JavaScript
 * MIME type"
 * (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Content-Type-Options,
 * verified 2026-07-25). Without it, another site's `<script src>` pointed at
 * `GET /comments` is a way to have a browser execute comment text as JavaScript on
 * *that* site's origin, which no CSP on this response can prevent — the policy that
 * applies there is the other page's.
 *
 * The same header also fixes the plain-text refusals in place: a 400 or a 403 body
 * is served `text/plain`, and this is what stops a browser inferring HTML out of one.
 */
const NOSNIFF = 'nosniff'

/**
 * The header pair, as a spreadable object for a response being built from scratch.
 *
 * Shaped like `corsHeaders` in src/cors.ts so the two compose the same way at a call
 * site that already spreads one of them.
 */
export function fragmentHeaders(): Record<string, string> {
  return {
    'content-security-policy': FRAGMENT_CSP,
    'x-content-type-options': NOSNIFF,
  }
}

/**
 * The same response, carrying the header pair.
 *
 * A new Response rather than a mutation, matching `withCors`: a handler that built
 * its own headers — the read's cache policy, the preview's `no-store` — keeps every
 * one of them, and this function cannot silently drop one.
 * Enforced by test/worker/response-headers.test.ts.
 */
export function withFragmentHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(fragmentHeaders())) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
