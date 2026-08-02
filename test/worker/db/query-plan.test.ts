import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  COMMENTER_TRUST_SQL,
  MAX_PAGE_COMMENTS,
  MODERATE_SQL,
  MODERATION_QUEUE_PAGE_SQL,
  MODERATION_QUEUE_SQL,
  PAGE_COMMENTS_SQL,
  PURGE_IP_HASH_SQL,
  REPLY_TARGET_SQL,
  STATUS_COUNTS_SQL,
  settingsBatchSql,
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

describe('the per-status counts', () => {
  // **The one read in this file whose plan is allowed to say SCAN, and the comment is
  // here because `not.toMatch(/\bSCAN\b/)` is the idiom everywhere else.** An exact
  // count of a status cannot seek: every row of that status is part of the answer. So
  // the guarantee `comments_by_status` buys is a different one, and it is the whole
  // reason this statement is grouped rather than three counts — the scan is over index
  // entries and never over the table.

  it('counts from the index alone, never touching a comment row', async () => {
    const plan = await planOf(STATUS_COUNTS_SQL)

    // COVERING is the load-bearing word. Without it SQLite would seek back into
    // `comments` for each entry, and every one of those rows carries up to 10,000
    // characters of body — a tab strip's three numbers would then cost a full read of
    // the table, on every queue load and every decision.
    expect(plan).toMatch(/USING COVERING INDEX comments_by_status/)
  })

  it('groups in the index’s own order rather than buffering the table', async () => {
    const plan = await planOf(STATUS_COUNTS_SQL)

    // comments_by_status leads on `status`, so the groups arrive already adjacent and
    // the count is a running total. A temp B-tree would mean SQLite collecting every
    // row of the table in memory first to sort it into groups — inside a 128 MB isolate,
    // on the busiest site on the account.
    expect(plan).not.toMatch(/USE TEMP B-TREE FOR GROUP BY/)
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

  // #133 added `status <> ?2` to the cascade branch, and it had to not cost the seek
  // above: the two arms of the OR are separately indexed, so the extra predicate is a
  // filter on rows the index has already narrowed to one parent's replies rather than
  // a reason to look at the whole table. The plan is unchanged — asserted here rather
  // than assumed, because a predicate that defeats MULTI-INDEX OR would turn a
  // bounded write into a full scan on the busiest thread on the site, silently.
  it('still seeks both arms of the OR separately with the status filter on it', async () => {
    const plan = await planOf(MODERATE_SQL, 1, 'spam', 1_753_300_000)

    expect(plan).toMatch(/MULTI-INDEX OR/)
    expect(plan).toMatch(/USING INTEGER PRIMARY KEY/)
  })

  // The `status <> ?2` narrowing that keeps the reported count honest is asserted on
  // behaviour instead, in test/worker/db/comments.test.ts — a regex over this constant
  // would be the statement's source compared with a copy of itself, which cannot fail
  // for any reason except a rewording.

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

describe('the trust lookup', () => {
  const TRUST_BINDINGS = ['rahul@kanwar.example', 'a-hash-of-an-address'] as const

  // This runs on the public write endpoint, on a comment nothing objected to, and its
  // answer decides whether that comment is published without a human seeing it. What it
  // must not do is read a comment row: a regular with four hundred approved comments
  // would then cost four hundred row reads per submission — each carrying up to 10,000
  // characters of body into a 128 MB isolate — on a path an attacker inflates by
  // commenting.
  it('answers out of comments_by_commenter without reading a comment row', async () => {
    const plan = await planOf(COMMENTER_TRUST_SQL, ...TRUST_BINDINGS)

    // **Both halves, and the index by name, because `not.toMatch(/SCAN/)` alone is a
    // kill-shot that passes.** Drop `comments_by_commenter` and SQLite falls back to
    // `comments_by_ip (ip_hash=?)` — still a seek, still no SCAN in the plan, and one
    // row read for every comment ever posted from that address. COVERING is what says
    // the answer came from index entries; the name is what says it came from the right
    // index.
    expect(plan).toMatch(/USING COVERING INDEX comments_by_commenter/)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })

  it('constrains the email and the address together, not one and then a filter', async () => {
    // The identity is both columns (#173). A seek on one of them with the other applied
    // as a filter would read every comment sharing an address — which is every comment
    // from one NAT — to answer a question about one person.
    const plan = await planOf(COMMENTER_TRUST_SQL, ...TRUST_BINDINGS)

    expect(plan).toMatch(/author_email=\? AND ip_hash=\?/)
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

describe('the batched settings read', () => {
  // On the public submission path (#207), where every settings row this project has
  // is read in one statement. `settings.key` is the primary key, so `in (…)` is a run
  // of seeks — a scan here would grow with however many settings a deployment has
  // accumulated, on the request a spammer chooses the rate of.
  it('seeks the primary key rather than scanning the settings table', async () => {
    const plan = await planOf(settingsBatchSql(3), 'a', 'b', 'c')

    expect(plan).not.toMatch(/\bSCAN\b/)
  })
})
