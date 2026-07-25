import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_QUEUE_LIMIT,
  getOrCreateThread,
  listModerationQueue,
  parseQueueCursor,
} from '../../../src/db'
import type { QueuedComment } from '../../../src/db'

const db = env.DB
const t0 = 1_753_300_000

let threadId: number

/**
 * Seeds `count` pending comments one second apart, newest last. Written as one
 * statement for the same reason queue-limit.test.ts does: the cursor cases need
 * more rows than a page, and the read is what is under test, not the insert.
 */
async function seedPending(count: number, secondsApart = 1) {
  await db
    .prepare(
      `insert into comments (
         thread_id, parent_id, depth, author_name, body, body_hash, status, by_owner, created_at
       )
       select ?1, null, 0, 'Commenter ' || value, 'comment ' || value, 'h' || value,
              'pending', 0, ?2 + (value * ?4)
         from (
           with recursive seq(value) as (
             select 1 union all select value + 1 from seq where value < ?3
           )
           select value from seq
         )`,
    )
    .bind(threadId, t0, count, secondsApart)
    .run()
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  const thread = await getOrCreateThread(db, { pageKey: '/queue-cursor', now: t0 })
  threadId = thread.id
})

/** Walks the whole queue a page at a time, and reports what it saw. */
async function walk(pageSize: number): Promise<{ ids: number[]; pages: number }> {
  const ids: number[] = []
  let cursor: string | null = null
  let pages = 0

  for (;;) {
    const parsed = cursor === null ? null : parseQueueCursor(cursor)
    if (cursor !== null && parsed === null) throw new Error(`unparseable cursor ${cursor}`)

    const page: { comments: QueuedComment[]; nextCursor: string | null } =
      await listModerationQueue(db, 'pending', { limit: pageSize, cursor: parsed })
    pages += 1
    ids.push(...page.comments.map((comment) => comment.id))
    if (page.nextCursor === null) break
    cursor = page.nextCursor
    if (pages > 100) throw new Error('the walk did not terminate')
  }

  return { ids, pages }
}

describe('paging past the first page', () => {
  it('reaches comments the page cap would otherwise put permanently out of view', async () => {
    await seedPending(MAX_QUEUE_LIMIT + 5)

    const { ids } = await walk(MAX_QUEUE_LIMIT)

    expect(ids).toHaveLength(MAX_QUEUE_LIMIT + 5)
  })

  it('returns every comment exactly once', async () => {
    await seedPending(25)

    const { ids } = await walk(10)

    expect(new Set(ids).size).toBe(25)
  })

  it('keeps the newest-first order across the page boundary', async () => {
    await seedPending(25)

    const { ids } = await walk(10)

    const sorted = [...ids].sort((a, b) => b - a)
    expect(ids).toEqual(sorted)
  })

  it('stops rather than looping, which is what a silently-ignored cursor would do', async () => {
    await seedPending(25)

    const { pages } = await walk(10)

    expect(pages).toBe(3)
  })
})

describe('comments sharing one timestamp', () => {
  // A bulk import (#15) lands many comments on the same unix second. A cursor on
  // the timestamp alone either skips those rows or repeats them forever, which is
  // why the cursor is (created_at, id) and not created_at.

  it('are paged through without skipping or repeating any of them', async () => {
    await seedPending(30, 0)

    const { ids } = await walk(10)

    expect(ids).toHaveLength(30)
    expect(new Set(ids).size).toBe(30)
  })

  it('still terminates when a whole page shares one second', async () => {
    await seedPending(30, 0)

    const { pages } = await walk(10)

    expect(pages).toBe(3)
  })
})

describe('the last page', () => {
  it('offers no next cursor, so a UI knows it has reached the end', async () => {
    await seedPending(5)

    const page = await listModerationQueue(db, 'pending', { limit: 10 })

    expect(page.nextCursor).toBeNull()
  })

  it('offers no next cursor when the queue is exactly one page long', async () => {
    // `limit + 1` is what tells "exactly full" from "there is more". Without it a
    // full page always claims a next page, and the UI shows an empty one.
    await seedPending(10)

    const page = await listModerationQueue(db, 'pending', { limit: 10 })

    expect(page.comments).toHaveLength(10)
    expect(page.nextCursor).toBeNull()
  })

  it('offers a next cursor when there is one more comment than the page', async () => {
    await seedPending(11)

    const page = await listModerationQueue(db, 'pending', { limit: 10 })

    expect(page.comments).toHaveLength(10)
    expect(page.nextCursor).not.toBeNull()
  })

  it('offers no next cursor for an empty queue', async () => {
    const page = await listModerationQueue(db, 'spam', { limit: 10 })

    expect(page.comments).toHaveLength(0)
    expect(page.nextCursor).toBeNull()
  })
})

describe('a cursor that is not a cursor', () => {
  // Unlike clampQueueLimit, which clamps silently, this rejects. A silently
  // ignored cursor makes every "next page" request return page one, so a paging
  // UI loops over the first page forever and the oldest comments — the ones the
  // cursor exists to reach — stay unreachable with nothing reporting a fault.

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['no separator', '1753300000'],
    ['two separators', '1753300000.5.7'],
    ['a non-numeric timestamp', 'abc.7'],
    ['a non-numeric id', '1753300000.abc'],
    ['a negative timestamp', '-1.7'],
    ['a negative id', '1753300000.-7'],
    ['a fractional id', '1753300000.7.5'],
    ['an exponent', '1e9.7'],
    ['hexadecimal', '0x10.7'],
    ['a timestamp past ten digits', '17533000000000000000.7'],
    ['an id past the safe integer range', '1753300000.99999999999999999'],
    ['SQL', "1753300000.7' or '1'='1"],
    ['a leading plus', '+1753300000.7'],
    ['a trailing space', '1753300000.7 '],
  ])('is refused: %s', (_label, value) => {
    expect(parseQueueCursor(value)).toBeNull()
  })

  it.each([
    ['a number', 1_753_300_000],
    ['null', null],
    ['undefined', undefined],
    ['an object', { createdAt: 1, id: 2 }],
    ['an array', [1, 2]],
  ])('is refused when it is not even a string: %s', (_label, value) => {
    expect(parseQueueCursor(value)).toBeNull()
  })

  it('accepts the cursor the read itself produced', async () => {
    await seedPending(11)
    const page = await listModerationQueue(db, 'pending', { limit: 10 })

    expect(parseQueueCursor(page.nextCursor)).not.toBeNull()
  })

  it('accepts a zero timestamp, which is a valid unix second', () => {
    expect(parseQueueCursor('0.1')).toEqual({ createdAt: 0, id: 1 })
  })
})

describe('a cursor a caller made up', () => {
  // The cursor is not a capability: it is a position in one status's ordering,
  // and the status is a separate argument. A cursor from the pending queue used
  // against the spam queue is a position, not an authorisation to see pending.

  it('cannot be used to read a status the caller did not ask for', async () => {
    await seedPending(5)
    await db.exec("UPDATE comments SET status = 'spam' WHERE id % 2 = 0")

    const page = await listModerationQueue(db, 'pending', {
      limit: 10,
      cursor: parseQueueCursor(`${t0 + 6}.999999`),
    })

    expect(page.comments.every((comment) => comment.status === 'pending')).toBe(true)
  })

  it('reads nothing at all when it points before the whole queue', async () => {
    await seedPending(5)

    const page = await listModerationQueue(db, 'pending', {
      limit: 10,
      cursor: parseQueueCursor('1.1'),
    })

    expect(page.comments).toHaveLength(0)
    expect(page.nextCursor).toBeNull()
  })
})

describe('the page size still binds on every page', () => {
  it('clamps a caller who asks for the whole table on a later page', async () => {
    await seedPending(MAX_QUEUE_LIMIT + 5)
    const first = await listModerationQueue(db, 'pending', { limit: 5 })

    const second = await listModerationQueue(db, 'pending', {
      limit: 1_000_000,
      cursor: parseQueueCursor(first.nextCursor),
    })

    expect(second.comments).toHaveLength(MAX_QUEUE_LIMIT)
  })
})
