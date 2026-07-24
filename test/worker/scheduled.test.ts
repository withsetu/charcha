import { createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { IP_HASH_RETENTION_SETTING, getOrCreateThread, insertComment } from '../../src/db'

const db = env.DB
const DAY = 86_400

// The scheduled handler reads the wall clock for "now", so the fixtures are placed
// relative to the same clock the handler will read — decades of margin, so the
// sub-second gap between seeding and firing cannot move a row across the window.
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

async function seedComment(ageDays: number, ipHash: string): Promise<number> {
  const thread = await getOrCreateThread(db, {
    pageKey: '/scheduled',
    now: nowSeconds() - 500 * DAY,
  })
  const comment = await insertComment(db, {
    threadId: thread.id,
    authorName: 'Commenter',
    body: `posted ${ageDays} days ago`,
    bodyHash: `h-${ageDays}-${Math.random()}`,
    ipHash,
    now: nowSeconds() - ageDays * DAY,
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

async function fireCron() {
  // The handler awaits its own work, so there is nothing to wait on an
  // ExecutionContext for — the invocation is done when this promise resolves.
  const controller = createScheduledController({ scheduledTime: new Date(), cron: '0 4 * * *' })
  await worker.scheduled?.(controller, env)
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  await db.exec('DELETE FROM settings')
})

describe('the scheduled ip_hash purge, driven through the real Cron handler', () => {
  it('nulls ip_hash on comments past the default window and leaves recent ones', async () => {
    const old = await seedComment(400, 'ip-of-a-year-old-comment')
    const recent = await seedComment(1, 'ip-of-yesterday')

    await fireCron()

    expect(await ipHashOf(old)).toBeNull()
    expect(await ipHashOf(recent)).toBe('ip-of-yesterday')
  })

  it('honours a retention window the owner set in settings, without a redeploy', async () => {
    await db
      .prepare('insert into settings (key, value, updated_at) values (?1, ?2, ?3)')
      .bind(IP_HASH_RETENTION_SETTING, '7', nowSeconds())
      .run()
    const purgedByShorterWindow = await seedComment(10, 'ip-ten-days-old')
    const keptByShorterWindow = await seedComment(3, 'ip-three-days-old')

    await fireCron()

    // 10 days old is inside the default 30 but past the configured 7, so this only
    // clears if the handler actually read the setting rather than the constant.
    expect(await ipHashOf(purgedByShorterWindow)).toBeNull()
    expect(await ipHashOf(keptByShorterWindow)).toBe('ip-three-days-old')
  })

  it('fails loudly rather than reporting a clean run when the purge cannot run', async () => {
    const spy = vi.spyOn(db, 'prepare').mockImplementation(() => {
      throw new Error('D1 unavailable')
    })
    const controller = createScheduledController({ scheduledTime: new Date(), cron: '0 4 * * *' })

    // A swallowed failure here would mark the Cron run green while PII kept
    // accumulating — the exact silent-privacy-failure this guard exists to prevent.
    // The handler must reject, which is what marks the invocation failed.
    await expect(worker.scheduled?.(controller, env)).rejects.toThrow(/D1 unavailable/)
    spy.mockRestore()
  })
})
