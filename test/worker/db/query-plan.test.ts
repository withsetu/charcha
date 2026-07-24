import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { PAGE_COMMENTS_SQL } from '../../../src/db'

const db = env.DB

/**
 * The index is not a performance nicety here, it is the free tier. A page read
 * that scans grows with the whole database rather than with the page, so one
 * busy blog burns the 5M row reads/day allowance and every site on the account
 * stops working.
 *
 * This asserts the plan of the statement the data layer actually sends —
 * PAGE_COMMENTS_SQL is the same constant, not a copy — because a query plan test
 * against a hand-written copy passes happily while production scans.
 */
async function planOf(sql: string, ...bindings: unknown[]): Promise<string> {
  const { results } = await db
    .prepare(`explain query plan ${sql}`)
    .bind(...bindings)
    .all<{ detail: string }>()
  return results.map((row) => row.detail).join('\n')
}

describe('the page read', () => {
  it('seeks on an index rather than scanning the comments table', async () => {
    const plan = await planOf(PAGE_COMMENTS_SQL, '/hello')

    expect(plan).not.toMatch(/\bSCAN\b/)
    expect(plan).toMatch(/comments_by_thread/)
  })

  it('resolves the page without scanning threads either', async () => {
    const plan = await planOf(PAGE_COMMENTS_SQL, '/hello')

    expect(plan).toMatch(/SEARCH t/)
  })
})
