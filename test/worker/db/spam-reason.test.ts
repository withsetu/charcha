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
    // The data layer bounds the value; this is the backstop under it. A CHECK that
    // does not fire here means the column would take whatever a third party sent.
    await expect(insertDirectly('x'.repeat(MAX_SPAM_REASON_LENGTH + 1))).rejects.toThrow()
  })

  it('is refused by the schema even when a NUL byte hides its length', async () => {
    // The hole a review found. SQLite's length() on text "returns the number of
    // characters prior to the first NUL character", so this value measured 1 and a
    // text-length CHECK admitted five kilobytes — against a column whose whole
    // reason for a cap is a JSON array from a third party, and JSON can carry an
    // escaped NUL. The CHECK now measures a BLOB cast.
    await expect(insertDirectly(`a\u0000${'x'.repeat(5000)}`)).rejects.toThrow()
  })

  function insertDirectly(reason: string) {
    return db
      .prepare(
        `insert into comments (thread_id, author_name, body, body_hash, created_at, spam_reason)
           values (?1, 'Someone', 'body', 'h2', ?2, ?3)`,
      )
      .bind(threadId, t0, reason)
      .run()
  }
})

describe('a reason carrying bytes that are not text', () => {
  // Every one of these is reachable from siteverify's `error-codes`, which is a
  // third party's JSON array — so this is card rule 5 applied to a value that never
  // passed through a commenter's hands. The destination is a badge in the
  // moderator's own UI.

  async function storedReason(spamReason: string): Promise<string | null> {
    const stored = await comment({ spamReason })
    const row = await db
      .prepare('select spam_reason from comments where id = ?1')
      .bind(stored.id)
      .first<{ spam_reason: string | null }>()
    return row?.spam_reason ?? null
  }

  it('drops a NUL byte rather than storing it', async () => {
    expect(await storedReason('turnstile:\u0000unreachable')).toBe('turnstile:unreachable')
  })

  it('drops a newline, so one reason cannot look like two log lines', async () => {
    expect(await storedReason('turnstile: a\nfake: b')).toBe('turnstile: afake: b')
  })

  it('drops a bidi override, which would reorder the badge it is rendered in', async () => {
    expect(await storedReason('turnstile:\u202Eunreachable')).toBe('turnstile:unreachable')
  })

  it('is null when it was nothing but control characters', async () => {
    expect(await storedReason('\u0000\u0001\u007F')).toBeNull()
  })

  it('never leaves half of an astral character at the cut', async () => {
    // The cut counts UTF-16 units. A character outside the BMP landing on the
    // boundary would leave a lone surrogate bound as TEXT.
    const reason = `${'x'.repeat(MAX_SPAM_REASON_LENGTH - 1)}\u{1F600}`

    const stored = await storedReason(reason)

    expect(stored).toBe('x'.repeat(MAX_SPAM_REASON_LENGTH - 1))
    expect(/[\uD800-\uDFFF]/.test(stored ?? '')).toBe(false)
  })
})
