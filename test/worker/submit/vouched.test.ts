// `trust-vouched`, the third moderation policy. Designed on issue #189.
//
// The second place in the Worker where a stranger's comment can be published without
// a human seeing it — the first is `trust-returning` (test/worker/submit/trust.test.ts),
// and the two publish for entirely different reasons. `trust-returning` replays the
// owner's own past judgement about a *person*; this one acts on a real classifier's
// verdict about a *comment*. So the identity requirements that file is organised
// around do not apply here, and their absence is asserted rather than assumed.
//
// The spam check is stubbed, because what is under test is what `runSubmission` does
// with a verdict. That a provider only ever *produces* a vouch from a positive check
// — never from a failure, a timeout or being switched off — is
// test/worker/spam/vouch.test.ts, and it is the other half of this feature being safe.

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { MODERATION_POLICY_SETTING, writeSetting } from '../../../src/db'
import { readSiteSettings } from '../../../src/settings'
import { runSubmission } from '../../../src/submit/pipeline'
import type { SpamCheck, SpamVerdict } from '../../../src/submit/spam'

const db = env.DB
const t0 = 1_753_300_000
const IP_SECRET = 'a-per-deployment-hmac-key-for-the-tests'

const VOUCHED: SpamVerdict = { action: 'vouch', reason: 'provider: akismet' }
const ALLOWED: SpamVerdict = { action: 'allow' }
const HELD: SpamVerdict = { action: 'review', reason: 'content: links' }

function verdict(action: SpamVerdict): SpamCheck {
  return { check: () => Promise.resolve(action) }
}

let bodyCounter = 0

/**
 * One public submission, through the same two steps the route takes (#207): resolve every
 * settings row in one read, then run the pipeline with the policy that read produced.
 *
 * Written this way rather than passing a policy literal so that these tests still exercise
 * the row — the setting is what an owner edits, and a test that handed the pipeline the
 * answer directly would pass on a deployment where the row was never read.
 */
async function post(options: {
  verdict: SpamVerdict
  email?: string | null
  noIpSecret?: boolean
}) {
  bodyCounter += 1
  const email = options.email === undefined ? 'rahul@kanwar.example' : options.email
  const { moderationPolicy } = await readSiteSettings(db, {})
  return runSubmission(
    {
      authorName: 'Rahul Kanwar',
      body: `The part people underestimate is the export, take ${bodyCounter}.`,
      url: 'https://maya.build/notes/leaving',
      ...(email === null ? {} : { authorEmail: email }),
    },
    {
      db,
      spamCheck: verdict(options.verdict),
      request: new Request('https://charcha.example/comments', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.9' },
      }),
      now: t0,
      moderationPolicy,
      // Passed by default, so the identity the returning-commenter path needs actually
      // exists and the tests below distinguish "not trusted" from "not identifiable".
      ...(options.noIpSecret === true ? {} : { ipSecret: IP_SECRET }),
    },
  )
}

async function policy(value: string): Promise<void> {
  await writeSetting(db, MODERATION_POLICY_SETTING, value, t0)
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  await db.exec('DELETE FROM settings')
})

describe('a vouch on a deployment that has not asked for it', () => {
  it('is held under hold-all, which is the default', async () => {
    // The feature switched off. A provider vouching changes nothing at all until the
    // owner says it should — the same shape as every other defence in this project.
    expect((await post({ verdict: VOUCHED })).outcome).toBe('pending')
  })

  it('is held under trust-returning, which is about people rather than comments', async () => {
    // Not a ladder rung the owner gets for free. `trust-returning` is a statement
    // about commenters the owner has already approved; a first-time stranger whose
    // comment Akismet likes is not one of those.
    await policy('trust-returning')

    expect((await post({ verdict: VOUCHED })).outcome).toBe('pending')
  })

  it('is held when the setting is stored as something unrecognisable', async () => {
    await policy('trust-clean')

    expect((await post({ verdict: VOUCHED })).outcome).toBe('pending')
  })
})

describe('trust-vouched', () => {
  beforeEach(async () => {
    await policy('trust-vouched')
  })

  it('publishes a comment a provider checked and found clean', async () => {
    expect((await post({ verdict: VOUCHED })).outcome).toBe('published')
  })

  it('still holds a comment some layer doubted', async () => {
    // The property that makes the whole thing safe: the policy raises the ceiling on a
    // clean run, it never lowers the floor on a doubted one. `runLayers` already makes
    // a doubt beat a vouch (test/worker/spam/vouch.test.ts); this asserts the pipeline
    // does not undo that.
    //
    // **The commenter is one this policy would otherwise publish, and that is the whole
    // test.** Written against a stranger it passes with the guard deleted — a stranger
    // is held anyway, by the trust read finding nothing — so it would have read as
    // coverage while asserting nothing. Establishing them first is what makes the
    // doubt, rather than their anonymity, the only thing holding the comment.
    await post({ verdict: ALLOWED })
    await db
      .prepare(
        `update comments set status = 'approved', moderated_at = ?1 where status = 'pending'`,
      )
      .bind(t0 + 60)
      .run()

    expect((await post({ verdict: HELD })).outcome).toBe('pending')
  })

  it('still holds a comment that merely nothing objected to', async () => {
    // `allow` is not `vouch`, and this is the distinction the issue exists for. On a
    // deployment with no provider configured every clean comment is an `allow`, so
    // this assertion is what stops `trust-vouched` from silently becoming the
    // `trust-clean` that #173 declined to ship.
    expect((await post({ verdict: ALLOWED })).outcome).toBe('pending')
  })

  it('publishes without an email address, because the vouch is about the comment', async () => {
    // Deliberately unlike `trust-returning`, which needs both halves of an identity
    // before it will trust anybody. Nothing here is recognising a person: Akismet was
    // asked about this body and answered about this body.
    expect((await post({ verdict: VOUCHED, email: null })).outcome).toBe('published')
  })

  it('publishes with no IP_HASH_SECRET configured, for the same reason', async () => {
    expect((await post({ verdict: VOUCHED, noIpSecret: true })).outcome).toBe('published')
  })

  it('keeps trusting a returning commenter the owner already approved', async () => {
    // The policies are a ladder, not a menu. An owner who moved up to `trust-vouched`
    // did not ask to stop trusting their regulars, and without this they would have:
    // a regular's next comment is an `allow`, not a `vouch`, on every deployment whose
    // provider happens to be off or unconfigured.
    await post({ verdict: ALLOWED })
    await db
      .prepare(
        `update comments set status = 'approved', moderated_at = ?1 where status = 'pending'`,
      )
      .bind(t0 + 60)
      .run()

    expect((await post({ verdict: ALLOWED })).outcome).toBe('published')
  })
})
