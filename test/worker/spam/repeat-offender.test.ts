// Layer 5 — the commenter the owner has already marked spam (#184).
//
// The verdict mapping is the subject: which tier holds and which tier refuses, and that
// the loose tier can never reach the refusal. It is the only layer that can refuse on
// identity alone, so the tests that matter most here are the ones that pin the *ceiling*
// on a loose match rather than the ones that prove a spammer is caught.

import { beforeEach, describe, expect, it } from 'vitest'
import { hashIp } from '../../../src/spam/ip'
import { repeatOffenderLayer } from '../../../src/spam/repeat-offender'
import { contextFor, db, t0 } from './context'

const IP_SECRET = 'a-per-deployment-secret'
const SPAMMER_IP = '198.51.100.7'
const SOMEONE_ELSE_IP = '203.0.113.42'
const SPAMMER = 'buy@pills.example'

const layer = repeatOffenderLayer({ ipSecret: IP_SECRET })

let threadId: number

/** A comment the owner has judged, written straight to the table as they left it. */
async function judged(input: {
  ip?: string
  email?: string | null
  status?: string
  byOwner?: boolean
}): Promise<void> {
  const ipHash = await hashIp(input.ip ?? SPAMMER_IP, IP_SECRET)
  await db
    .prepare(
      `insert into comments (thread_id, author_name, author_email, body, body_hash, status,
                             by_owner, ip_hash, created_at)
       values (?1, 'Someone', ?2, 'Cheap pills, click here.', 'hash', ?3, ?4, ?5, ?6)`,
    )
    .bind(
      threadId,
      input.email === undefined ? SPAMMER : input.email,
      input.status ?? 'spam',
      input.byOwner === true ? 1 : 0,
      ipHash,
      t0 - 86_400,
    )
    .run()
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')

  const thread = await db
    .prepare(
      `insert into threads (page_key, created_at, updated_at) values ('/notes/leaving', ?1, ?1)
       returning id`,
    )
    .bind(t0)
    .first<{ id: number }>()
  if (thread === null) throw new Error('fixture thread was not stored')
  threadId = thread.id
})

describe('a commenter with no history', () => {
  it('is not this layer’s business, and costs it no opinion', async () => {
    expect(await layer.run(contextFor({ ip: SPAMMER_IP, authorEmail: SPAMMER }))).toBeNull()
  })

  it('is still not, when somebody else entirely has been marked spam', async () => {
    await judged({ ip: SOMEONE_ELSE_IP })

    expect(await layer.run(contextFor({ ip: SPAMMER_IP, authorEmail: SPAMMER }))).toBeNull()
  })
})

describe('the strict tier — the identity #173 settled', () => {
  it('holds the commenter the owner marked spam, arriving again from the same address', async () => {
    // The reason is what the strict tier buys — `known-spammer` rather than
    // `address-refused-before` — and it is all it buys. See the ceiling test below for
    // why the verdict is not a refusal.
    await judged({})

    expect(await layer.run(contextFor({ ip: SPAMMER_IP, authorEmail: SPAMMER }))).toEqual({
      action: 'review',
      reason: 'known-spammer',
    })
  })

  it('lets the owner take it back by approving the comment they condemned', async () => {
    await judged({})
    await db.prepare(`update comments set status = 'approved'`).run()

    expect(await layer.run(contextFor({ ip: SPAMMER_IP, authorEmail: SPAMMER }))).toBeNull()
  })
})

describe('the loose tier — the address alone', () => {
  it('holds a stranger who shares the address, and says so as an address', async () => {
    // The cost of the looser match, asserted rather than described. Someone behind the
    // same NAT, or whoever the ISP hands the address to next, is held — and the reason
    // the moderator reads names the address rather than the person, because that is all
    // this tier knows.
    await judged({})

    expect(
      await layer.run(contextFor({ ip: SPAMMER_IP, authorEmail: 'priya@example.com' })),
    ).toEqual({ action: 'review', reason: 'address-refused-before' })
  })

  it('holds a comment with no email at all, at the address tier', async () => {
    await judged({})

    expect(await layer.run(contextFor({ ip: SPAMMER_IP }))).toEqual({
      action: 'review',
      reason: 'address-refused-before',
    })
  })

  it('treats a blank email as no email, so a blank cannot be an identity', async () => {
    // `''` would match every other comment stored with one, which is the argument
    // src/submit/pipeline.ts already makes on the trust path. Unreachable through the
    // schema today; asserted because the failure would be borne by strangers.
    await judged({ email: '' })

    expect(await layer.run(contextFor({ ip: SPAMMER_IP, authorEmail: '' }))).toEqual({
      action: 'review',
      reason: 'address-refused-before',
    })
  })

  it('says nothing at all on a stolen email address alone', async () => {
    // The forgery the strict identity exists to stop, run against this layer rather
    // than against the lookup: the spam row is somebody else's address, so knowing the
    // email buys nothing at all here — not even a hold.
    await judged({ ip: SOMEONE_ELSE_IP })

    expect(await layer.run(contextFor({ ip: SPAMMER_IP, authorEmail: SPAMMER }))).toBeNull()
  })
})

describe('the ceiling — this layer holds, and never refuses', () => {
  it('cannot be made to refuse anybody, on either tier (#184)', async () => {
    // **The single most important assertion in this file**, and the one the design
    // argument rests on. The owner's spam decision is about a *comment*, and anybody can
    // write a comment carrying anybody's email — so on a shared address an attacker can
    // post spam as a victim, wait for the owner to do their job, and thereby aim the
    // owner's own moderation at them. Were either tier a `reject`, that victim's
    // comments would then be refused with a bare 403, unstored and unqueued, invisible
    // to both of them until #19 purged the hash.
    //
    // A refusal here would have bought one row write, which layer 4 already bounds. So
    // the ceiling is `review`, and it is asserted over every shape of history rather
    // than only the one a spammer produces.
    await judged({})
    await judged({ email: null })
    await judged({ ip: SOMEONE_ELSE_IP })

    const outcomes = await Promise.all([
      layer.run(contextFor({ ip: SPAMMER_IP, authorEmail: SPAMMER })),
      layer.run(contextFor({ ip: SPAMMER_IP, authorEmail: 'priya@example.com' })),
      layer.run(contextFor({ ip: SPAMMER_IP })),
      layer.run(contextFor({ ip: SOMEONE_ELSE_IP, authorEmail: SPAMMER })),
    ])

    expect(outcomes.map((outcome) => outcome?.action ?? 'no opinion')).toEqual([
      'review',
      'review',
      'review',
      'review',
    ])
  })
})

describe('what the layer will not do', () => {
  it('says nothing on a deployment with no IP_HASH_SECRET, rather than guessing', async () => {
    await judged({})
    const unkeyed = repeatOffenderLayer({})

    expect(await unkeyed.run(contextFor({ ip: SPAMMER_IP, authorEmail: SPAMMER }))).toBeNull()
  })

  it('says nothing when the edge gave no address', async () => {
    await judged({})

    expect(await layer.run(contextFor({ ip: null, authorEmail: SPAMMER }))).toBeNull()
  })

  it('spends no database read when it cannot recognise anybody', async () => {
    // The ordering argument in miniature: an unconfigured deployment must not pay for a
    // layer that cannot answer. Both halves of the guard are free, and they come first.
    const statements: string[] = []
    const counting = {
      ...db,
      prepare(sql: string) {
        statements.push(sql)
        return db.prepare(sql)
      },
    } as unknown as D1Database
    const unkeyed = repeatOffenderLayer({})

    await unkeyed.run({ ...contextFor({ ip: SPAMMER_IP }), db: counting })

    expect(statements).toHaveLength(0)
  })

  it('costs exactly one read for a commenter with a long history of refusals', async () => {
    // The rule CLAUDE.md states — a constant query count, not a low one. Twenty
    // condemned comments from one address must cost the same one statement as one.
    for (let i = 0; i < 20; i++) await judged({})

    const statements: string[] = []
    const counting = {
      ...db,
      prepare(sql: string) {
        statements.push(sql)
        return db.prepare(sql)
      },
    } as unknown as D1Database

    const outcome = await layer.run({
      ...contextFor({ ip: SPAMMER_IP, authorEmail: SPAMMER }),
      db: counting,
    })

    // One *statement*, which is what this asserts and all it asserts. The aggregate
    // still walks one `comments_by_spam_origin` entry per condemned comment — index
    // entries, never rows, and bounded by the owner's own clicking rather than by
    // anything the caller does. See SPAM_HISTORY_SQL in src/db/index.ts.
    expect(outcome?.reason).toBe('known-spammer')
    expect(statements).toHaveLength(1)
  })

  it('ignores a comment the owner wrote themselves', async () => {
    await judged({ byOwner: true })

    expect(await layer.run(contextFor({ ip: SPAMMER_IP, authorEmail: SPAMMER }))).toBeNull()
  })
})
