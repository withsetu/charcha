// What layer 5 says about itself, as opposed to what it decides (#184).
//
// The same gap #99 found in layer 4: an announcement can go false without any verdict
// changing, so a guard that is quietly off — or one that is on and reporting itself off
// — survives every test that asserts an outcome. This layer is worth the file because it
// is the one whose whole answer depends on a secret a one-click deploy does not set.
//
// **A separate file on purpose.** `announceOnce` memoises per isolate
// (src/spam/log.ts), so a line emitted by an earlier test in the same file would be
// suppressed here and the absence assertions below would pass without meaning anything.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashIp } from '../../../src/spam/ip'
import { repeatOffenderLayer } from '../../../src/spam/repeat-offender'
import { contextFor, db, t0 } from './context'

const IP_SECRET = 'a-per-deployment-secret'
const SPAMMER_IP = '198.51.100.7'

let lines: string[] = []

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
    .filter((record) => record.event === 'spam_config' && record.layer === 'repeat-offender')
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

describe('a deployment with no IP_HASH_SECRET', () => {
  // One test and not two, because `announceOnce` memoises per isolate: a second test
  // asserting the line would see nothing, and a second asserting the memoisation would
  // pass on the first one's leftovers. Both properties are asserted here, in order.
  it('says once — and only once — that the layer is off, and which half is missing', async () => {
    const layer = repeatOffenderLayer({})
    await layer.run(contextFor({ ip: SPAMMER_IP }))

    expect(announcements()).toEqual([
      {
        event: 'spam_config',
        layer: 'repeat-offender',
        enabled: false,
        reason: 'no IP_HASH_SECRET',
      },
    ])

    // Three more comments from three more readers, and not a line between them: this is
    // per-deployment configuration, not per-comment news.
    await layer.run(contextFor({ ip: SPAMMER_IP }))
    await layer.run(contextFor({ ip: SPAMMER_IP }))
    await layer.run(contextFor({ ip: SPAMMER_IP }))

    expect(announcements()).toHaveLength(1)
  })
})

describe('a deployment the edge gave no address for', () => {
  it('says the layer is off for that reason rather than for the secret', async () => {
    await repeatOffenderLayer({ ipSecret: IP_SECRET }).run(contextFor({ ip: null }))

    expect(announcements()).toEqual([
      {
        event: 'spam_config',
        layer: 'repeat-offender',
        enabled: false,
        reason: 'no CF-Connecting-IP',
      },
    ])
  })
})

describe('a deployment where the layer is working', () => {
  it('says nothing at all, which is #99 — a working guard must not report itself off', async () => {
    // The exact bug that survived a PR on layer 4: the announcement sits immediately
    // before the code that hashes the address and reads the history, so a line on this
    // branch would tell the one audience that can act on it that a live guard is dead.
    const ipHash = await hashIp(SPAMMER_IP, IP_SECRET)
    const thread = await db
      .prepare(
        `insert into threads (page_key, created_at, updated_at) values ('/notes/leaving', ?1, ?1)
         returning id`,
      )
      .bind(t0)
      .first<{ id: number }>()
    await db
      .prepare(
        `insert into comments (thread_id, author_name, author_email, body, body_hash, status,
                               by_owner, ip_hash, created_at)
         values (?1, 'Someone', 'buy@pills.example', 'Cheap pills.', 'hash', 'spam', 0, ?2, ?3)`,
      )
      .bind(thread?.id, ipHash, t0 - 86_400)
      .run()

    const outcome = await repeatOffenderLayer({ ipSecret: IP_SECRET }).run(
      contextFor({ ip: SPAMMER_IP, authorEmail: 'buy@pills.example' }),
    )

    expect(outcome?.action).toBe('reject')
    expect(announcements()).toEqual([])
  })
})
