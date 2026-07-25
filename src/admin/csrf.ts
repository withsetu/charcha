// The second CSRF layer. `SameSite=Strict` on the session cookie is the first, and
// on its own it is very nearly enough — this exists because "very nearly" is the
// wrong standard for the endpoint that can delete every comment on the site.
//
// Two independent layers, because each covers what the other cannot:
//
//   - SameSite=Strict is the only defence that covers a cross-site GET. A browser
//     omits `Origin` on same-origin GET and HEAD requests
//     (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin,
//     checked 2026-07-25), so an Origin check cannot tell a cross-site GET from an
//     ordinary navigation and must not try.
//   - An Origin check is what still holds if SameSite does not: an old browser, a
//     policy that a future browser change relaxes, or a same-site-but-not-same-origin
//     page — SameSite is a *site* rule (registrable domain), so a sibling subdomain
//     is same-site and a different origin. On a workers.dev deployment that sibling
//     is another tenant's Worker.
//
// The shape mirrors isUnlistedBrowserOrigin in src/cors.ts rather than inventing a
// second policy: "an Origin arrived and it is not one we accept" is the same
// question there and here, and an absent Origin means the same thing in both — not
// a browser page.
// Enforced by test/worker/admin/csrf.test.ts.

/**
 * Whether this state-changing request came from a page that is not this Worker.
 *
 * True only when an `Origin` header arrived and did not equal this request's own
 * origin. Absent `Origin` is allowed, and that is the same call src/cors.ts makes
 * for the same reason: a browser always sends `Origin` on POST, PUT, PATCH, DELETE
 * and OPTIONS, so a state-changing request without one is curl, a script or the
 * importer — none of which is subject to CSRF, because none of them has an
 * ambient cookie to be ridden. Refusing them would break the site owner debugging
 * their own deployment and stop no attack.
 *
 * The comparison is on the whole canonical origin, never a prefix or suffix: this
 * Worker's own origin is taken from `request.url`, which Cloudflare sets from the
 * request line and the Host header the edge resolved, and `URL.origin` is the
 * canonical serialisation of both sides.
 * Enforced by test/worker/admin/csrf.test.ts.
 */
export function isCrossOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (origin === null) return false

  // The literal "null" — a sandboxed iframe, a `file://` page, a cross-origin
  // redirect — is never this origin, and is exactly the case a suffix comparison
  // would get wrong. Handled by the equality below, and named here because
  // admitting it once would admit every sandboxed frame at once.
  return origin !== new URL(request.url).origin
}
