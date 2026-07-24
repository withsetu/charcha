import { Hono } from 'hono'
import { handleSubmit } from './submit/route'
import { allowAllSpamCheck } from './submit/spam'

const app = new Hono<{ Bindings: Env }>()

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

export default app
