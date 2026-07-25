import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { getOrCreateThread, insertComment } from '../../../src/db'

// The two threading invariants — replies stop at one level, and a reply lives on
// the page it is replying to — are enforced by triggers rather than by the data
// layer, so that a future code path that forgets them still fails closed (#29).
//
// These tests drive the triggers directly with raw SQL, because that is exactly
// what the code path this guards against looks like: a merge-threads or
// move-comment feature reaching for `update comments set ...` without knowing the
// rules. Nothing in src/db writes parent_id or thread_id after the insert, so
// there is no data-layer function to call.

const db = env.DB
const t0 = 1_753_300_000

async function seedThread(pageKey: string) {
  return getOrCreateThread(db, {
    pageKey,
    pageUrl: `https://maya.build${pageKey}`,
    title: 'A post',
    now: t0,
  })
}

/** A page with a root comment and one reply to it. */
async function seedRootAndReply(pageKey: string, hashPrefix: string) {
  const thread = await seedThread(pageKey)
  const root = await insertComment(db, {
    threadId: thread.id,
    authorName: 'Rahul Kanwar',
    body: 'root',
    bodyHash: `${hashPrefix}-1`,
    now: t0,
  })
  const reply = await insertComment(db, {
    threadId: thread.id,
    parentId: root.id,
    authorName: 'Maya',
    body: 'reply',
    bodyHash: `${hashPrefix}-2`,
    now: t0 + 10,
  })
  return { thread, root, reply }
}

function reparent(commentId: number, parentId: number) {
  return db
    .prepare('update comments set parent_id = ?2 where id = ?1')
    .bind(commentId, parentId)
    .run()
}

function moveToThread(commentId: number, threadId: number) {
  return db
    .prepare('update comments set thread_id = ?2 where id = ?1')
    .bind(commentId, threadId)
    .run()
}

/**
 * Turn a root comment into a reply. `depth` has to move with `parent_id` or the
 * CHECK constraints reject the row before any trigger has an opinion, which would
 * make a guard test pass for the wrong reason.
 */
function makeIntoReplyOf(commentId: number, parentId: number) {
  return db
    .prepare('update comments set parent_id = ?2, depth = 1 where id = ?1')
    .bind(commentId, parentId)
    .run()
}

function threadIdOf(commentId: number) {
  return db
    .prepare('select thread_id from comments where id = ?1')
    .bind(commentId)
    .first<{ thread_id: number }>()
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

describe('comments_depth_guard', () => {
  it('refuses a reply to a reply on insert', async () => {
    const { thread, reply } = await seedRootAndReply('/post-a', 'h')

    await expect(
      insertComment(db, {
        threadId: thread.id,
        parentId: reply.id,
        authorName: 'Thomas Lund',
        body: 'reply to a reply',
        bodyHash: 'h-3',
        now: t0 + 20,
      }),
    ).rejects.toThrow(/more than one level/)
  })

  it('refuses to re-parent a reply onto another reply, which would nest it three deep', async () => {
    const { thread, root, reply } = await seedRootAndReply('/post-a', 'h')
    const sibling = await insertComment(db, {
      threadId: thread.id,
      parentId: root.id,
      authorName: 'Priya',
      body: 'another reply',
      bodyHash: 'h-3',
      now: t0 + 20,
    })

    await expect(reparent(sibling.id, reply.id)).rejects.toThrow(/more than one level/)
  })

  it('leaves the reply where it was when the update is refused', async () => {
    const { thread, root, reply } = await seedRootAndReply('/post-a', 'h')
    const sibling = await insertComment(db, {
      threadId: thread.id,
      parentId: root.id,
      authorName: 'Priya',
      body: 'another reply',
      bodyHash: 'h-3',
      now: t0 + 20,
    })

    await expect(reparent(sibling.id, reply.id)).rejects.toThrow()

    const stored = await db
      .prepare('select parent_id from comments where id = ?1')
      .bind(sibling.id)
      .first<{ parent_id: number | null }>()
    expect(stored?.parent_id).toBe(root.id)
  })
})

describe('comments_parent_thread_guard', () => {
  it('refuses a reply whose parent lives on a different page, on insert', async () => {
    const { root } = await seedRootAndReply('/post-a', 'a')
    const pageB = await seedThread('/post-b')

    await expect(
      insertComment(db, {
        threadId: pageB.id,
        parentId: root.id,
        authorName: 'Grafter',
        body: 'grafted onto another page',
        bodyHash: 'b-1',
        now: t0 + 20,
      }),
    ).rejects.toThrow(/same page/i)
  })

  it('refuses to move a reply onto a page its parent is not on', async () => {
    const { reply } = await seedRootAndReply('/post-a', 'a')
    const pageB = await seedThread('/post-b')

    await expect(moveToThread(reply.id, pageB.id)).rejects.toThrow(/same page/i)
  })

  it('leaves the reply on its own page when the move is refused', async () => {
    const { thread, reply } = await seedRootAndReply('/post-a', 'a')
    const pageB = await seedThread('/post-b')

    await expect(moveToThread(reply.id, pageB.id)).rejects.toThrow()

    const stored = await db
      .prepare('select thread_id from comments where id = ?1')
      .bind(reply.id)
      .first<{ thread_id: number }>()
    expect(stored?.thread_id).toBe(thread.id)
  })
})

// The four guards above are all written from the point of view of the *reply* —
// their WHEN clause starts `NEW.parent_id IS NOT NULL`, so they only fire when the
// row being written is a child. That leaves the same edge open from the other end:
// updating a comment that *has* replies never touches NEW.parent_id, so none of
// them sees it, and the replies are stranded pointing at a parent that has moved
// out from under them (#60).
describe('the guards seen from the comment being replied to', () => {
  it('refuses to move a comment that has replies onto another page', async () => {
    const { root } = await seedRootAndReply('/post-a', 'a')
    const pageB = await seedThread('/post-b')

    await expect(moveToThread(root.id, pageB.id)).rejects.toThrow(/same page/i)
  })

  it('leaves the comment and its replies on their own page when the move is refused', async () => {
    const { thread, root, reply } = await seedRootAndReply('/post-a', 'a')
    const pageB = await seedThread('/post-b')

    await expect(moveToThread(root.id, pageB.id)).rejects.toThrow()

    expect((await threadIdOf(root.id))?.thread_id).toBe(thread.id)
    expect((await threadIdOf(reply.id))?.thread_id).toBe(thread.id)
  })

  it('refuses to turn a comment that has replies into a reply itself', async () => {
    const { thread, root } = await seedRootAndReply('/post-a', 'a')
    const otherRoot = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Thomas Lund',
      body: 'another root',
      bodyHash: 'a-3',
      now: t0 + 20,
    })

    await expect(makeIntoReplyOf(root.id, otherRoot.id)).rejects.toThrow(/more than one level/)
  })

  // A row that is its own parent is a reply *and* has a reply, and it arrives
  // atomically: before the update nothing points at the row, and both depth guards
  // read the pre-update state, so neither the before nor the after view catches it.
  // The renderer files anything with a parent_id under that parent and emits no
  // root for it, so the comment and its subtree vanish from the page silently.
  // A CHECK constraint answers this, and no trigger has to.
  it('refuses to make a comment its own parent', async () => {
    const thread = await seedThread('/post-a')
    const lonely = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Rahul Kanwar',
      body: 'nobody replied',
      bodyHash: 'a-1',
      now: t0,
    })

    await expect(
      db
        .prepare('update comments set parent_id = id, depth = 1 where id = ?1')
        .bind(lonely.id)
        .run(),
    ).rejects.toThrow(/constraint/i)

    const stored = await db
      .prepare('select parent_id, depth from comments where id = ?1')
      .bind(lonely.id)
      .first<{ parent_id: number | null; depth: number }>()
    expect(stored).toEqual({ parent_id: null, depth: 0 })
  })

  // `depth` is in both OF lists, so this reaches the trigger. Without it the two
  // CHECK constraints reject the same statement anyway — what the entry buys is
  // that the guard is what answers, which is why this asserts the message and not
  // merely that it was refused. BEFORE triggers run ahead of constraint checking.
  it('refuses a depth-only update on a comment that has replies, from the trigger', async () => {
    const { root } = await seedRootAndReply('/post-a', 'a')

    await expect(
      db.prepare('update comments set depth = 1 where id = ?1').bind(root.id).run(),
    ).rejects.toThrow(/more than one level/)
  })

  it('leaves the comment a root when that update is refused', async () => {
    const { thread, root, reply } = await seedRootAndReply('/post-a', 'a')
    const otherRoot = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Thomas Lund',
      body: 'another root',
      bodyHash: 'a-3',
      now: t0 + 20,
    })

    await expect(makeIntoReplyOf(root.id, otherRoot.id)).rejects.toThrow()

    const stored = await db
      .prepare('select parent_id, depth from comments where id = ?1')
      .bind(root.id)
      .first<{ parent_id: number | null; depth: number }>()
    expect(stored?.parent_id).toBe(null)
    expect(stored?.depth).toBe(0)
    // And the reply is still hanging off it, one level deep.
    const child = await db
      .prepare('select parent_id, depth from comments where id = ?1')
      .bind(reply.id)
      .first<{ parent_id: number | null; depth: number }>()
    expect(child?.parent_id).toBe(root.id)
    expect(child?.depth).toBe(1)
  })
})

// A guard that fires on every update would be indistinguishable from a frozen
// table, and moderation is nothing but updates. These say the guards cost the
// legitimate writer nothing.
describe('updates the guards must not block', () => {
  it('still lets a moderator change a comment status', async () => {
    const { reply } = await seedRootAndReply('/post-a', 'a')

    await db
      .prepare('update comments set status = ?2, moderated_at = ?3 where id = ?1')
      .bind(reply.id, 'approved', t0 + 30)
      .run()

    const stored = await db
      .prepare('select status from comments where id = ?1')
      .bind(reply.id)
      .first<{ status: string }>()
    expect(stored?.status).toBe('approved')
  })

  it('still lets a comment body be edited', async () => {
    const { reply } = await seedRootAndReply('/post-a', 'a')

    await db
      .prepare('update comments set body = ?2 where id = ?1')
      .bind(reply.id, 'reply, corrected')
      .run()

    const stored = await db
      .prepare('select body from comments where id = ?1')
      .bind(reply.id)
      .first<{ body: string }>()
    expect(stored?.body).toBe('reply, corrected')
  })

  it('still lets a reply move to another root comment on the same page', async () => {
    const { thread, reply } = await seedRootAndReply('/post-a', 'a')
    const otherRoot = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Thomas Lund',
      body: 'another root',
      bodyHash: 'a-3',
      now: t0 + 20,
    })

    await reparent(reply.id, otherRoot.id)

    const stored = await db
      .prepare('select parent_id from comments where id = ?1')
      .bind(reply.id)
      .first<{ parent_id: number | null }>()
    expect(stored?.parent_id).toBe(otherRoot.id)
  })

  it('still lets a moderator act on a comment that has replies', async () => {
    const { root } = await seedRootAndReply('/post-a', 'a')

    await db
      .prepare('update comments set status = ?2, moderated_at = ?3 where id = ?1')
      .bind(root.id, 'approved', t0 + 30)
      .run()

    const stored = await db
      .prepare('select status from comments where id = ?1')
      .bind(root.id)
      .first<{ status: string }>()
    expect(stored?.status).toBe('approved')
  })

  it('still lets a comment with no replies of its own move to another page', async () => {
    const thread = await seedThread('/post-a')
    const lonely = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Rahul Kanwar',
      body: 'nobody replied',
      bodyHash: 'a-1',
      now: t0,
    })
    const pageB = await seedThread('/post-b')

    await moveToThread(lonely.id, pageB.id)

    expect((await threadIdOf(lonely.id))?.thread_id).toBe(pageB.id)
  })

  // `UPDATE OF thread_id` fires on the column appearing in the SET clause, not on
  // its value changing — https://sqlite.org/lang_createtrigger.html. So the guard
  // does see this statement, and has to decide it is harmless rather than never
  // being asked.
  it('still lets a comment with replies be written with the page it is already on', async () => {
    const { thread, root } = await seedRootAndReply('/post-a', 'a')

    await moveToThread(root.id, thread.id)

    expect((await threadIdOf(root.id))?.thread_id).toBe(thread.id)
  })

  // The guards leave no ordering that moves a parent and its replies to another
  // page in one pass — the parent is refused while the replies are behind, and each
  // reply while its parent is. This is the route that is left, and it has to stay
  // open: a guard with no legal way past it is a frozen table with extra steps.
  it('still lets a whole conversation move pages, detached and re-attached', async () => {
    const { root, reply } = await seedRootAndReply('/post-a', 'a')
    const pageB = await seedThread('/post-b')

    await db
      .prepare('update comments set parent_id = null, depth = 0 where id = ?1')
      .bind(reply.id)
      .run()
    await moveToThread(root.id, pageB.id)
    await moveToThread(reply.id, pageB.id)
    await makeIntoReplyOf(reply.id, root.id)

    expect((await threadIdOf(root.id))?.thread_id).toBe(pageB.id)
    const moved = await db
      .prepare('select thread_id, parent_id, depth from comments where id = ?1')
      .bind(reply.id)
      .first<{ thread_id: number; parent_id: number | null; depth: number }>()
    expect(moved).toEqual({ thread_id: pageB.id, parent_id: root.id, depth: 1 })
  })
})

// The parent-side guards are the only ones in this file that ask a question about
// rows other than the one being written, so they are the only ones whose cost could
// grow with the size of the page. `EXPLAIN QUERY PLAN` cannot answer this — it
// reports the plan of the UPDATE and says nothing about the trigger programs it
// runs — so the measurement is D1's own rows_read.
//
// Which needs its own control. "The guards read nothing" and "rows_read cannot see
// a trigger" produce identical numbers, and only one of them is good news, so the
// first test below pins the instrument before the second one uses it.
describe('what the parent-side guards cost', () => {
  it('counts rows a trigger reads, so the figures below mean something', async () => {
    const { thread, root, reply } = await seedRootAndReply('/instrument', 'i')
    const otherRoot = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Thomas Lund',
      body: 'another root',
      bodyHash: 'i-3',
      now: t0 + 20,
    })

    // status is in no OF list, so this fires no trigger at all.
    const noTrigger = await db
      .prepare('update comments set status = ?2 where id = ?1')
      .bind(reply.id, 'approved')
      .run()
    // Re-parenting fires comments_depth_guard_on_update, whose WHEN reads the new
    // parent's row — work rows_read has to be able to see.
    const readsARow = await db
      .prepare('update comments set parent_id = ?2 where id = ?1')
      .bind(reply.id, otherRoot.id)
      .run()

    expect(noTrigger.meta.rows_read).toBeGreaterThan(0)
    expect(readsARow.meta.rows_read).toBeGreaterThan(noTrigger.meta.rows_read)
    expect(root.id).not.toBe(otherRoot.id)
  })

  /**
   * Move a comment nobody has replied to onto another page — an update the guards
   * allow, and one that reaches their EXISTS rather than short-circuiting before
   * it. `replyCount` replies to a *different* comment on the same page fill
   * comments_by_parent without changing the answer the guard should give.
   */
  async function rowsReadMovingAChildlessComment(replyCount: number, tag: string) {
    const thread = await seedThread(`/cost-${tag}`)
    const busy = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Rahul Kanwar',
      body: 'the comment everyone replied to',
      bodyHash: `${tag}-busy`,
      now: t0,
    })
    for (let i = 0; i < replyCount; i += 1) {
      await insertComment(db, {
        threadId: thread.id,
        parentId: busy.id,
        authorName: 'Priya',
        body: `reply ${i}`,
        bodyHash: `${tag}-r-${i}`,
        now: t0 + i,
      })
    }
    const lonely = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Thomas Lund',
      body: 'nobody replied to this one',
      bodyHash: `${tag}-lonely`,
      now: t0 + 500,
    })
    const destination = await seedThread(`/cost-${tag}-destination`)

    const { meta } = await db
      .prepare('update comments set thread_id = ?2 where id = ?1')
      .bind(lonely.id, destination.id)
      .run()
    return meta.rows_read
  }

  it('reads the same number of rows on a page with 60 replies as on one with 1', async () => {
    const small = await rowsReadMovingAChildlessComment(1, 'small')
    const large = await rowsReadMovingAChildlessComment(60, 'large')

    expect(large).toBe(small)
    // A lower bound, so two equal zeroes cannot pass for a constant cost, and a
    // ceiling, so two equal numbers cannot both be a scan of the same fixture.
    // Measured at 3 on 2026-07-25, with the guards and without them.
    expect(large).toBeGreaterThan(0)
    expect(large).toBeLessThanOrEqual(5)
  })
})
