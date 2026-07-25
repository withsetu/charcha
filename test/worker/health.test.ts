// The contract of `GET /health` (#141), and the state it exists to catch.
//
// Until #141 it ran `select 1`, which an empty database answers perfectly — so the
// one failure a Deploy-to-Cloudflare build actually produces, a database Cloudflare
// created and the repository's `deploy` script never migrated, was reported as
// `{"status":"ok","database":"ok"}`. The tests below pin the three answers apart.

import { env, exports } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'

const origin = 'https://charcha.example'

// Restoring inside the test body only runs when the test passes, so a failing
// assertion would leave the mocked database in place for everything after it.
afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /health', () => {
  it('reports the Worker and its D1 binding as healthy', async () => {
    const response = await exports.default.fetch(`${origin}/health`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', database: 'ok' })
  })

  it('is not cached, so it reflects the state of this request', async () => {
    const response = await exports.default.fetch(`${origin}/health`)

    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  // The reason this endpoint changed. `TEST_EMPTY_DB` is a real D1 database with no
  // migrations applied — exactly what the deploy button provisions — and the point
  // of the assertion is the *word*: a monitor that only learned "degraded" here
  // would still not know the fix is to run the migrations.
  it('distinguishes a database that was never migrated, which `select 1` cannot', async () => {
    const unmigrated = env.TEST_EMPTY_DB
    // Proof the fixture is the state being claimed rather than a broken binding:
    // the old check's own query succeeds against it.
    expect(await unmigrated.prepare('select 1').first()).not.toBeNull()
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => unmigrated.prepare(sql))

    const response = await exports.default.fetch(`${origin}/health`)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'degraded', database: 'unmigrated' })
  })

  it('reports a database it cannot reach as a different failure again', async () => {
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error('D1_ERROR: no such database')
    })

    const response = await exports.default.fetch(`${origin}/health`)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'degraded', database: 'unreachable' })
  })

  it('never answers 200 on a database that is not ready', async () => {
    // The whole of the bug, stated once: whatever the words are, a deployment that
    // cannot serve a comment must not be green to a script that only reads the code.
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => env.TEST_EMPTY_DB.prepare(sql))

    expect((await exports.default.fetch(`${origin}/health`)).status).not.toBe(200)
  })
})

describe('an unknown route', () => {
  it('is a 404, and says so in plain text', async () => {
    const response = await exports.default.fetch(`${origin}/no-such-route`)

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not found')
  })
})
