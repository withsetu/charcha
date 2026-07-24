import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_PAGE_COMMENTS,
  PAGE_COMMENTS_SQL,
  getOrCreateThread,
  listPageComments,
} from '../../../src/db'

const db = env.DB
const t0 = 1_753_300_000

/**
 * Seeds `count` approved root comments in one statement.
 *
 * Deliberately not a loop of insertComment: this test needs more comments than the
 * cap, and 500 round trips would make the suite slow enough that somebody deletes
 * the test. The rows are the same shape insertComment writes.
 */
async function seedApproved(threadId: number, count: number) {
  await db
    .prepare(
      `insert into comments (thread_id, parent_id, depth, author_name, body, body_hash,
                             status, by_owner, created_at)
       with recursive n(value) as (
         select 1 union all select value + 1 from n where value < ?2
       )
       select ?1, null, 0, 'Bulk commenter', 'comment ' || value, 'h-' || value,
              'approved', 0, ?3 + value
         from n`,
    )
    .bind(threadId, count, t0)
    .run()
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

describe('the page read is capped', () => {
  it('returns at most MAX_PAGE_COMMENTS however many the page has', async () => {
    const thread = await getOrCreateThread(db, { pageKey: '/busy', now: t0 })
    await seedApproved(thread.id, MAX_PAGE_COMMENTS + 1)

    const page = await listPageComments(db, '/busy')

    expect(page.comments).toHaveLength(MAX_PAGE_COMMENTS)
  })

  it('says so, rather than truncating the conversation silently', async () => {
    const thread = await getOrCreateThread(db, { pageKey: '/busy', now: t0 })
    await seedApproved(thread.id, MAX_PAGE_COMMENTS + 1)

    const page = await listPageComments(db, '/busy')

    expect(page.truncated).toBe(true)
  })

  it('does not claim truncation on a page that fits exactly', async () => {
    // The read asks for one row past the cap precisely so that "exactly full" and
    // "there is more" are different answers. A length check alone cannot tell them
    // apart, and would put a "showing the first N" notice on a complete page.
    const thread = await getOrCreateThread(db, { pageKey: '/exact', now: t0 })
    await seedApproved(thread.id, MAX_PAGE_COMMENTS)

    const page = await listPageComments(db, '/exact')

    expect(page.comments).toHaveLength(MAX_PAGE_COMMENTS)
    expect(page.truncated).toBe(false)
  })

  it('keeps the oldest comments, so no reply is orphaned by the cap', async () => {
    // The cut is at the *end* of the conversation because the order is oldest
    // first. Cutting the oldest instead would strand replies whose roots fell
    // outside the window — and the renderer drops a reply with no parent, so the
    // page would show fewer comments than the cap while claiming to show the cap.
    const thread = await getOrCreateThread(db, { pageKey: '/busy', now: t0 })
    await seedApproved(thread.id, MAX_PAGE_COMMENTS + 5)

    const page = await listPageComments(db, '/busy')

    expect(page.comments[0]?.body).toBe('comment 1')
    expect(page.comments.at(-1)?.body).toBe(`comment ${MAX_PAGE_COMMENTS}`)
  })

  it('bounds the rows the database reads, not only the rows handed back', async () => {
    // The load-bearing assertion, and the one the others cannot make. The cap has
    // to be in the statement: a read that fetched every row and sliced in
    // JavaScript satisfies every length assertion above while still assembling the
    // whole ~100 MB page inside a 128 MB isolate, which is the failure #27 exists
    // to prevent.
    //
    // Against PAGE_COMMENTS_SQL itself, never a copy — a copy is a statement this
    // project does not send, and asserting on one is how a query test passes while
    // production scans.
    const thread = await getOrCreateThread(db, { pageKey: '/busy', now: t0 })
    await seedApproved(thread.id, MAX_PAGE_COMMENTS * 3)

    const { results, meta } = await db
      .prepare(PAGE_COMMENTS_SQL)
      .bind('/busy', MAX_PAGE_COMMENTS + 1)
      .all()

    expect(results).toHaveLength(MAX_PAGE_COMMENTS + 1)
    expect(meta.rows_read).toBeLessThan(MAX_PAGE_COMMENTS * 2)
  })

  it('leaves a page inside the cap untouched', async () => {
    const thread = await getOrCreateThread(db, { pageKey: '/quiet', now: t0 })
    await seedApproved(thread.id, 3)

    const page = await listPageComments(db, '/quiet')

    expect(page.comments).toHaveLength(3)
    expect(page.truncated).toBe(false)
  })

  it('takes no limit from its caller, so no caller can widen it', () => {
    // The contrast with listModerationQueue is deliberate. That one accepts a limit
    // and clamps it silently, because its caller is the signed-in owner paginating
    // their own queue. This one is the public, unauthenticated read: there is no
    // legitimate caller who needs a bigger page, so the safest parameter is the one
    // that does not exist.
    expect(listPageComments).toHaveLength(2)
  })
})
