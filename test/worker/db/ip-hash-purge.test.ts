import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_IP_HASH_RETENTION_DAYS,
  IP_HASH_RETENTION_SETTING,
  getIpHashRetentionDays,
  getOrCreateThread,
  insertComment,
  purgeExpiredIpHashes,
} from '../../../src/db'

const db = env.DB
const DAY = 86_400
// A fixed "now" so the window boundary is exact and not read from the clock.
const now = 1_753_300_000

async function seedThread() {
  return getOrCreateThread(db, { pageKey: '/notes/retention', now: now - 400 * DAY })
}

async function seedComment(ageDays: number, ipHash: string | null): Promise<number> {
  const thread = await seedThread()
  const comment = await insertComment(db, {
    threadId: thread.id,
    authorName: 'Commenter',
    body: `posted ${ageDays} days before now`,
    bodyHash: `h-${ageDays}-${ipHash ?? 'null'}-${Math.random()}`,
    ipHash,
    now: now - ageDays * DAY,
  })
  return comment.id
}

async function ipHashOf(id: number): Promise<string | null> {
  const row = await db
    .prepare('select ip_hash from comments where id = ?1')
    .bind(id)
    .first<{ ip_hash: string | null }>()
  return row?.ip_hash ?? null
}

async function setSetting(value: string) {
  await db
    .prepare(
      `insert into settings (key, value, updated_at) values (?1, ?2, ?3)
       on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(IP_HASH_RETENTION_SETTING, value, now)
    .run()
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  await db.exec('DELETE FROM settings')
})

describe('purgeExpiredIpHashes', () => {
  it('nulls ip_hash on a comment older than the window', async () => {
    const old = await seedComment(40, 'ip-of-an-old-comment')

    await purgeExpiredIpHashes(db, now, 30)

    // Read back, not just "the query ran": the column must actually be NULL, or the
    // IP-derived identifier still lives in the table. This is the whole point of #19.
    expect(await ipHashOf(old)).toBeNull()
  })

  it('leaves ip_hash on a comment still inside the window', async () => {
    const recent = await seedComment(10, 'ip-of-a-recent-comment')

    await purgeExpiredIpHashes(db, now, 30)

    // The kill-shot for the age predicate: a purge that nulls recent rows destroys
    // the rate-limiting signal the column exists for. Break `created_at < cutoff`
    // and this is the test that fails.
    expect(await ipHashOf(recent)).toBe('ip-of-a-recent-comment')
  })

  it('keeps a comment exactly at the cutoff, since the window is "older than", not "as old as"', async () => {
    const atCutoff = await seedComment(30, 'ip-at-the-boundary')

    await purgeExpiredIpHashes(db, now, 30)

    expect(await ipHashOf(atCutoff)).toBe('ip-at-the-boundary')
  })

  it('touches only ip_hash, never the body, status, author or timestamp of a purged row', async () => {
    const thread = await seedThread()
    const old = await insertComment(db, {
      threadId: thread.id,
      authorName: 'Rahul Kanwar',
      body: 'a real comment that must survive the purge intact',
      bodyHash: 'body-hash-kept',
      ipHash: 'ip-to-purge',
      now: now - 40 * DAY,
    })

    await purgeExpiredIpHashes(db, now, 30)

    const row = await db
      .prepare(
        'select author_name, body, body_hash, status, created_at, ip_hash from comments where id = ?1',
      )
      .bind(old.id)
      .first<{
        author_name: string
        body: string
        body_hash: string
        status: string
        created_at: number
        ip_hash: string | null
      }>()
    expect(row).toEqual({
      author_name: 'Rahul Kanwar',
      body: 'a real comment that must survive the purge intact',
      body_hash: 'body-hash-kept',
      status: 'pending',
      created_at: now - 40 * DAY,
      ip_hash: null,
    })
  })

  it('reports how many rows it purged', async () => {
    await seedComment(40, 'ip-1')
    await seedComment(50, 'ip-2')
    await seedComment(10, 'ip-recent')

    const result = await purgeExpiredIpHashes(db, now, 30)

    // A silent no-op leaves PII in the database invisibly (#19). The count is what a
    // structured log line reports, so the scheduled run has evidence it did work.
    expect(result.purged).toBe(2)
    expect(result.retentionDays).toBe(30)
    expect(result.cutoff).toBe(now - 30 * DAY)
  })

  it('is idempotent: a second run purges nothing and changes nothing', async () => {
    const old = await seedComment(40, 'ip-to-purge')

    const first = await purgeExpiredIpHashes(db, now, 30)
    const second = await purgeExpiredIpHashes(db, now, 30)

    expect(first.purged).toBe(1)
    expect(second.purged).toBe(0)
    expect(await ipHashOf(old)).toBeNull()
  })

  it('does not count rows whose ip_hash was already null', async () => {
    await seedComment(40, null)

    const result = await purgeExpiredIpHashes(db, now, 30)

    expect(result.purged).toBe(0)
  })
})

describe('getIpHashRetentionDays', () => {
  it('falls back to the default when the owner has set nothing', async () => {
    expect(await getIpHashRetentionDays(db)).toBe(DEFAULT_IP_HASH_RETENTION_DAYS)
  })

  it('returns the window the owner configured, so it changes without a redeploy', async () => {
    await setSetting('7')

    expect(await getIpHashRetentionDays(db)).toBe(7)
  })

  it('falls back to the default when the stored value is not a positive whole number of days', async () => {
    for (const bad of ['0', '-5', 'soon', '30.5', '']) {
      await setSetting(bad)
      expect(await getIpHashRetentionDays(db)).toBe(DEFAULT_IP_HASH_RETENTION_DAYS)
    }
  })
})
