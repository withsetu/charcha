import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

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
