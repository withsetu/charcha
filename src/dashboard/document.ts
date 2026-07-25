// The dashboard's HTML document, and the security headers it is served with.
//
// A string and a header record, never a `Response`. This module is the one file under
// src/dashboard that is read by the Worker rather than by the browser, so it is in
// both TypeScript projects at once — and `Response` means the Cloudflare shape in one
// and the DOM shape in the other. Handing back the parts and letting src/index.ts
// build the response keeps this file honest in both.
//
// **The document is served by the Worker while the bundle and stylesheet are static
// assets, and the split is deliberate.** The assets are free and unbilled
// (wrangler.jsonc), which is why embed.js is served that way too. The document is not,
// because it is the only place the headers below can be set: a `_headers` rule applies
// to static assets and the shell needs a Content-Security-Policy that is worth more
// than the one Worker request per dashboard load it costs — the owner, once.
//
// Enforced by test/worker/dashboard/document.test.ts.

/** Where `pnpm build:dashboard` writes the two assets this document loads. */
const BUNDLE = '/admin/app.js'
const STYLESHEET = '/admin/app.css'

/**
 * The Content-Security-Policy for the dashboard document.
 *
 * This is the one surface in Charcha where an XSS lands on an authenticated session
 * that can delete every comment on the site, so the policy starts from `'none'` and
 * names what is allowed:
 *
 *   - `script-src 'self'` with **no** `unsafe-inline` and no nonce. There is no
 *     inline script in the document and no bootstrap JSON: the app calls
 *     `GET /admin/api/session` for itself (src/dashboard/index.tsx). That is what
 *     makes the strictest form of this directive available at all, and it is why the
 *     document carries no server-rendered state.
 *   - `style-src 'self' 'unsafe-inline'`. Radix sets inline `style` attributes for
 *     the dialog's scroll lock, and the undo bar passes its duration as a custom
 *     property. `unsafe-inline` on styles cannot execute script; dropping it would
 *     mean either forking the registry components or a nonce the stylesheet cannot
 *     use.
 *   - `connect-src 'self'`. The only fetches are to `/admin/api`. An injected
 *     exfiltration attempt has nowhere to send anything.
 *   - `img-src 'self'`. Comment bodies cannot contain images — `renderMarkdown` has
 *     no image rule and its vocabulary is asserted — so this only has to cover the
 *     favicon request a browser makes on its own.
 *   - `form-action 'none'`. The sign-in form is handled in JavaScript and never
 *     submits; with this, a browser *refuses* a submission rather than navigating,
 *     so an injected `<form>` cannot post the password anywhere.
 *   - `frame-ancestors 'none'` and `base-uri 'none'`. No framing, and no injected
 *     `<base>` able to repoint every relative URL on the page — including the ones
 *     the API client uses to stay same-origin.
 *
 * Enforced by test/worker/dashboard/document.test.ts.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * The headers the dashboard document is served with.
 *
 * `no-store` matches every response src/admin/api.ts produces, and for the same
 * reason: this document is the entry to one owner's private view of unpublished
 * comments. `noindex` is here as well as in the document's own meta tag because a
 * crawler that reads headers and not markup is the one this has to stop — a
 * moderation dashboard in a search index is a list of every deployment running one.
 */
export const DASHBOARD_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow',
}

/**
 * The shell.
 *
 * Static from end to end: nothing from a request, a database or a person reaches it —
 * the only two interpolations are the asset paths declared at the top of this file.
 * That is the property that makes it safe to write as a template literal on a surface
 * where everything else is treated as untrusted. If a future version needs to pass the
 * client a value, it goes in a `data-` attribute escaped by src/render's `escapeHtml`
 * — never into a `<script>`, which is the one context escaping HTML does not make
 * safe.
 *
 * `color-scheme: light dark` is what makes the browser's own chrome — form controls,
 * scrollbars, the canvas before the stylesheet lands — follow the OS alongside the
 * stylesheet's tokens. Without it a dark-mode dashboard flashes white on every load.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>Moderation · Charcha</title>
<link rel="stylesheet" href="${STYLESHEET}">
</head>
<body>
<div id="charcha-dashboard"></div>
<noscript>The moderation dashboard needs JavaScript. The comments on your site do not — readers see them either way.</noscript>
<script type="module" src="${BUNDLE}"></script>
</body>
</html>
`
