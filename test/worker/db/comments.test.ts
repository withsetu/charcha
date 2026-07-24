import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getOrCreateThread,
  insertComment,
  listModerationQueue,
  listPageComments,
  setCommentStatus,
} from '../../../src/db'

const db = env.DB
const t0 = 1_753_300_000

async function seedThread(pageKey = '/notes/leaving-the-comment-industry') {
  return getOrCreateThread(db, {
    pageKey,
    pageUrl: `https://maya.build${pageKey}`,
    title: 'Leaving the comment industry',
    now: t0,
  })
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

describe('getOrCreateThread', () => {
  it('creates a thread the first time a page is seen', async () => {
    const thread = await seedThread()

    expect(thread.id).toBeGreaterThan(0)
    expect(thread.pageKey).toBe('/notes/leaving-the-comment-industry')
    expect(thread.title).toBe('Leaving the comment industry')
  })

  it('returns the same thread on the next visit rather than a second row', async () => {
    const first = await seedThread()
    const second = await seedThread()

    expect(second.id).toBe(first.id)
    const threads = await db.prepare('select count(*) as count from threads').first<{
      count: number
    }>()
    expect(threads?.count).toBe(1)
  })

  it('refreshes the title and URL, so a renamed page is not stale in the queue', async () => {
    const first = await seedThread()
    const renamed = await getOrCreateThread(db, {
      pageKey: first.pageKey,
      pageUrl: 'https://maya.build/notes/leaving-the-comment-industry?utm=x',
      title: 'Leaving the comment industry (2026 edit)',
      now: t0 + 60,
    })

    expect(renamed.id).toBe(first.id)
    expect(renamed.title).toBe('Leaving the comment industry (2026 edit)')
    expect(renamed.updatedAt).toBe(t0 + 60)
  })
})

describe('insertComment', () => {
  it('holds a new comment for review rather than publishing it', async () => {
    const thread = await seedThread()

    const comment = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Rahul Kanwar',
      body: 'The part people underestimate is the export.',
      bodyHash: 'hash-1',
      now: t0,
    })

    expect(comment.status).toBe('pending')
    expect(comment.depth).toBe(0)
    expect(comment.parentId).toBeNull()
  })

  it('records a reply at depth 1', async () => {
    const thread = await seedThread()
    const root = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Rahul Kanwar',
      body: 'root',
      bodyHash: 'hash-1',
      now: t0,
    })

    const reply = await insertComment(db, {
      threadId: thread.id,
      parentId: root.id,
      authorName: 'Maya',
      body: 'reply',
      bodyHash: 'hash-2',
      now: t0 + 10,
    })

    expect(reply.depth).toBe(1)
    expect(reply.parentId).toBe(root.id)
  })

  it('refuses a reply to a reply, in the database, not in the caller', async () => {
    const thread = await seedThread()
    const root = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Rahul Kanwar',
      body: 'root',
      bodyHash: 'hash-1',
      now: t0,
    })
    const reply = await insertComment(db, {
      threadId: thread.id,
      parentId: root.id,
      authorName: 'Maya',
      body: 'reply',
      bodyHash: 'hash-2',
      now: t0 + 10,
    })

    await expect(
      insertComment(db, {
        threadId: thread.id,
        parentId: reply.id,
        authorName: 'Thomas Lund',
        body: 'reply to a reply',
        bodyHash: 'hash-3',
        now: t0 + 20,
      }),
    ).rejects.toThrow(/more than one level/)
  })

  it('refuses a comment on a thread that does not exist', async () => {
    await expect(
      insertComment(db, {
        threadId: 99_999,
        authorName: 'Nobody',
        body: 'orphan',
        bodyHash: 'hash-x',
        now: t0,
      }),
    ).rejects.toThrow(/FOREIGN KEY/i)
  })
})

describe('listPageComments', () => {
  async function seedConversation() {
    const thread = await seedThread()
    const root = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Rahul Kanwar',
      authorEmail: 'rahul@example.com',
      body: 'first',
      bodyHash: 'h1',
      ipHash: 'ip-hash-1',
      now: t0,
    })
    const reply = await insertComment(db, {
      threadId: thread.id,
      parentId: root.id,
      authorName: 'Maya',
      body: 'a reply',
      bodyHash: 'h2',
      now: t0 + 10,
    })
    const pending = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Priya',
      body: 'still in the queue',
      bodyHash: 'h3',
      now: t0 + 20,
    })
    await setCommentStatus(db, root.id, 'approved', t0 + 30)
    await setCommentStatus(db, reply.id, 'approved', t0 + 30)
    return { thread, root, reply, pending }
  }

  it('returns approved comments oldest first, replies included', async () => {
    const { thread, root, reply } = await seedConversation()

    const comments = await listPageComments(db, thread.pageKey)

    expect(comments.map((comment) => comment.id)).toEqual([root.id, reply.id])
    expect(comments.map((comment) => comment.depth)).toEqual([0, 1])
  })

  it('does not return comments that are still held for review', async () => {
    const { thread, pending } = await seedConversation()

    const comments = await listPageComments(db, thread.pageKey)

    expect(comments.map((comment) => comment.id)).not.toContain(pending.id)
  })

  it('does not return spam, so a rejected comment cannot reappear on the page', async () => {
    const { thread, root } = await seedConversation()
    await setCommentStatus(db, root.id, 'spam', t0 + 40)

    const comments = await listPageComments(db, thread.pageKey)

    expect(comments.map((comment) => comment.id)).not.toContain(root.id)
  })

  it('never asks the database for an email address or an IP hash', async () => {
    const { thread } = await seedConversation()
    const statements: string[] = []
    const prepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      statements.push(sql)
      return prepare(sql)
    })

    await listPageComments(db, thread.pageKey)
    spy.mockRestore()

    // One statement, because a per-comment read is a hard failure rather than a
    // slow page — and no write, because reads outnumber writes 50 to 1 in the
    // free tier and traffic must never be able to use up the comment budget.
    expect(statements).toHaveLength(1)
    expect(statements[0]).not.toMatch(/author_email|ip_hash/)
    expect(statements[0]).not.toMatch(/\binsert\b|\bupdate\b/i)
  })

  it('never hands the renderer an email address or an IP hash', async () => {
    const { thread } = await seedConversation()

    const comments = await listPageComments(db, thread.pageKey)

    expect(comments).not.toHaveLength(0)
    for (const comment of comments) {
      expect(Object.keys(comment)).not.toContain('authorEmail')
      expect(Object.keys(comment)).not.toContain('ipHash')
      expect(JSON.stringify(comment)).not.toContain('example.com')
      expect(JSON.stringify(comment)).not.toContain('ip-hash')
    }
  })

  it('renders a page nobody has commented on as empty, and creates nothing', async () => {
    const comments = await listPageComments(db, '/a-page-with-no-conversation')

    expect(comments).toEqual([])
    const threads = await db.prepare('select count(*) as count from threads').first<{
      count: number
    }>()
    expect(threads?.count).toBe(0)
  })

  it('reads only its own thread, not the whole table', async () => {
    const hot = await seedThread('/hot')
    const other = await seedThread('/other')
    for (let i = 0; i < 40; i++) {
      const target = i < 20 ? hot : other
      const comment = await insertComment(db, {
        threadId: target.id,
        authorName: `Commenter ${i}`,
        body: `comment ${i}`,
        bodyHash: `h-${i}`,
        now: t0 + i,
      })
      await setCommentStatus(db, comment.id, 'approved', t0 + i)
    }

    const { results, meta } = await db
      .prepare(
        `select id from comments where thread_id = ?1 and status = 'approved' order by created_at, id`,
      )
      .bind(hot.id)
      .all()

    // 20 rows of payload. Without comments_by_thread this scans all 40 and grows
    // with the whole database rather than with the page — which is how a busy
    // site burns the 5M row reads/day free allowance.
    expect(results).toHaveLength(20)
    expect(meta.rows_read).toBeLessThan(30)
  })
})

describe('setCommentStatus', () => {
  it('records when the decision was taken, so the queue can show it', async () => {
    const thread = await seedThread()
    const comment = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Rahul Kanwar',
      body: 'body',
      bodyHash: 'h1',
      now: t0,
    })

    const updated = await setCommentStatus(db, comment.id, 'approved', t0 + 90)

    expect(updated.status).toBe('approved')
    expect(updated.moderatedAt).toBe(t0 + 90)
  })

  it('reports a decision on a comment that is not there, rather than succeeding quietly', async () => {
    await expect(setCommentStatus(db, 99_999, 'approved', t0)).rejects.toThrow(/no comment/i)
  })
})

describe('listModerationQueue', () => {
  it('returns one status across every thread, newest first', async () => {
    const a = await seedThread('/a')
    const b = await seedThread('/b')
    const older = await insertComment(db, {
      threadId: a.id,
      authorName: 'A',
      body: 'older',
      bodyHash: 'h1',
      now: t0,
    })
    const newer = await insertComment(db, {
      threadId: b.id,
      authorName: 'B',
      body: 'newer',
      bodyHash: 'h2',
      now: t0 + 100,
    })
    const approved = await insertComment(db, {
      threadId: b.id,
      authorName: 'C',
      body: 'approved already',
      bodyHash: 'h3',
      now: t0 + 200,
    })
    await setCommentStatus(db, approved.id, 'approved', t0 + 300)

    const queue = await listModerationQueue(db, 'pending', 50)

    expect(queue.map((comment) => comment.id)).toEqual([newer.id, older.id])
    expect(queue[0]?.pageKey).toBe('/b')
  })
})

describe('deleting a thread', () => {
  it('takes its comments with it', async () => {
    const thread = await seedThread()
    await insertComment(db, {
      threadId: thread.id,
      authorName: 'Rahul Kanwar',
      body: 'body',
      bodyHash: 'h1',
      now: t0,
    })

    await db.prepare('delete from threads where id = ?1').bind(thread.id).run()

    const comments = await db.prepare('select count(*) as count from comments').first<{
      count: number
    }>()
    expect(comments?.count).toBe(0)
  })
})
