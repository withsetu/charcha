import { Hono } from 'hono'
import { getIpHashRetentionDays, purgeExpiredIpHashes } from './db'
import { handleSubmit } from './submit/route'
import { allowAllSpamCheck } from './submit/spam'

// Exported so tests can register throwaway routes on the same instance the Worker
// serves — the default export's `fetch` is this app's. See test/worker/errors.test.ts.
export const app = new Hono<{ Bindings: Env }>()

// The public, unauthenticated write endpoint — the primary surface, and the one
// card rule 5 is about. Validation, size caps and the spam seam all live behind
// handleSubmit; the spam layers themselves (#8) replace allowAllSpamCheck without
// touching this line. Enforced by test/worker/submit/route.test.ts.
app.post('/comments', (c) => handleSubmit(c, { spamCheck: allowAllSpamCheck }))

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
