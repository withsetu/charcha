import { beforeEach, describe, expect, it } from 'vitest'
import { getOrCreateThread, insertComment } from '../../../src/db'
import { hashIp } from '../../../src/spam/ip'
import {
  DEFAULT_MAX_PER_IP,
  DEFAULT_MAX_PER_PAGE,
  DEFAULT_WINDOW_SECONDS,
  rateLimitLayer,
} from '../../../src/spam/rate-limit'
import { contextFor, db, t0 } from './context'

const IP_SECRET = 'a-per-deployment-secret'
const COMMENTER_IP = '198.51.100.7'

const layer = rateLimitLayer({ ipSecret: IP_SECRET })

/**
 * Seeds one already-stored comment. Rate limiting reads history the pipeline
 * wrote, so the fixture writes through the same data layer the pipeline uses.
 */
async function seed(options: { at: number; ip?: string | null; pageKey?: string }) {
  const thread = await getOrCreateThread(db, {
    pageKey: options.pageKey ?? '/notes/leaving',
    now: t0,
  })
  const ipHash = options.ip === null ? null : await hashIp(options.ip ?? COMMENTER_IP, IP_SECRET)
  await insertComment(db, {
    threadId: thread.id,
    authorName: 'Someone',
    body: `a stored comment ${Math.random()}`,
    bodyHash: `hash-${Math.random()}`,
    ipHash,
    now: options.at,
  })
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

describe('layer 4 — rate limiting, per IP', () => {
  it('allows a commenter who is under the limit', async () => {
    for (let i = 0; i < DEFAULT_MAX_PER_IP - 1; i++) await seed({ at: t0 - 60 })

    expect(await layer.run(contextFor())).toBeNull()
  })

  it('rejects the submission that would take the IP past the limit', async () => {
    for (let i = 0; i < DEFAULT_MAX_PER_IP; i++) await seed({ at: t0 - 60 })

    expect((await layer.run(contextFor()))?.action).toBe('reject')
  })

  it('counts only inside the window, so yesterday cannot lock someone out today', async () => {
    for (let i = 0; i < DEFAULT_MAX_PER_IP + 5; i++)
      await seed({ at: t0 - DEFAULT_WINDOW_SECONDS - 1 })

    expect(await layer.run(contextFor())).toBeNull()
  })

  it('counts a different IP separately, so one flooder cannot silence a whole office', async () => {
    for (let i = 0; i < DEFAULT_MAX_PER_IP + 5; i++) await seed({ at: t0 - 60, ip: '203.0.113.9' })

    expect(await layer.run(contextFor())).toBeNull()
  })

  it('counts the same IP across different pages — the limit is on the person, not the thread', async () => {
    for (let i = 0; i < DEFAULT_MAX_PER_IP; i++)
      await seed({ at: t0 - 60, pageKey: `/notes/other-${i}` })

    expect((await layer.run(contextFor()))?.action).toBe('reject')
  })

  it('does not count comments whose ip_hash the retention janitor already purged', async () => {
    for (let i = 0; i < DEFAULT_MAX_PER_IP + 5; i++) await seed({ at: t0 - 60, ip: null })

    expect(await layer.run(contextFor())).toBeNull()
  })

  it('abstains on the IP half when no hashing secret is configured, rather than guessing', async () => {
    for (let i = 0; i < DEFAULT_MAX_PER_IP; i++) await seed({ at: t0 - 60 })
    const unkeyed = rateLimitLayer({})

    expect(await unkeyed.run(contextFor())).toBeNull()
  })

  it('abstains on the IP half when the request carries no client IP', async () => {
    for (let i = 0; i < DEFAULT_MAX_PER_IP; i++) await seed({ at: t0 - 60 })

    expect(await layer.run(contextFor({ ip: null }))).toBeNull()
  })

  it('never puts the IP or its hash in the reason it hands back', async () => {
    for (let i = 0; i < DEFAULT_MAX_PER_IP; i++) await seed({ at: t0 - 60 })

    const outcome = await layer.run(contextFor())
    const hash = await hashIp(COMMENTER_IP, IP_SECRET)
    expect(outcome?.reason).not.toContain(COMMENTER_IP)
    expect(outcome?.reason).not.toContain(hash)
  })
})

describe('layer 4 — rate limiting, per thread', () => {
  it('rejects once a page is taking comments faster than a conversation does', async () => {
    // The circuit breaker: no single IP is over its limit, but the thread itself
    // is being flooded from many addresses.
    for (let i = 0; i < DEFAULT_MAX_PER_PAGE; i++) await seed({ at: t0 - 60, ip: `203.0.113.${i}` })

    expect((await layer.run(contextFor()))?.action).toBe('reject')
  })

  it('counts comments the janitor purged, because the thread limit does not need an IP', async () => {
    for (let i = 0; i < DEFAULT_MAX_PER_PAGE; i++) await seed({ at: t0 - 60, ip: null })

    expect((await layer.run(contextFor()))?.action).toBe('reject')
  })

  it('counts only this page, so a busy thread cannot close the rest of the site', async () => {
    for (let i = 0; i < DEFAULT_MAX_PER_PAGE + 5; i++)
      await seed({ at: t0 - 60, ip: null, pageKey: '/notes/somewhere-else' })

    expect(await layer.run(contextFor())).toBeNull()
  })

  it('counts only inside the window', async () => {
    for (let i = 0; i < DEFAULT_MAX_PER_PAGE + 5; i++)
      await seed({ at: t0 - DEFAULT_WINDOW_SECONDS - 1, ip: null })

    expect(await layer.run(contextFor())).toBeNull()
  })
})

describe('layer 4 — the query budget', () => {
  it('costs a fixed two reads however many comments the page already has', async () => {
    // The D1 free tier throws past 50 queries in one invocation, so a per-comment
    // query is a ceiling rather than a slowdown. Both halves are counts, not scans.
    for (let i = 0; i < 20; i++) await seed({ at: t0 - 60, ip: `203.0.113.${i}` })

    const statements: string[] = []
    const counting = {
      ...db,
      prepare(sql: string) {
        statements.push(sql)
        return db.prepare(sql)
      },
    } as unknown as D1Database

    await layer.run({ ...contextFor(), db: counting })

    expect(statements).toHaveLength(2)
  })
})
