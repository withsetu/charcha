import { Hono } from 'hono'
import { getIpHashRetentionDays, purgeExpiredIpHashes } from './db'
import { preflightResponse, resolveOrigin, withCors } from './cors'
import { handleRead } from './read/route'
import { handleSubmit } from './submit/route'
import { allowAllSpamCheck } from './submit/spam'

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
// handleSubmit; the spam layers themselves (#8) replace allowAllSpamCheck without
// touching this line. Enforced by test/worker/submit/route.test.ts.
app.post('/comments', async (c) => {
  const allowedOrigin = await resolveOrigin(c.env.DB, c.req.raw)
  const response = await handleSubmit(c, {
    spamCheck: allowAllSpamCheck,
    significantParams: SIGNIFICANT_PARAMS,
  })
  return withCors(response, allowedOrigin)
})

// The public read endpoint: the embed's `fetch`, and the other end of #4's one
// renderer. Returns HTML, never JSON (#1).
// Enforced by test/worker/read/route.test.ts.
app.get('/comments', (c) => handleRead(c, { significantParams: SIGNIFICANT_PARAMS }))

// The preflight. POST /comments takes application/json, which is not a
// CORS-safelisted content type, so every cross-origin submission from the embed is
// preflighted — which makes this handler the gate that decides whether another
// site's page may post into this deployment's queue from a reader's browser (#47).
// Enforced by test/worker/read/route.test.ts.
app.options('/comments', async (c) => preflightResponse(await resolveOrigin(c.env.DB, c.req.raw)))

// Liveness for the site owner and for deploy verification: it answers only if the
// Worker is running *and* its D1 binding resolves to a database that will answer a
// query. Enforced by test/worker/health.test.ts.
app.get('/health', async (c) => {
  try {
    await c.env.DB.prepare('select 1').first()
  } catch (error) {
    console.error('health: D1 query failed', error)
    return c.json({ status: 'degraded', database: 'error' }, 503, { 'cache-control': 'no-store' })
  }

  return c.json({ status: 'ok', database: 'ok' }, 200, { 'cache-control': 'no-store' })
})

app.notFound((c) => c.text('Not found', 404))

// Never surface an internal message to a caller — this Worker's main surface is
// public and unauthenticated. Enforced by test/worker/errors.test.ts.
app.onError((error, c) => {
  console.error('unhandled error', error)
  return c.text('Internal error', 500)
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
