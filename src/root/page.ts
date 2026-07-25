// The page at `/`, and the headers it is served with. Designed on #140, cut back on #145.
//
// **What it is for.** Cloudflare's deploy-success screen hands the deployer their
// Worker URL, and the single most likely thing anyone does next is click it. Until
// this existed that produced `Not found`, so the first sentence Charcha said to its
// owner was that the deploy had failed — on a deployment where `/health`, `/comments`,
// `/admin` and `/embed.js` were all answering correctly. That is the whole job: say
// the Worker is up, to whoever is looking.
//
// **Why it is a constant and not a report.** The first version answered a second
// question too — is this deployment healthy, and what should I do next — with the
// database's migration state, the embed snippet carrying this deployment's origin, the
// address of the dashboard, and the news that allowed origins may still be unset. Every
// one of those is useful to the owner and useful to a stranger, and this address is
// unauthenticated: a scanner sweeping `workers.dev` could learn from one GET that a
// host runs Charcha, that it is half-broken, and where its login is. #140 said the page
// must not leak and listed comment counts and configuration; an operational readout is
// the same class of disclosure and was simply not on the list. #145 removed it. The
// deployer gets all of it from the README instead, which is not published per
// deployment.
//
// So the page is a string with nothing interpolated into it. That is a stronger
// property than escaping an origin correctly, which is what the previous version had
// to do: there is no value here to get wrong, and no binding to read.
// Enforced by test/worker/root/page.test.ts.
//
// **It runs no script.** `ROOT_PAGE_HEADERS` sets `default-src 'none'` with no script
// directive, and src/cors.ts leans on that: a same-origin request is accepted without
// an allowlist entry, so a document this project serves on its own origin must not be
// able to execute anything injected into it. Adding a script directive here would
// widen that grant. See resolveOrigin for what the claim does and does not cover — it
// is about this project's own responses, not about every page that might share the
// origin on a path-scoped route.
// Enforced by test/worker/root/page.test.ts.

/**
 * The stylesheet, and it is the largest thing on this page — which is the correct
 * shape for a page with a heading and three paragraphs on it.
 *
 * Inline because the CSP is `default-src 'none'`, and hand-written because the
 * dashboard's built stylesheet is 43 KB of Tailwind. The tokens are the handful this
 * needs from src/dashboard/styles.css — the same neutral scale, the same OS-driven
 * dark mode — so the two owner-facing surfaces read as one product. They are
 * **intended** to stay in step with that file; nothing asserts it, because a shade of
 * grey drifting is not a defect worth a filesystem test.
 *
 * `prefers-color-scheme` and nothing else: choosing a theme would need somewhere to
 * remember it, and this project sets no cookie (card rule 8).
 */
const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #fff;
  --fg: #252525;
  --muted: #6b6b6b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #252525;
    --fg: #fafafa;
    --muted: #b4b4b4;
  }
}
body {
  margin: 0;
  padding: 4rem 1.5rem;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-text-size-adjust: 100%;
}
main { max-width: 32rem; margin: 0 auto; }
h1 {
  margin: 0 0 0.5rem;
  font-size: 1.75rem;
  line-height: 1.2;
  letter-spacing: -0.02em;
}
p { margin: 0 0 1rem; }
.lede { color: var(--muted); }
.foot { margin: 2.5rem 0 0; color: var(--muted); font-size: 0.875rem; }
a { color: inherit; }
a:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
`.trim()

/**
 * The page. Four lines: that this is a live Charcha, what Charcha is, where to read
 * more, and why there is nothing else here.
 *
 * **`noindex, nofollow` is deliberate and should stay**, and the reasons are not the
 * usual ones:
 *
 * - A `workers.dev` subdomain nobody links to carries essentially no ranking signal,
 *   so indexing would buy charcha.dev close to nothing anyway.
 * - Every deployment of this repository serves this identical page with this identical
 *   outbound link. Google's spam policies name "widely distributed links in the footers
 *   or templates of various sites" and "links embedded in widgets that are distributed
 *   across various sites" as link spam
 *   (https://developers.google.com/search/docs/essentials/spam-policies, checked
 *   2026-07-25). Charcha is literally a widget distributed across various sites. The
 *   penalty for that pattern would land on charcha.dev, not on the deployments.
 * - Indexed deployments would be enumerable through search, which lowers the cost of
 *   mass-scanning for Charcha instances.
 *
 * The link therefore carries **no `rel="nofollow"` of its own, and that is not an
 * oversight**: page-level `nofollow` means "do not follow the links on this page", so
 * a per-link repeat would be redundant
 * (https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag,
 * checked 2026-07-25). It carries `noopener noreferrer` instead, which the meta tag
 * does not cover — those are about the opened tab and the referrer header, not about
 * crawling.
 *
 * The copy is a claim about what Charcha does, and every clause of it is a property
 * this repository actually has. Clause by clause, because a marketing sentence is the
 * easiest place in a codebase for something untrue to survive: *runs in your own
 * Cloudflare account* — the deploy button deploys to the owner's account and nothing
 * phones home; *asks your readers for no account* — a name and an optional email, no
 * sign-up and no social login; *sets no cookie* — card rule 8, and nothing in src/
 * touches `document.cookie` or any browser storage. Deliberately **not** "on your own
 * domain": a one-click deployment lives on `workers.dev` until its owner puts it
 * somewhere else.
 *
 * No numbers, no names, no testimonials — there are none, and a page shipped to
 * strangers is the worst possible place to invent one.
 */
export const ROOT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>Charcha</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1>Charcha is running</h1>
<p class="lede">Self-hosted comments for static sites.</p>
<p>A comment section for a blog or a website that runs in your own Cloudflare account,
asks your readers for no account and sets no cookie &mdash; read more at
<a href="https://charcha.dev" rel="noopener noreferrer">charcha.dev</a>.</p>
<p class="foot">Anyone with this address can see this page, so it says nothing about this
deployment.</p>
</main>
</body>
</html>
`

/**
 * The headers.
 *
 * `noindex, nofollow` is a header as well as a meta tag because a crawler that reads
 * headers and not markup is the one this has to stop — the same pair of signals the
 * dashboard shell sends. See ROOT_PAGE for why the directive is wanted here at all.
 *
 * `referrer-policy: no-referrer` is doing real work now that the page has an outbound
 * link: this deployment's own address is the only thing the page still knows, and the
 * referrer header is the only way following that link could carry it to charcha.dev.
 *
 * The policy names no script directive at all, so `default-src 'none'` governs scripts
 * too. `style-src 'unsafe-inline'` is the one permission granted, for the `<style>`
 * block above; inline style cannot execute. See the file header for why the absence of
 * script here is load-bearing for src/cors.ts.
 * Enforced by test/worker/root/page.test.ts.
 */
export const ROOT_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow',
}
