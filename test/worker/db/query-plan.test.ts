import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { MODERATION_QUEUE_SQL, PAGE_COMMENTS_SQL, PURGE_IP_HASH_SQL } from '../../../src/db'

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

describe('the moderation queue read', () => {
  // The clamp bounds the rows *returned*; only the index bounds the rows *read*.
  // Without comments_by_status a queue of ten pending comments still reads every
  // approved comment in the database to find them, so the cheapest page in the
  // dashboard grows with the busiest site on the account.
  it('seeks the status on an index rather than scanning the comments table', async () => {
    const plan = await planOf(MODERATION_QUEUE_SQL, 'pending', 50)

    expect(plan).toMatch(/SEARCH c USING INDEX comments_by_status/)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })

  it('resolves each comment thread without scanning threads either', async () => {
    const plan = await planOf(MODERATION_QUEUE_SQL, 'pending', 50)

    expect(plan).toMatch(/SEARCH t USING INTEGER PRIMARY KEY/)
  })

  it('takes the newest rows from the index rather than sorting the whole status', async () => {
    const plan = await planOf(MODERATION_QUEUE_SQL, 'pending', 50)

    // comments_by_status is (status, created_at DESC), so `created_at desc` is the
    // index's own order and the limit stops the read early. SQLite still sorts the
    // `id desc` tiebreak — "LAST TERM OF ORDER BY" — which only ever buffers rows
    // sharing one timestamp. A whole-clause sort is the failure this rules out: it
    // would mean every row of that status is read before the limit is applied, so
    // the clamp would bound what comes back and nothing about what it cost.
    expect(plan).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/)
  })
})

describe('the ip_hash purge', () => {
  // comments_by_ip is partial — `WHERE ip_hash IS NOT NULL` — so the purge seeks it
  // and never sees a row it has already nulled. That is what makes the retention
  // sweep cost grow with the retention window rather than with the whole table: a
  // full scan would re-read every already-purged comment on the busiest account
  // every day. #19 depends on this index, not merely on the query being correct.
  it('seeks the partial ip index rather than scanning the comments table', async () => {
    const plan = await planOf(PURGE_IP_HASH_SQL, 1000)

    expect(plan).toMatch(/USING INDEX comments_by_ip/)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })
})
