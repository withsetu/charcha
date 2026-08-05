import { Hono } from 'hono'
import type { Context } from 'hono'
import { adminError, notFound as adminNotFound } from './admin/api'
import {
  ADMIN_API_PREFIX,
  COMMENT_STATUS_PATH,
  QUEUE_PATH,
  SESSION_PATH,
  handleCommentStatus,
  handleLogin,
  handleLogout,
  handleQueue,
  handleSession,
} from './admin/route'
import { SETTINGS_PATH, handleReadSettings, handleWriteSettings } from './admin/settings'
import { SETUP_PATH, handleReadSetup } from './admin/setup'
import { DASHBOARD_HEADERS, DASHBOARD_HTML } from './dashboard/document'
import { databaseStatus, getIpHashRetentionDays, purgeExpiredIpHashes } from './db'
import {
  isUnlistedBrowserOrigin,
  preflightResponse,
  resolveOrigin,
  unlistedOriginResponse,
  withCors,
} from './cors'
import { PREVIEW_PATH, handlePreview } from './preview/route'
import { handleRead } from './read/route'
import { ROOT_PAGE, ROOT_PAGE_HEADERS } from './root/page'
import { readDeclaredOrigins, readSiteSettings } from './settings'
import { createSpamCheck } from './spam'
import { handleSubmit } from './submit/route'

// Exported so tests can register throwaway routes on the same instance the Worker
// serves — the default export's `fetch` is this app's. See test/worker/errors.test.ts.
export const app = new Hono<{ Bindings: Env }>()

/**
 * Query parameters that are page identity on this site, for both halves of the
 * embed's contract.
 *
 * One constant, passed to the read and to the write, because the two must derive
 * the same key from the same URL — a mismatch would have a reader post to one
 * thread and then be shown another, with every test on either side still passing.
 * Empty by default so no tracking parameter can fork a thread; it becomes owner
 * configuration when the settings surface exists (#6). See src/page-key.ts.
 */
const SIGNIFICANT_PARAMS: readonly string[] = []

// The public, unauthenticated write endpoint — the primary surface, and the one
// card rule 5 is about. Validation, size caps and the spam seam all live behind
// handleSubmit; the layers themselves are src/spam (#8, #10, #11), assembled per
// request because their configuration is four optional secrets on `env`.
// Enforced by test/worker/submit/route.test.ts and test/worker/spam/route.test.ts.
app.post('/comments', async (c) => {
  // Checked on the real request, not only at the preflight. `text/plain` makes this
  // POST a CORS-simple request that no browser preflights, so a policy enforced only
  // at OPTIONS is one an attacker opts out of with a header. See src/cors.ts.
  const decision = await resolveOrigin(c.env.DB, c.req.raw, (db) => readDeclaredOrigins(db, c.env))
  if (isUnlistedBrowserOrigin(decision)) return unlistedOriginResponse()

  // **Every `settings` row this request needs, in one statement (#207).** Layer 8's site
  // URL, the notifier's two addresses and its display name, and the moderation policy are
  // all rows now, and reading them one at a time would be five seeks where there is one —
  // on the path CLAUDE.md's constant-query-count rule is about.
  //
  // **The allowlist is in that read since #224, where it used to be deliberately left
  // out.** The old argument was that it is resolved above, before the request is accepted
  // at all. That is still true of the *browser* check — and it is exactly the half a
  // request with no `Origin` header skips, which is the hole #224 closes. The submitted
  // `url` has to be checked against what the owner declared whether or not a browser sent
  // anything, so this path needs the row unconditionally, and a key added to a batched
  // read costs nothing. `GET /comments` is untouched: it reads the two declared-origin
  // rows on its own (`readDeclaredOrigins`) and never the notification settings.
  //
  // So a submission still spends at most two settings statements, and it is the same two
  // however many settings this project grows.
  // Enforced by test/worker/notify/route-wiring.test.ts, which posts a real comment at
  // this route and pins both the statement count and the fact that exactly one of them
  // reads `settings`, and by test/worker/submit/trust.test.ts for the same two properties
  // per moderation policy.
  const settings = await readSiteSettings(c.env.DB, c.env)

  const response = await handleSubmit(c, {
    spamCheck: createSpamCheck({
      // Built as a literal rather than spread from `c.env`, following the house rule in
      // src/spam/provider.ts: a binding added to `Env` must not reach the spam layers
      // because somebody widened a spread.
      TURNSTILE_SECRET_KEY: c.env.TURNSTILE_SECRET_KEY,
      IP_HASH_SECRET: c.env.IP_HASH_SECRET,
      AKISMET_API_KEY: c.env.AKISMET_API_KEY,
      AI: c.env.AI,
      siteUrl: settings.siteUrl,
    }),
    settings,
    significantParams: SIGNIFICANT_PARAMS,
  })
  return withCors(response, decision.allowedOrigin)
})

// The public read endpoint: the embed's `fetch`, and the other end of #4's one
// renderer. Returns HTML, never JSON (#1).
// Enforced by test/worker/read/route.test.ts.
app.get('/comments', (c) => handleRead(c, { significantParams: SIGNIFICANT_PARAMS }))

// The preflight (#47). The embed sends application/json, which is not a
// CORS-safelisted content type, so the embed's own submissions are preflighted and
// this is what lets them through. It is **not** the gate — an attacker sends
// text/plain and is never preflighted at all — which is why the POST handler above
// checks the origin on the real request. See src/cors.ts.
// Enforced by test/worker/read/route.test.ts.
app.options('/comments', async (c) => {
  const decision = await resolveOrigin(c.env.DB, c.req.raw, (db) => readDeclaredOrigins(db, c.env))
  return preflightResponse(decision.allowedOrigin)
})

// The composer's Preview tab (#78): Markdown in, the published comment's own HTML
// out, writing nothing. POST because it carries a body, and POST-only because a
// previewer reachable by a URL would put attacker-chosen HTML on this Worker's
// origin behind a link. Its preflight is registered too — the embed's plain-text
// body is never preflighted, but a browser that asks must not meet a 404.
// Enforced by test/worker/preview/route.test.ts.
app.post(PREVIEW_PATH, (c) => handlePreview(c))
app.options(PREVIEW_PATH, async (c) => {
  const decision = await resolveOrigin(c.env.DB, c.req.raw, (db) => readDeclaredOrigins(db, c.env))
  return preflightResponse(decision.allowedOrigin)
})

// The moderation dashboard's API (#12). Everything under /admin/api is the owner's
// authenticated surface, and it is the half of this Worker that lets a stored
// comment ever be judged — before these routes existed, setCommentStatus had no
// caller and Charcha was a one-way write.
//
// **No `app.options` here, and no CORS headers anywhere in src/admin.** That is the
// policy rather than an omission: there is no legitimate cross-origin caller for a
// moderation queue, so a preflight is answered with the 404 that stops a browser
// from ever sending the real request. The reader-facing routes above need CORS
// because the embed lives on another origin; the dashboard is served from this one.
//
// The session cookie these set is scoped `Path=/admin`, which is what keeps card
// rule 8 true: the browser never attaches it to the /comments requests registered
// above. See src/admin/session.ts.
// Enforced by test/worker/admin/route.test.ts and test/worker/admin/cookie-scope.test.ts.
app.post(SESSION_PATH, (c) => handleLogin(c))
app.delete(SESSION_PATH, (c) => handleLogout(c))
app.get(SESSION_PATH, (c) => handleSession(c))
app.get(QUEUE_PATH, (c) => handleQueue(c))
app.post(COMMENT_STATUS_PATH, (c) => handleCommentStatus(c))

// The origin allowlist (#57). It is on this surface and not on a public one for the
// reason the whole file is: this setting decides which pages the public write endpoint
// trusts, so an allowlist a stranger could widen would be worse than no allowlist.
// Enforced by test/worker/admin/settings.test.ts.
app.get(SETTINGS_PATH, (c) => handleReadSettings(c))
app.put(SETTINGS_PATH, (c) => handleWriteSettings(c))

// What is and is not configured on this deployment (#158). Read-only and booleans only:
// a Worker cannot write its own secrets, so there is no PUT here to pair with the GET,
// and the Setup tab's instructions are the substitute for the save button that could not
// work. It sits on this surface for the same reason the allowlist does — an
// unauthenticated caller learning which defences are off is reconnaissance.
// Enforced by test/worker/admin/setup.test.ts.
app.get(SETUP_PATH, (c) => handleReadSetup(c))

// The dashboard itself (#13): the HTML shell the React app boots from.
//
// Two exact paths, and never `/admin/*`. Two separate things protect the API from
// this handler and only one of them is the order:
//
//   - Registration order. Hono matches in it, so the API routes above win even against
//     a wildcard here. A kill-shot confirmed that: swapping these for `/admin/*` leaves
//     `GET /admin/api/queue` answering JSON.
//   - The exact paths. What the wildcard *does* break is every other `/admin/...`
//     address: `/admin/nope` would answer the shell with a 200, so a typo'd URL —
//     including a mistyped API path from a future client — would look like a working
//     page rather than a 404. That is the failure the kill-shot found, and the reason
//     the two paths are written out.
//
// The bundle and the stylesheet are **not** here. They are static assets in
// public/admin, matched by the assets binding before the Worker is ever invoked, so
// loading the dashboard costs one Worker request rather than three. The document is
// served from the Worker because it is the only place its Content-Security-Policy can
// be set — see src/dashboard/document.ts, which owns both the markup and the headers.
// Enforced by test/worker/dashboard/document.test.ts.
const dashboardDocument = (c: Context<{ Bindings: Env }>) =>
  c.body(DASHBOARD_HTML, 200, DASHBOARD_HEADERS)

app.get('/admin', dashboardDocument)
app.get('/admin/', dashboardDocument)

// The address Cloudflare hands the deployer on the deploy-success screen (#140).
//
// Until this route existed, clicking that link answered `Not found` — so a healthy
// deployment's first words to its owner were that the deploy had failed. Saying the
// Worker is up is the whole of its job: it is public and unauthenticated, so it
// reports no database state, no comment count, no configuration and not even the
// address of the dashboard (#145). A constant, therefore, reading no binding and
// interpolating nothing from the request — see src/root/page.ts.
// Enforced by test/worker/root/page.test.ts.
app.get('/', (c) => c.body(ROOT_PAGE, 200, ROOT_PAGE_HEADERS))

// Liveness for the site owner and for deploy verification (#141).
//
// It used to run `select 1`, and that made it green on the one failure it existed to
// catch: Cloudflare's deploy button creates the D1 database and does not migrate it,
// an empty database answers `select 1` perfectly, and the next real query fails. So
// `/health` said `{"status":"ok","database":"ok"}` about a deployment that could not
// take a comment. It now asks `databaseStatus`, which reads one row of SQLite's own
// schema table — see src/db/index.ts. It is intended to stay one statement, as the old
// check was, so that the answer costs the same whatever the deployment's state; nothing
// asserts that here, and test/worker/db/database-status.test.ts is where it is counted.
//
// **What it proves is that migration 0001 ran, not that every migration did.** The
// table it looks for is `comments`, so a later migration that failed on its own is not
// caught — see #149. The doc claims in README and docs/ are worded to that.
//
// **The contract, decided on #141 rather than inherited from the helper:**
//
//   - `200 {"status":"ok","database":"ok"}` — unchanged, so the response every healthy
//     deployment returns, and anything already branching on it, is untouched.
//   - `503 {"status":"degraded","database":"unmigrated"}` — reachable, no schema. New:
//     nothing represented this before, so no meaning was taken away.
//   - `503 {"status":"degraded","database":"unreachable"}` — the binding refused the
//     query. This replaces `database: "error"`, which is gone. A third value had to
//     arrive either way, and `error` named a category while the other two name a
//     state; a consumer reading only the HTTP status — what a health check is for —
//     sees no change at all.
//
// **Saying `unmigrated` on a public, unauthenticated address is the deliberate part.**
// #145 took exactly this fact off `/`, and the two calls differ because the pages do:
// `/` is where a stranger following the deploy-success link lands, `/health` is what a
// deploy check and a monitor read on purpose. The fact is also cheap to infer without
// this — `GET /comments` fails on an unmigrated deployment, and that endpoint is public
// too — and it is the one word that turns "something is wrong" into "run the
// migrations". What this does add is a cheaper oracle than that, which is the cost of
// the endpoint being useful at all.
// Two fields, no configuration, no counts, nothing about the request.
// Enforced by test/worker/health.test.ts.
app.get('/health', async (c) => {
  const database = await databaseStatus(c.env.DB)

  return database === 'ready'
    ? c.json({ status: 'ok', database: 'ok' }, 200, { 'cache-control': 'no-store' })
    : c.json({ status: 'degraded', database }, 503, { 'cache-control': 'no-store' })
})

/**
 * Whether this request was for the dashboard's API, and so wants JSON.
 *
 * The two failures a dashboard client is most likely to meet are an unknown path and
 * a server error, and both are answered here rather than in any route — so without an
 * admin branch they were the only two admin responses *not* in the
 * `{error:{code,message}}` shape, and a client branching on `error.code` would throw
 * parsing them. Found by review. It is the same argument src/admin/api.ts makes for
 * re-answering the size guard's plain-text 413.
 * Enforced by test/worker/admin/route.test.ts and test/worker/admin/queue.test.ts.
 */
function wantsAdminJson(c: Context<{ Bindings: Env }>): boolean {
  return new URL(c.req.url).pathname.startsWith(ADMIN_API_PREFIX)
}

app.notFound((c) =>
  wantsAdminJson(c) ? adminNotFound('There is nothing at that address.') : c.text('Not found', 404),
)

// Never surface an internal message to a caller — this Worker's main surface is
// public and unauthenticated. Enforced by test/worker/errors.test.ts.
app.onError((error, c) => {
  console.error('unhandled error', error)
  return wantsAdminJson(c)
    ? adminError('UNAVAILABLE', 'Something went wrong. Try again.', 500)
    : c.text('Internal error', 500)
})

/**
 * The retention janitor. Runs on the Cron Trigger in wrangler.jsonc to null
 * `ip_hash` on comments past the configured window (#19).
 *
 * It reports what it did and re-throws on failure rather than swallowing it: a
 * purge that fails quietly leaves PII in the table indefinitely and invisibly, so a
 * silent failure here is a privacy incident, not a missed chore. Re-throwing marks
 * the Cron invocation failed, which is the signal the site owner sees.
 */
async function purgeIpHashes(env: Env, now: number): Promise<void> {
  try {
    const retentionDays = await getIpHashRetentionDays(env.DB)
    const { purged, cutoff } = await purgeExpiredIpHashes(env.DB, now, retentionDays)
    console.log(JSON.stringify({ event: 'ip_hash_purge', ok: true, purged, retentionDays, cutoff }))
  } catch (error) {
    console.error('ip_hash_purge failed', error)
    throw error
  }
}

// Hono owns `fetch`; the Cron handler rides alongside it in Module Worker mode.
// https://hono.dev/docs/getting-started/cloudflare-workers#scheduled
export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env) {
    // Awaited, not fire-and-forget: the invocation must stay alive until the purge
    // finishes and must fail if it does. `Date.now()` is the only clock the Worker
    // has here, so "now" is read once and handed to the pure data-layer query.
    await purgeIpHashes(env, Math.floor(Date.now() / 1000))
  },
} satisfies ExportedHandler<Env>
