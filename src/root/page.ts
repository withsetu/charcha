// The page at `/`, and the headers it is served with. Designed on issue #140.
//
// **What it is for.** Cloudflare's deploy-success screen hands the deployer their
// Worker URL, and the single most likely thing anyone does next is click it. Until
// this existed that produced `Not found`, so the first sentence Charcha said to its
// owner was that the deploy had failed — on a deployment where `/health`, `/comments`,
// `/admin` and `/embed.js` were all answering correctly. The 404 was not wrong about
// any route; it was wrong about the only question being asked.
//
// **What it must not become.** It is public and unauthenticated, so it carries the
// same restraint `/health` does: no comment count, no thread list, no page titles, and
// nothing about which secrets are set. "Turnstile: not configured" on a public page is
// a note to attackers about which defences are off, so no configuration is named at
// all — not even to say it is fine.
//
// **And it runs no script.** `ROOT_PAGE_HEADERS` sets `default-src 'none'` with no
// script directive, and src/cors.ts leans on that: a same-origin request is accepted
// without an allowlist entry, so a document this project serves on its own origin must
// not be able to execute anything injected into it. Adding a script directive here
// would widen that grant. See resolveOrigin for what the claim does and does not cover
// — it is about this project's own responses, not about every page that might share the
// origin on a path-scoped route.
// Enforced by test/worker/root/page.test.ts.
//
// A string and a header record, never a `Response` — the same split as
// src/dashboard/document.ts, so the render stays pure and testable and the route owns
// the HTTP.
//
// Enforced by test/worker/root/page.test.ts and test/node/embed-snippet.test.ts.

import type { DatabaseStatus } from '../db'
import { escapeHtml } from '../render'

/**
 * The integration snippet, with a deployment's own origin in it.
 *
 * **This function is the snippet's only definition, and test/node/embed-snippet.test.ts
 * asserts the README contains exactly what it returns.** #140 is explicit that a
 * snippet differing from the documented one is worse than showing none, and the README
 * cannot be imported — so the agreement is asserted rather than remembered.
 *
 * `id="charcha"` and the script's own `src` are the whole contract: src/embed/index.ts
 * mounts into `#charcha,[data-charcha]`, and src/embed/config.ts derives the API base
 * from `document.currentScript.src` when no `data-api` is given. Every other attribute
 * — `data-api`, `data-thread`, `data-styles`, `data-turnstile-sitekey` — is optional
 * and belongs in docs/theming.md rather than in the line a deployer pastes first.
 */
export function embedSnippet(origin: string): string {
  return `<div id="charcha"></div>\n<script src="${origin}/embed.js" defer></script>`
}

export interface RootPageState {
  /**
   * This deployment's own origin, or null when `request.url` did not parse as one.
   *
   * Null suppresses the snippet entirely rather than printing a broken one. It should
   * be unreachable on a routed Worker; it is a type rather than an assumption because
   * the alternative failure is a deployer copying a line that cannot work.
   */
  origin: string | null
  database: DatabaseStatus
}

/**
 * The one line on this page that can say something is wrong.
 *
 * Each state gets a sentence naming what to do about it, because the audience is
 * someone mid-deploy who has no other diagnostic to hand. `unmigrated` is the one that
 * actually happens — see databaseStatus in src/db.
 */
const DATABASE_LINES: Record<DatabaseStatus, { label: string; detail: string }> = {
  ready: {
    label: 'Database ready',
    detail: 'The schema is applied and this deployment can store comments.',
  },
  unmigrated: {
    label: 'Database needs its migration',
    detail:
      'The database exists but has no tables yet. Re-run the deploy, and read the ' +
      'migration step in the build log — it fails quietly when the build token cannot ' +
      'reach D1.',
  },
  unreachable: {
    label: 'Database could not be reached',
    detail: 'The D1 binding did not answer. Check the binding named DB on this Worker.',
  },
}

/**
 * The stylesheet, inline and roughly forty lines of it.
 *
 * Inline because the CSP is `default-src 'none'` and because the dashboard's built
 * stylesheet is 43 KB of Tailwind for a page with four elements on it. The tokens
 * restate the handful this needs from src/dashboard/styles.css — the same neutral
 * scale, the same radius, the same OS-driven dark mode — so the two owner-facing
 * surfaces read as one product. They are **intended** to stay in step with that file;
 * nothing asserts it, because a shade of grey drifting is not a defect worth a
 * filesystem test, and the snippet — which is — has one.
 *
 * `prefers-color-scheme` and nothing else, matching the dashboard: choosing a theme
 * would need somewhere to remember it, and this project sets no cookie (card rule 8).
 */
const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #fff;
  --fg: #252525;
  --muted: #6b6b6b;
  --line: #e5e5e5;
  --surface: #f7f7f7;
  --ok: #1f6b40;
  --warn: #8a3b12;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #252525;
    --fg: #fafafa;
    --muted: #b4b4b4;
    --line: #3d3d3d;
    --surface: #303030;
    --ok: #6fbf8d;
    --warn: #e5a06a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 4rem 1.5rem 6rem;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-text-size-adjust: 100%;
}
main { max-width: 40rem; margin: 0 auto; }
h1 {
  margin: 0 0 1.5rem;
  font-size: 1.75rem;
  line-height: 1.2;
  letter-spacing: -0.02em;
}
h2 {
  margin: 3rem 0 0.75rem;
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
p { margin: 0 0 0.75rem; }
.status {
  display: flex;
  gap: 0.625rem;
  padding: 0.875rem 1rem;
  border: 1px solid var(--line);
  border-radius: 0.625rem;
  background: var(--surface);
}
.dot {
  flex: none;
  width: 0.5rem;
  height: 0.5rem;
  margin-top: 0.5rem;
  border-radius: 50%;
  background: var(--ok);
}
.status[data-state="unmigrated"] .dot,
.status[data-state="unreachable"] .dot { background: var(--warn); }
.status b { display: block; font-weight: 600; }
.status span { color: var(--muted); font-size: 0.9375rem; }
pre {
  margin: 0;
  padding: 1rem;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 0.625rem;
  background: var(--surface);
  font: 0.875rem/1.7 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
ul { margin: 0; padding-left: 1.125rem; }
li { margin-bottom: 0.5rem; }
a { color: inherit; }
a:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.foot { margin-top: 3rem; color: var(--muted); font-size: 0.875rem; }
`.trim()

/**
 * The page.
 *
 * Three parts in the order the deployer needs them: whether it worked, the line they
 * would otherwise have to assemble by hand, and the two things left to do. No cards, no
 * icons, no metrics — there is one fact on this page that can vary and it gets the one
 * treatment that can change colour.
 *
 * The origin is escaped although it comes from `request.url` rather than from a person.
 * It is the only interpolation on the page, and escaping it is what makes that fact
 * uninteresting instead of something a future reader has to re-derive.
 */
export function renderRootPage(state: RootPageState): string {
  const database = DATABASE_LINES[state.database]
  const snippet =
    state.origin === null
      ? `<p>Add Charcha to a page with the snippet in the
        <a href="https://github.com/withsetu/charcha#adding-it-to-a-page">README</a>.</p>`
      : `<pre><code>${escapeHtml(embedSnippet(state.origin))}</code></pre>`

  return `<!doctype html>
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

<div class="status" data-state="${state.database}">
<span class="dot" aria-hidden="true"></span>
<span><b>${database.label}</b>${database.detail}</span>
</div>

<h2>Add it to your site</h2>
${snippet}

<h2>Then</h2>
<ul>
<li>Moderate comments at <a href="/admin">/admin</a>.</li>
<li>Add your site&rsquo;s address to <b>Allowed origins</b>, in the same dashboard. Until you
do, comments from it are refused &mdash; every deployment starts allowing only its own
address.</li>
</ul>

<p class="foot">This page is for whoever deployed this Worker. Readers never see it.</p>
</main>
</body>
</html>
`
}

/**
 * The headers.
 *
 * `noindex` is a header as well as a meta tag because a crawler that reads headers and
 * not markup is the one this has to stop — the same reasoning as the dashboard shell,
 * and the same pair of signals.
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
