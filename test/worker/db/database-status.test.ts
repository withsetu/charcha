// The migration check written for the status readout on `/` (#140), and the reason it
// is not `select 1`. That readout is gone — #145 took it off a public address — and
// #141 gave the check to `/health` instead. These tests cover the three answers at the
// helper; test/worker/health.test.ts covers what the endpoint makes of them, and both
// are needed: the words could be right here and mapped wrong there.

import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { databaseStatus } from '../../../src/db'

const db = env.DB

/** A binding that resolves to nothing a query can be run against. */
const brokenDb = {
  prepare() {
    return {
      first() {
        return Promise.reject(new Error('D1_ERROR: no such database'))
      },
    }
  },
} as unknown as D1Database

describe('what a deployment can tell about its own database', () => {
  it('is ready once the migrations have been applied', async () => {
    expect(await databaseStatus(db)).toBe('ready')
  })

  it('is unmigrated when the database exists but Charcha’s tables do not', async () => {
    // The state Cloudflare's deploy button leaves behind before the repository's own
    // `deploy` script migrates — and the state a deploy is left in when that step
    // fails, which it does with no useful output when the build token cannot reach D1
    // (workers-sdk#5077). A `select 1` liveness check passes here, which is why this
    // one asks for a table.
    const empty = await env.TEST_EMPTY_DB.prepare('select 1').first()
    expect(empty).not.toBeNull()

    expect(await databaseStatus(env.TEST_EMPTY_DB)).toBe('unmigrated')
  })

  it('is unreachable when D1 refuses the query outright', async () => {
    expect(await databaseStatus(brokenDb)).toBe('unreachable')
  })

  // `/health` is public and unauthenticated, so its cost is a stranger's to spend
  // repeatedly, and the whole file header's argument for replacing `select 1` assumes
  // the replacement costs the same. One statement, and the count does not move with how
  // much is in the database. See the note at the route in src/index.ts.
  it('costs one statement, the same as the `select 1` it replaced', async () => {
    const prepare = vi.spyOn(env.DB, 'prepare')

    await databaseStatus(env.DB)

    expect(prepare).toHaveBeenCalledTimes(1)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
