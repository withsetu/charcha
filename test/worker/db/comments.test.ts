import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getOrCreateThread,
  insertComment,
  listModerationQueue,
  listPageComments,
  setCommentStatus,
} from '../../../src/db'
import { cascades } from '../../../src/cascade'

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

describe('getOrCreateThread, revisited', () => {
  it('keeps the stored title when a later write does not carry one', async () => {
    const first = await seedThread()

    const second = await getOrCreateThread(db, { pageKey: first.pageKey, now: t0 + 60 })

    expect(second.title).toBe('Leaving the comment industry')
    expect(second.pageUrl).toBe(first.pageUrl)
    expect(second.updatedAt).toBe(t0 + 60)
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

  it('refuses a reply whose parent lives on a different page', async () => {
    const pageA = await seedThread('/post-a')
    const pageB = await seedThread('/post-b')
    const rootOfA = await insertComment(db, {
      threadId: pageA.id,
      authorName: 'A',
      body: 'root of A',
      bodyHash: 'h1',
      now: t0,
    })

    await expect(
      insertComment(db, {
        threadId: pageB.id,
        parentId: rootOfA.id,
        authorName: 'Grafter',
        body: 'a reply grafted onto another page',
        bodyHash: 'h2',
        now: t0 + 10,
      }),
    ).rejects.toThrow(/same page/i)
  })

  it('publishes an owner comment without holding it, and holds everyone else', async () => {
    const thread = await seedThread()

    const fromOwner = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Maya',
      body: 'answering from the dashboard',
      bodyHash: 'h1',
      byOwner: true,
      now: t0,
    })
    const fromReader = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Reader',
      body: 'a reader comment',
      bodyHash: 'h2',
      now: t0 + 1,
    })

    expect(fromOwner.status).toBe('approved')
    expect(fromOwner.byOwner).toBe(true)
    expect(fromReader.status).toBe('pending')
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

    const { comments } = await listPageComments(db, thread.pageKey)

    expect(comments.map((comment) => comment.id)).toEqual([root.id, reply.id])
    expect(comments.map((comment) => comment.depth)).toEqual([0, 1])
  })

  it('does not return comments that are still held for review', async () => {
    const { thread, pending } = await seedConversation()

    const { comments } = await listPageComments(db, thread.pageKey)

    expect(comments.map((comment) => comment.id)).not.toContain(pending.id)
  })

  it('does not return spam, so a rejected comment cannot reappear on the page', async () => {
    const { thread, root } = await seedConversation()
    await setCommentStatus(db, root.id, 'spam', t0 + 40)

    const { comments } = await listPageComments(db, thread.pageKey)

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

    const { comments } = await listPageComments(db, thread.pageKey)

    expect(comments).not.toHaveLength(0)
    for (const comment of comments) {
      expect(Object.keys(comment)).not.toContain('authorEmail')
      expect(Object.keys(comment)).not.toContain('ipHash')
      expect(JSON.stringify(comment)).not.toContain('example.com')
      expect(JSON.stringify(comment)).not.toContain('ip-hash')
    }
  })

  it('renders a page nobody has commented on as empty, and creates nothing', async () => {
    const { comments } = await listPageComments(db, '/a-page-with-no-conversation')

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

describe('hiding a comment', () => {
  async function seedRootAndReply() {
    const thread = await seedThread()
    const root = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Spammer',
      body: 'buy pills',
      bodyHash: 'h1',
      now: t0,
    })
    const reply = await insertComment(db, {
      threadId: thread.id,
      parentId: root.id,
      authorName: 'Replier',
      body: 'answering the spam',
      bodyHash: 'h2',
      now: t0 + 10,
    })
    await setCommentStatus(db, root.id, 'approved', t0 + 20)
    await setCommentStatus(db, reply.id, 'approved', t0 + 20)
    return { thread, root, reply }
  }

  it('takes the replies underneath it off the page too', async () => {
    const { thread, root } = await seedRootAndReply()

    await setCommentStatus(db, root.id, 'spam', t0 + 30)
    const { comments } = await listPageComments(db, thread.pageKey)

    expect(comments).toEqual([])
  })

  // The page read hides a reply whose parent is not approved, so the test above
  // passes whether or not the status actually cascaded. This one fails only if the
  // reply's own record was left behind — which is what the moderation queue and
  // the classifier's training data would then disagree about.
  it('marks the replies spam in the record, not just on the page', async () => {
    const { root, reply } = await seedRootAndReply()

    await setCommentStatus(db, root.id, 'spam', t0 + 30)

    const stored = await db
      .prepare('select status, moderated_at from comments where id = ?1')
      .bind(reply.id)
      .first<{ status: string; moderated_at: number | null }>()
    expect(stored?.status).toBe('spam')
    expect(stored?.moderated_at).toBe(t0 + 30)
  })

  it('does the same when a comment is deleted', async () => {
    const { thread, root } = await seedRootAndReply()

    await setCommentStatus(db, root.id, 'deleted', t0 + 30)

    expect((await listPageComments(db, thread.pageKey)).comments).toEqual([])
  })

  // `cascaded` is the number the dashboard puts in front of the moderator (#133), so
  // it has to be the number of comments that actually left the queue rather than the
  // number of rows the statement happened to touch.
  it('reports how many replies went with it', async () => {
    const { root } = await seedRootAndReply()

    const decision = await setCommentStatus(db, root.id, 'spam', t0 + 30)

    expect(decision.cascaded).toBe(1)
  })

  it('approving reports none, because approving does not cascade', async () => {
    // Seeded so approving *could* move the reply if the statement let it: the reply is
    // pending, which is not the status being set, so only the `?2 in ('spam','deleted')`
    // clause keeps it where it is. Approving the root of an already-approved reply would
    // report zero whatever the statement did.
    const thread = await seedThread()
    const root = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Root',
      body: 'a root comment',
      bodyHash: 'h1',
      now: t0,
    })
    const reply = await insertComment(db, {
      threadId: thread.id,
      parentId: root.id,
      authorName: 'Replier',
      body: 'an unreviewed reply',
      bodyHash: 'h2',
      now: t0 + 10,
    })

    const decision = await setCommentStatus(db, root.id, 'approved', t0 + 30)

    expect(decision.cascaded).toBe(0)
    const stored = await db
      .prepare('select status from comments where id = ?1')
      .bind(reply.id)
      .first<{ status: string }>()
    expect(stored?.status).toBe('pending')
  })

  // **The dashboard's predicate, run against the statement it is supposed to describe.**
  // src/cascade.ts is the one definition of which decisions cascade — MODERATE_SQL builds
  // its `in (...)` list from it and src/dashboard/queue.ts calls `cascades` — so the copies
  // cannot disagree. What can still go wrong is the set itself being wrong, and this is
  // where that shows: it drives every status the column allows through the real write and
  // asks the database what happened, so adding a status to that constant without meaning
  // to fails here rather than in a browser.
  it.each(['pending', 'approved', 'spam', 'deleted'] as const)(
    'moves the reply exactly when cascades() says it will: %s',
    async (status) => {
      // A reply nobody has judged, so `moderated_at` is null and "did this decision
      // touch it" has a yes-or-no answer. Comparing its *status* to the one being set
      // would not: a reply that was already in that status reads as moved without
      // having been, which is how the first version of this test passed for `approved`
      // while proving nothing.
      const thread = await seedThread()
      const root = await insertComment(db, {
        threadId: thread.id,
        authorName: 'Root',
        body: 'a root comment',
        bodyHash: `root-${status}`,
        now: t0,
      })
      const reply = await insertComment(db, {
        threadId: thread.id,
        parentId: root.id,
        authorName: 'Replier',
        body: 'an unreviewed reply',
        bodyHash: `reply-${status}`,
        now: t0 + 10,
      })

      const decision = await setCommentStatus(db, root.id, status, t0 + 30)
      const stored = await db
        .prepare('select status, moderated_at from comments where id = ?1')
        .bind(reply.id)
        .first<{ status: string; moderated_at: number | null }>()

      expect(stored?.moderated_at === t0 + 30).toBe(cascades(status))
      expect(stored?.status).toBe(cascades(status) ? status : 'pending')
      expect(decision.cascaded).toBe(cascades(status) ? 1 : 0)
    },
  )

  // **A reply already in the target status was not taken down by this decision.**
  // Counting it would put a number on screen that the tab counts contradict: the
  // dashboard recomputes the counts from the database (#138), so "and 2 replies" over
  // a Pending badge that fell by two — the root and one reply — is the same
  // self-contradiction #133 was filed about, one line further down the screen.
  it('does not count a reply that was already spam', async () => {
    const { thread, root, reply } = await seedRootAndReply()
    const second = await insertComment(db, {
      threadId: thread.id,
      parentId: root.id,
      authorName: 'Already spam',
      body: 'caught on its own',
      bodyHash: 'h3',
      now: t0 + 15,
    })
    await setCommentStatus(db, second.id, 'spam', t0 + 25)

    const decision = await setCommentStatus(db, root.id, 'spam', t0 + 30)

    expect(decision.cascaded).toBe(1)
    // And the write is narrowed too, not merely the count: the already-spam reply keeps
    // the timestamp of the decision that actually moved it, so a moderation record does
    // not gain a second, fictitious event — and the row write is not spent (#122).
    const untouched = await db
      .prepare('select moderated_at from comments where id = ?1')
      .bind(second.id)
      .first<{ moderated_at: number | null }>()
    expect(untouched?.moderated_at).toBe(t0 + 25)
    const moved = await db
      .prepare('select status, moderated_at from comments where id = ?1')
      .bind(reply.id)
      .first<{ status: string; moderated_at: number | null }>()
    expect(moved).toEqual({ status: 'spam', moderated_at: t0 + 30 })
  })

  // The root is returned whatever its own status, or setCommentStatus would raise
  // NoSuchCommentError on a comment that is simply already in that status — and the
  // endpoint would turn that into a 404 for a comment that plainly exists.
  it('still answers when the comment is already in the status asked for', async () => {
    const { root } = await seedRootAndReply()
    await setCommentStatus(db, root.id, 'spam', t0 + 30)

    const decision = await setCommentStatus(db, root.id, 'spam', t0 + 40)

    expect(decision.id).toBe(root.id)
    expect(decision.status).toBe('spam')
    expect(decision.cascaded).toBe(0)
  })

  it('never shows a reply whose parent is still waiting for review', async () => {
    const thread = await seedThread()
    const root = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Root',
      body: 'still in the queue',
      bodyHash: 'h1',
      now: t0,
    })
    const reply = await insertComment(db, {
      threadId: thread.id,
      parentId: root.id,
      authorName: 'Replier',
      body: 'approved before its parent was',
      bodyHash: 'h2',
      now: t0 + 10,
    })
    await setCommentStatus(db, reply.id, 'approved', t0 + 20)

    const { comments } = await listPageComments(db, thread.pageKey)

    expect(comments).toEqual([])
  })

  it('does not approve the replies when the parent is approved — each is judged alone', async () => {
    const thread = await seedThread()
    const root = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Root',
      body: 'a root comment',
      bodyHash: 'h1',
      now: t0,
    })
    const reply = await insertComment(db, {
      threadId: thread.id,
      parentId: root.id,
      authorName: 'Replier',
      body: 'an unreviewed reply',
      bodyHash: 'h2',
      now: t0 + 10,
    })

    await setCommentStatus(db, root.id, 'approved', t0 + 20)
    const { comments } = await listPageComments(db, thread.pageKey)

    expect(comments.map((comment) => comment.id)).toEqual([root.id])
    expect(comments.map((comment) => comment.id)).not.toContain(reply.id)
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

    const { comments: queue } = await listModerationQueue(db, 'pending', { limit: 50 })

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
