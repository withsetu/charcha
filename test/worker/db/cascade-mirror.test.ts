// The one place the dashboard's idea of the cascade and the statement that performs it
// are held against each other (#133).
//
// The dashboard removes a comment's replies from the list the moment a decision starts,
// because the server hides them and a list that keeps them shows comments the server no
// longer holds — with live Approve buttons on them. That removal is a *guess* about what
// MODERATE_SQL will do, and nothing typechecks a TypeScript predicate against a SQL
// string: change the statement to cascade on a third status and every dashboard test
// stays green while the screen silently stops matching the database.
//
// So the agreement is asserted, and it is asserted here rather than in test/dashboard
// because this is the project that can import both — the dashboard's tsconfig knows
// nothing of src/db, and src/dashboard/queue.ts is a pure reducer with no DOM in it.
//
// It runs the statement rather than only reading it, so a predicate that agrees with the
// text and disagrees with SQLite still fails.

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

import { getOrCreateThread, insertComment, setCommentStatus } from '../../../src/db'
import type { CommentStatus } from '../../../src/db'
import { cascadesToReplies } from '../../../src/dashboard/queue'
import type { DecisionStatus } from '../../../src/dashboard/api'

const db = env.DB
const t0 = 1_753_300_000

/** The three the queue's buttons and keys offer, which is what the reducer sees. */
const DECISIONS: readonly DecisionStatus[] = ['approved', 'spam', 'deleted']

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

async function seedRootAndReply(status: CommentStatus) {
  const thread = await getOrCreateThread(db, { pageKey: `/notes/${status}`, now: t0 })
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
    body: 'a reply',
    bodyHash: `reply-${status}`,
    now: t0 + 10,
  })
  return { root, reply }
}

describe('the dashboard and the statement agree about which decisions cascade', () => {
  it.each(DECISIONS)('%s', async (status) => {
    const { root, reply } = await seedRootAndReply(status)

    const decision = await setCommentStatus(db, root.id, status, t0 + 20)
    const stored = await db
      .prepare('select status from comments where id = ?1')
      .bind(reply.id)
      .first<{ status: string }>()

    const serverCascaded = stored?.status === status
    expect(serverCascaded).toBe(cascadesToReplies(status))
    // And the count the moderator is shown agrees with the same fact, so the sentence
    // "and 1 reply" cannot appear over a decision that moved nothing.
    expect(decision.cascaded).toBe(cascadesToReplies(status) ? 1 : 0)
  })
})
