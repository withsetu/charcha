import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_SPAM_REASON_LENGTH,
  getOrCreateThread,
  insertComment,
  listModerationQueue,
} from '../../../src/db'

const db = env.DB
const t0 = 1_753_300_000

let threadId: number

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  const thread = await getOrCreateThread(db, { pageKey: '/held', now: t0 })
  threadId = thread.id
})

function comment(overrides: Partial<Parameters<typeof insertComment>[1]> = {}) {
  return insertComment(db, {
    threadId,
    authorName: 'Rahul Kanwar',
    body: 'The part people underestimate is the export.',
    bodyHash: 'h1',
    now: t0,
    ...overrides,
  })
}

describe('the reason a comment was held', () => {
  it('reaches the queue, so the human gate is told why it is being asked', async () => {
    await comment({ spamReason: 'turnstile: unreachable' })

    const page = await listModerationQueue(db, 'pending')

    expect(page.comments[0]?.spamReason).toBe('turnstile: unreachable')
  })

  it('is null for a comment no layer doubted, so clean and held are distinguishable', async () => {
    await comment()

    const page = await listModerationQueue(db, 'pending')

    expect(page.comments[0]?.spamReason).toBeNull()
  })

  it('is never invented from an empty string, which would read as a held comment', async () => {
    await comment({ spamReason: '' })

    const page = await listModerationQueue(db, 'pending')

    expect(page.comments[0]?.spamReason).toBeNull()
  })

  it('is never invented from whitespace either', async () => {
    await comment({ spamReason: '   ' })

    const page = await listModerationQueue(db, 'pending')

    expect(page.comments[0]?.spamReason).toBeNull()
  })
})

describe('a reason longer than the column allows', () => {
  // `turnstile: <error-codes>` is built from a JSON array in a siteverify
  // response, which is a third party's payload and of no bounded length. Card
  // rule 5 applies to it exactly as it applies to a comment body.

  it('is truncated rather than allowed to fail the whole insert', async () => {
    const stored = await comment({ spamReason: 'x'.repeat(MAX_SPAM_REASON_LENGTH + 500) })

    const row = await db
      .prepare('select spam_reason from comments where id = ?1')
      .bind(stored.id)
      .first<{ spam_reason: string | null }>()
    expect(row?.spam_reason).toHaveLength(MAX_SPAM_REASON_LENGTH)
  })

  it('does not cost the reader their comment', async () => {
    const stored = await comment({ spamReason: 'x'.repeat(MAX_SPAM_REASON_LENGTH + 500) })

    expect(stored.id).toBeGreaterThan(0)
  })

  it('is refused by the schema for a caller that did not truncate — the importer included', async () => {
    // The data layer truncates; this is the backstop under it. A CHECK that does
    // not fire here means the column would take whatever a third party sent.
    await expect(
      db
        .prepare(
          `insert into comments (thread_id, author_name, body, body_hash, created_at, spam_reason)
           values (?1, 'Someone', 'body', 'h2', ?2, ?3)`,
        )
        .bind(threadId, t0, 'x'.repeat(MAX_SPAM_REASON_LENGTH + 1))
        .run(),
    ).rejects.toThrow()
  })
})
