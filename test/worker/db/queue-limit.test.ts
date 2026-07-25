import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_QUEUE_LIMIT,
  MAX_QUEUE_LIMIT,
  getOrCreateThread,
  listModerationQueue,
} from '../../../src/db'

const db = env.DB
const t0 = 1_753_300_000

// Rows read are the free tier's real budget: 5M/day across the whole account, and
// every row here carries a body of up to 10,000 characters against a 128 MB isolate.
// So the page size is a cap, not a preference, and it belongs to the data layer —
// a clamp in one dashboard handler protects that handler and nothing else.

let threadId: number

/**
 * Seeds `count` pending comments in one statement. The clamp cases need more rows
 * than the maximum page size, and a per-row insert would make this file the slowest
 * in the suite for no extra coverage — the read under test is what is being proved.
 */
async function seedPending(count: number) {
  await db
    .prepare(
      `insert into comments (
         thread_id, parent_id, depth, author_name, body, body_hash, status, by_owner, created_at
       )
       select ?1, null, 0, 'Commenter ' || value, 'comment ' || value, 'h' || value,
              'pending', 0, ?2 + value
         from (
           with recursive seq(value) as (
             select 1 union all select value + 1 from seq where value < ?3
           )
           select value from seq
         )`,
    )
    .bind(threadId, t0, count)
    .run()
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  const thread = await getOrCreateThread(db, { pageKey: '/queue-limit', now: t0 })
  threadId = thread.id
  // One row more than the maximum, so a page that came back at the maximum was
  // actually cut short rather than simply running out of comments.
  await seedPending(MAX_QUEUE_LIMIT + 5)
})

describe('the moderation queue page size', () => {
  it('returns a bounded page when the caller asks for no particular size', async () => {
    const queue = (await listModerationQueue(db, 'pending', {})).comments

    expect(queue).toHaveLength(DEFAULT_QUEUE_LIMIT)
  })

  it('gives the caller a smaller page when they ask for one', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: 5 })).comments

    expect(queue).toHaveLength(5)
  })

  it('refuses to read the whole table however large a page is asked for', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: 1_000_000 })).comments

    expect(queue).toHaveLength(MAX_QUEUE_LIMIT)
  })

  it('caps a page asked for one row past the maximum', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: MAX_QUEUE_LIMIT + 1 }))
      .comments

    expect(queue).toHaveLength(MAX_QUEUE_LIMIT)
  })

  it('hands back exactly the maximum when the maximum is what was asked for', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: MAX_QUEUE_LIMIT })).comments

    expect(queue).toHaveLength(MAX_QUEUE_LIMIT)
  })
})

describe('a moderation queue page size that is not a page size', () => {
  // Every one of these is bounded rather than passed through. The value reaches
  // this function from a query string, where none of the types TypeScript believes
  // in survive — so the guard is a runtime one and these are its real inputs.

  it('falls back to the default when asked for no rows at all', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: 0 })).comments

    expect(queue).toHaveLength(DEFAULT_QUEUE_LIMIT)
  })

  it('falls back to the default when asked for a negative number of rows', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: -1 })).comments

    expect(queue).toHaveLength(DEFAULT_QUEUE_LIMIT)
  })

  it('truncates a fractional page size downwards rather than rounding it up', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: 2.5 })).comments

    expect(queue).toHaveLength(2)
  })

  it('falls back to the default for NaN', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: Number.NaN })).comments

    expect(queue).toHaveLength(DEFAULT_QUEUE_LIMIT)
  })

  it('falls back to the default for Infinity, which is not a count', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: Number.POSITIVE_INFINITY }))
      .comments

    expect(queue).toHaveLength(DEFAULT_QUEUE_LIMIT)
  })

  it('falls back to the default for negative Infinity', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: Number.NEGATIVE_INFINITY }))
      .comments

    expect(queue).toHaveLength(DEFAULT_QUEUE_LIMIT)
  })

  it('falls back to the default when handed null', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: null })).comments

    expect(queue).toHaveLength(DEFAULT_QUEUE_LIMIT)
  })
})

describe('a moderation queue page size arriving as a string', () => {
  // A query-string parameter is a string every time. A handler that forgets to
  // parse it must not be the difference between a bounded read and a full scan.

  it('reads a numeric string as the number it spells', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: '25' })).comments

    expect(queue).toHaveLength(25)
  })

  it('caps a numeric string that spells a number past the maximum', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: '1000000' })).comments

    expect(queue).toHaveLength(MAX_QUEUE_LIMIT)
  })

  it('falls back to the default for "0"', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: '0' })).comments

    expect(queue).toHaveLength(DEFAULT_QUEUE_LIMIT)
  })

  it('falls back to the default for "-1"', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: '-1' })).comments

    expect(queue).toHaveLength(DEFAULT_QUEUE_LIMIT)
  })

  it('truncates "2.5" downwards, as it does the number', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: '2.5' })).comments

    expect(queue).toHaveLength(2)
  })

  it('falls back to the default for "NaN"', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: 'NaN' })).comments

    expect(queue).toHaveLength(DEFAULT_QUEUE_LIMIT)
  })

  it('falls back to the default for "Infinity"', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: 'Infinity' })).comments

    expect(queue).toHaveLength(DEFAULT_QUEUE_LIMIT)
  })

  it('falls back to the default for a string that is not a number at all', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: 'all' })).comments

    expect(queue).toHaveLength(DEFAULT_QUEUE_LIMIT)
  })

  it('falls back to the default for an empty string', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: '' })).comments

    expect(queue).toHaveLength(DEFAULT_QUEUE_LIMIT)
  })

  it('falls back to the default for a string of only whitespace', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: '   ' })).comments

    expect(queue).toHaveLength(DEFAULT_QUEUE_LIMIT)
  })

  // '1e9' and '0x10' are both valid to Number(). Neither may widen the read.
  it('caps a page size written in exponent notation', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: '1e9' })).comments

    expect(queue).toHaveLength(MAX_QUEUE_LIMIT)
  })

  it('caps a page size written in hexadecimal', async () => {
    const queue = (await listModerationQueue(db, 'pending', { limit: '0xFFFF' })).comments

    expect(queue).toHaveLength(MAX_QUEUE_LIMIT)
  })
})

describe('the cap itself', () => {
  // A tripwire on the constants rather than on the code: the clamp keeps working
  // perfectly if someone raises MAX_QUEUE_LIMIT to 100,000, and every test above
  // still passes. These are the two ceilings that make the number a cap at all.

  it('keeps the worst-case page well inside the memory a Worker isolate has', () => {
    // A body is capped at 10,000 characters by the schema, against 128 MB per
    // isolate. 8 MB of comment bodies leaves room for the rest of the request and
    // still allows a far larger page than triage needs.
    const worstCaseBodyBytes = MAX_QUEUE_LIMIT * 10_000
    expect(worstCaseBodyBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('keeps a single queue load a rounding error against the day of row reads', () => {
    // 5M row reads/day on the free tier, shared across the account. At most one
    // row read per row returned, so a page must stay under a thousandth of the day
    // — where the unclamped `limit=100000` in the issue spent 2% of it in one click.
    expect(MAX_QUEUE_LIMIT).toBeLessThanOrEqual(5_000_000 / 1_000)
  })

  it('never hands back a default page larger than the maximum page', () => {
    expect(DEFAULT_QUEUE_LIMIT).toBeLessThanOrEqual(MAX_QUEUE_LIMIT)
  })
})
