import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REPLY_TARGET_SQL,
  getOrCreateThread,
  insertComment,
  isReplyTarget,
  setCommentStatus,
  type Thread,
} from '../../../src/db'

const db = env.DB
const t0 = 1_753_300_000

async function approvedRoot(thread: Thread, body = 'a root comment') {
  const comment = await insertComment(db, {
    threadId: thread.id,
    authorName: 'Rahul Kanwar',
    body,
    bodyHash: `h-${body}`,
    now: t0,
  })
  await setCommentStatus(db, comment.id, 'approved', t0 + 10)
  return comment
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

describe('isReplyTarget', () => {
  it('accepts an approved top-level comment on the same thread', async () => {
    const thread = await getOrCreateThread(db, { pageKey: '/post', now: t0 })
    const root = await approvedRoot(thread)

    expect(await isReplyTarget(db, thread.id, root.id)).toBe(true)
  })

  it('refuses a comment that does not exist', async () => {
    const thread = await getOrCreateThread(db, { pageKey: '/post', now: t0 })

    expect(await isReplyTarget(db, thread.id, 99_999)).toBe(false)
  })

  it('refuses a comment on another page', async () => {
    // The comments_parent_thread_guard trigger refuses this at insert time too.
    // This read is what turns that abort into a 400 instead of a 500 — and, on its
    // own, what stops one page's conversation being grafted onto another's.
    const pageA = await getOrCreateThread(db, { pageKey: '/post-a', now: t0 })
    const pageB = await getOrCreateThread(db, { pageKey: '/post-b', now: t0 })
    const rootOfA = await approvedRoot(pageA)

    expect(await isReplyTarget(db, pageB.id, rootOfA.id)).toBe(false)
  })

  it('refuses a reply, because threading stops at two levels', async () => {
    const thread = await getOrCreateThread(db, { pageKey: '/post', now: t0 })
    const root = await approvedRoot(thread)
    const reply = await insertComment(db, {
      threadId: thread.id,
      parentId: root.id,
      authorName: 'Maya',
      body: 'a reply',
      bodyHash: 'h2',
      now: t0 + 20,
    })
    await setCommentStatus(db, reply.id, 'approved', t0 + 30)

    expect(await isReplyTarget(db, thread.id, reply.id)).toBe(false)
  })

  it('refuses a comment still waiting for review', async () => {
    // A reader cannot see a pending comment, so they cannot have clicked reply on
    // one. An id that names a pending comment was guessed, and answering "yes, that
    // exists" to a guess turns the reply field into an oracle for what is in the
    // moderation queue.
    const thread = await getOrCreateThread(db, { pageKey: '/post', now: t0 })
    const pending = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Priya',
      body: 'in the queue',
      bodyHash: 'h1',
      now: t0,
    })

    expect(await isReplyTarget(db, thread.id, pending.id)).toBe(false)
  })

  it('refuses a comment the moderator marked spam', async () => {
    const thread = await getOrCreateThread(db, { pageKey: '/post', now: t0 })
    const root = await approvedRoot(thread)
    await setCommentStatus(db, root.id, 'spam', t0 + 40)

    expect(await isReplyTarget(db, thread.id, root.id)).toBe(false)
  })

  it('refuses an id that is not a positive whole number, without asking the database', async () => {
    const thread = await getOrCreateThread(db, { pageKey: '/post', now: t0 })

    expect(await isReplyTarget(db, thread.id, 0)).toBe(false)
    expect(await isReplyTarget(db, thread.id, -1)).toBe(false)
    expect(await isReplyTarget(db, thread.id, 1.5)).toBe(false)
    expect(await isReplyTarget(db, thread.id, Number.NaN)).toBe(false)
  })

  it('costs one row, whatever else is in the table', async () => {
    // The submission path's query count has to stay constant, and so does the cost
    // of each query on it. Against REPLY_TARGET_SQL itself, never a copy.
    const thread = await getOrCreateThread(db, { pageKey: '/post', now: t0 })
    const root = await approvedRoot(thread)
    for (let i = 0; i < 30; i++) await approvedRoot(thread, `filler ${i}`)

    const { meta } = await db.prepare(REPLY_TARGET_SQL).bind(root.id, thread.id).all()

    expect(meta.rows_read).toBeLessThanOrEqual(1)
  })

  it('issues one statement and no write', async () => {
    const thread = await getOrCreateThread(db, { pageKey: '/post', now: t0 })
    const root = await approvedRoot(thread)
    const statements: string[] = []
    const prepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      statements.push(sql)
      return prepare(sql)
    })

    await isReplyTarget(db, thread.id, root.id)
    spy.mockRestore()

    expect(statements).toHaveLength(1)
    expect(statements[0]).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b/i)
  })
})
