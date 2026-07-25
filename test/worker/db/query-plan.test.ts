import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  MAX_PAGE_COMMENTS,
  MODERATE_SQL,
  MODERATION_QUEUE_PAGE_SQL,
  MODERATION_QUEUE_SQL,
  PAGE_COMMENTS_SQL,
  PURGE_IP_HASH_SQL,
  REPLY_TARGET_SQL,
} from '../../../src/db'

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

const PAGE_BINDINGS = ['/hello', MAX_PAGE_COMMENTS + 1] as const

describe('the page read', () => {
  it('seeks on an index rather than scanning the comments table', async () => {
    const plan = await planOf(PAGE_COMMENTS_SQL, ...PAGE_BINDINGS)

    expect(plan).not.toMatch(/\bSCAN\b/)
    expect(plan).toMatch(/comments_by_thread/)
  })

  it('resolves the page without scanning threads either', async () => {
    const plan = await planOf(PAGE_COMMENTS_SQL, ...PAGE_BINDINGS)

    expect(plan).toMatch(/SEARCH t/)
  })

  it('takes the cap off the index rather than sorting the whole page first', async () => {
    // comments_by_thread is (thread_id, status, created_at, id), which is exactly
    // this statement's `order by`, so the limit stops the read at the cap. A whole
    // clause sort would mean every approved comment on the page is read *before*
    // the limit applies — the cap in #27 would then bound what comes back and
    // nothing about the memory or the row reads it cost, which is the whole point.
    const plan = await planOf(PAGE_COMMENTS_SQL, ...PAGE_BINDINGS)

    expect(plan).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/)
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

describe('the moderation queue read, past the first page', () => {
  // The whole argument for a keyset cursor over `offset N` (#33) is that the
  // deepest page should not be the most expensive one. That property lives
  // entirely in this plan: if the cursor is a filter rather than a seek, page
  // forty reads every row of the status before returning twenty, and the paging
  // costs more than the `offset` it replaced. This is the plan a long queue
  // actually spends its row reads on, and it is why MODERATION_QUEUE_PAGE_SQL is
  // a second statement rather than a null-guarded disjunct in the first.
  const PAGE_BINDINGS = ['pending', 50, 1_753_300_000, 4_000] as const

  it('seeks the status on an index rather than scanning the comments table', async () => {
    const plan = await planOf(MODERATION_QUEUE_PAGE_SQL, ...PAGE_BINDINGS)

    expect(plan).toMatch(/SEARCH c USING INDEX comments_by_status/)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })

  it('resolves each comment thread without scanning threads either', async () => {
    const plan = await planOf(MODERATION_QUEUE_PAGE_SQL, ...PAGE_BINDINGS)

    expect(plan).toMatch(/SEARCH t USING INTEGER PRIMARY KEY/)
  })

  it('starts at the cursor rather than reading up to it', async () => {
    const plan = await planOf(MODERATION_QUEUE_PAGE_SQL, ...PAGE_BINDINGS)

    // Two constrained columns, not one: the seek uses `status = ?` *and* the
    // `created_at` half of the row-value comparison. One column would mean the
    // whole status is read and the cursor filtered afterwards, which is the
    // failure mode this statement exists to avoid.
    expect(plan).toMatch(/comments_by_status \(status=\? AND created_at<\?\)/)
  })

  it('takes the newest rows from the index rather than sorting the whole status', async () => {
    const plan = await planOf(MODERATION_QUEUE_PAGE_SQL, ...PAGE_BINDINGS)

    expect(plan).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/)
  })
})

describe('the parent-eligibility read', () => {
  // This runs on the submission path, which is the public write endpoint, and it
  // runs before any write. A scan here would let anyone make the busiest thread on
  // the site read every comment in the database by sending a reply with a made-up
  // parentId — cheap for them, and paid for out of the account's 5M rows/day.
  it('seeks the primary key rather than scanning the comments table', async () => {
    const plan = await planOf(REPLY_TARGET_SQL, 1, 1)

    expect(plan).toMatch(/USING INTEGER PRIMARY KEY/)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })
})

describe('the moderation write', () => {
  // The `or (parent_id = ?1 ...)` clause makes this statement's result set as large
  // as the number of replies under the comment, and nothing caps replies per parent
  // — the depth guard caps nesting, not fan-out. So two properties matter here, and
  // a review found the second one unasserted.

  it('finds the replies on an index rather than scanning the comments table', async () => {
    const plan = await planOf(MODERATE_SQL, 1, 'spam', 1_753_300_000)

    expect(plan).toMatch(/comments_by_parent/)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })

  it('never returns a comment body, however many replies it cascades over', () => {
    // Selecting `body` would pull up to 10,000 characters per reply into a 128 MB
    // isolate on the way to discarding all but one row, so hiding one popular
    // comment would be an unbounded read — on a path a spammer can inflate by
    // replying to their own comment. The decision needs the ids and the status.
    expect(MODERATE_SQL).not.toMatch(/\bbody\b/)
    expect(MODERATE_SQL).not.toMatch(/author_name/)
    expect(MODERATE_SQL).not.toMatch(/author_email/)
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
