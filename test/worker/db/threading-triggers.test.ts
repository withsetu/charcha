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
})
