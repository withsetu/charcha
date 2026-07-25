// Issue #99 — what layer 4 says about itself, as opposed to what it decides.
//
// #77 (refs #65) made the pipeline write `comments.ip_hash` and nothing updated
// this layer's announcements, so a working per-IP guard went on reporting itself
// disabled — to the one audience that can act on it. That survived a PR because
// every existing test asserts the layer's *verdict*, and an announcement can go
// false without a verdict changing at all. These assertions close that gap.
//
// **A separate file on purpose.** `announceOnce` memoises per isolate
// (src/spam/log.ts), so a stale line emitted by an earlier test in the same file
// would be suppressed here and the absence assertions below would pass without
// meaning anything. A file of its own is a module graph of its own, and therefore
// a cold announcement set.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOrCreateThread, insertComment } from '../../../src/db'
import { hashIp } from '../../../src/spam/ip'
import { DEFAULT_MAX_PER_IP, rateLimitLayer } from '../../../src/spam/rate-limit'
import { contextFor, db, t0 } from './context'

const IP_SECRET = 'a-per-deployment-secret'
const COMMENTER_IP = '198.51.100.7'

let lines: string[] = []

/** Seeds `count` stored comments from COMMENTER_IP, as the pipeline would. */
async function seedFromCommenter(count: number) {
  const thread = await getOrCreateThread(db, { pageKey: '/notes/leaving', now: t0 })
  const ipHash = await hashIp(COMMENTER_IP, IP_SECRET)
  for (let i = 0; i < count; i++) {
    await insertComment(db, {
      threadId: thread.id,
      authorName: `Reader ${i}`,
      body: `a stored comment ${i}`,
      bodyHash: `hash-${i}`,
      ipHash,
      now: t0 - 60,
    })
  }
}

/** The announcements written so far, parsed. */
function announcements(): Array<Record<string, unknown>> {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return {}
      }
    })
    .filter((record) => record.event === 'spam_config')
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('layer 4 — what it announces about the per-IP half', () => {
  it('says nothing about being disabled when it is configured and enforcing', async () => {
    // The regression #99 records. A deployment with the secret set, behind an edge
    // that supplies CF-Connecting-IP, has a working per-IP limit — so any line
    // claiming otherwise sends the owner looking for a fix that already shipped.
    await seedFromCommenter(DEFAULT_MAX_PER_IP)
    const layer = rateLimitLayer({ ipSecret: IP_SECRET })

    const outcome = await layer.run(contextFor({ ip: COMMENTER_IP }))

    // Without this the test could pass by never reaching the per-IP half at all.
    expect(outcome?.action).toBe('reject')
    expect(announcements().filter((record) => record.half === 'per-ip')).toEqual([])

    // And the wording, on the same run rather than in a test of its own: #65
    // shipped in #77, so a line naming it as outstanding is false whatever shape
    // the record takes. It has to be asserted here because `announceOnce` would
    // memoise the line away from any later test in this file.
    const written = lines.join('\n')
    expect(written).not.toContain('#65')
    expect(written).not.toContain('ip_hash yet')
  })

  it('still announces the half as off when no hashing secret is configured', async () => {
    // The announcements that remain true, and the reason the layer announces at
    // all: an owner who never ran `wrangler secret put IP_HASH_SECRET` has no other
    // way to learn that half of layer 4 is abstaining.
    const layer = rateLimitLayer({})

    await layer.run(contextFor({ ip: COMMENTER_IP }))

    const record = announcements().find((entry) => entry.half === 'per-ip')
    expect(record?.enabled).toBe(false)
    expect(record?.reason).toBe('no IP_HASH_SECRET')
  })

  it('still announces the half as off when the edge supplies no client IP', async () => {
    const layer = rateLimitLayer({ ipSecret: IP_SECRET })

    await layer.run(contextFor({ ip: null }))

    const record = announcements().find((entry) => entry.half === 'per-ip')
    expect(record?.enabled).toBe(false)
    expect(record?.reason).toBe('no CF-Connecting-IP')
  })
})
