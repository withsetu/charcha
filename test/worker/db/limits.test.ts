import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { getOrCreateThread, insertComment } from '../../../src/db'

const db = env.DB
const t0 = 1_753_300_000

// The request boundary is not the only writer — the Disqus importer in #15 writes
// here too, and so will any future backfill. Card rule 5 is size caps everywhere,
// so the caps live in the schema and not only in the handler that happens to be
// in front of it today.

let threadId: number

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  const thread = await getOrCreateThread(db, { pageKey: '/limits', now: t0 })
  threadId = thread.id
})

function comment(overrides: { authorName?: string; body?: string; authorEmail?: string }) {
  return insertComment(db, {
    threadId,
    authorName: overrides.authorName ?? 'Rahul Kanwar',
    authorEmail: overrides.authorEmail ?? null,
    body: overrides.body ?? 'a comment',
    bodyHash: 'h1',
    now: t0,
  })
}

describe('size caps', () => {
  it('refuses a comment body beyond 10,000 characters', async () => {
    await expect(comment({ body: 'x'.repeat(10_001) })).rejects.toThrow(/CHECK constraint/i)
  })

  it('accepts a comment body at exactly the cap', async () => {
    await expect(comment({ body: 'x'.repeat(10_000) })).resolves.toBeDefined()
  })

  it('refuses an empty comment body', async () => {
    await expect(comment({ body: '' })).rejects.toThrow(/CHECK constraint/i)
  })

  it('refuses an author name beyond 80 characters', async () => {
    await expect(comment({ authorName: 'n'.repeat(81) })).rejects.toThrow(/CHECK constraint/i)
  })

  it('refuses an empty author name', async () => {
    await expect(comment({ authorName: '' })).rejects.toThrow(/CHECK constraint/i)
  })

  it('refuses an email beyond the RFC maximum of 254 characters', async () => {
    const local = 'a'.repeat(243)
    await expect(comment({ authorEmail: `${local}@example.com` })).rejects.toThrow(
      /CHECK constraint/i,
    )
  })

  it('refuses a page key beyond 512 characters', async () => {
    await expect(
      getOrCreateThread(db, { pageKey: `/${'p'.repeat(512)}`, now: t0 }),
    ).rejects.toThrow(/CHECK constraint/i)
  })

  it('refuses a page title beyond 300 characters', async () => {
    await expect(
      getOrCreateThread(db, { pageKey: '/long-title', title: 't'.repeat(301), now: t0 }),
    ).rejects.toThrow(/CHECK constraint/i)
  })
})
