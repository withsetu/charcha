// How many comments sit in each status (#135).
//
// The tabs claim a number, so the number has to be the database's answer and not the
// length of whatever page happens to be loaded. The plan this read is allowed to have
// is asserted separately, in test/worker/db/query-plan.test.ts.

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  countCommentsByStatus,
  getOrCreateThread,
  insertComment,
  setCommentStatus,
} from '../../../src/db'

const db = env.DB
const t0 = 1_753_300_000

let threadId: number

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  const thread = await getOrCreateThread(db, { pageKey: '/counts', now: t0 })
  threadId = thread.id
})

let next = 0

function comment(overrides: Partial<Parameters<typeof insertComment>[1]> = {}) {
  next += 1
  return insertComment(db, {
    threadId,
    authorName: `Commenter ${String(next)}`,
    body: `comment ${String(next)}`,
    bodyHash: `h${String(next)}`,
    now: t0 + next,
    ...overrides,
  })
}

describe('the per-status comment counts', () => {
  it('answers zero for every status on an empty database', async () => {
    // Not an empty object. `group by` returns no row for a status nothing is in, and a
    // missing key renders as `undefined` in a tab — so the zero fill is the contract
    // rather than a tidiness: an empty queue is a success state, and `Pending 0` is how
    // it says so.
    expect(await countCommentsByStatus(db)).toEqual({
      pending: 0,
      approved: 0,
      spam: 0,
      deleted: 0,
    })
  })

  it('counts each status separately', async () => {
    const first = await comment()
    const second = await comment()
    await comment()
    await comment()
    await setCommentStatus(db, first.id, 'approved', t0 + 100)
    await setCommentStatus(db, second.id, 'spam', t0 + 100)

    expect(await countCommentsByStatus(db)).toEqual({
      pending: 2,
      approved: 1,
      spam: 1,
      deleted: 0,
    })
  })

  it('follows a decision, including the replies it cascades over', async () => {
    // The reason the dashboard cannot keep its own tally by adding and subtracting one
    // per decision. setCommentStatus hides the replies under a comment as well as the
    // comment, so marking one root spam moved four comments here, not one — and a
    // client-side counter would be wrong by three with nothing to reveal it.
    const root = await comment()
    await setCommentStatus(db, root.id, 'approved', t0 + 100)
    await comment({ parentId: root.id })
    await comment({ parentId: root.id })
    await comment({ parentId: root.id })

    expect(await countCommentsByStatus(db)).toEqual({
      pending: 3,
      approved: 1,
      spam: 0,
      deleted: 0,
    })

    await setCommentStatus(db, root.id, 'spam', t0 + 200)

    expect(await countCommentsByStatus(db)).toEqual({
      pending: 0,
      approved: 0,
      spam: 4,
      deleted: 0,
    })
  })
})
