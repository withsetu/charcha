// The moderation policy on the submission path. Designed on issue #173.
//
// **This is the only place in the Worker where a stranger's comment can be published
// without a human seeing it**, so the file is organised around the ways it must refuse:
// the default, a flagged comment, half an identity, a revoked commenter, and anything a
// caller can put in the request body.
//
// The spam check is stubbed rather than assembled, because what is under test is what
// `runSubmission` does with a verdict — the layers that produce one have their own
// suites. `ipSecret` is passed so the pipeline computes a real `ip_hash`; without it the
// identity has no second half and nothing here could ever be trusted, which is itself
// one of the cases below.

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { MODERATION_POLICY_SETTING, writeSetting } from '../../../src/db'
import { readSiteSettings } from '../../../src/settings'
import { runSubmission } from '../../../src/submit/pipeline'
import { allowAllSpamCheck } from '../../../src/submit/spam'
import type { SpamCheck, SpamVerdict } from '../../../src/submit/spam'

const db = env.DB
const t0 = 1_753_300_000
const IP_SECRET = 'a-per-deployment-hmac-key-for-the-tests'

const HER_ADDRESS = '203.0.113.9'
const ANOTHER_ADDRESS = '198.51.100.7'
const REGULAR = 'rahul@kanwar.example'

function requestFrom(ip: string): Request {
  return new Request('https://charcha.example/comments', {
    method: 'POST',
    headers: { 'cf-connecting-ip': ip },
  })
}

function verdict(action: SpamVerdict): SpamCheck {
  return { check: () => Promise.resolve(action) }
}

interface PostOptions {
  from?: string
  email?: string | null
  body?: string
  spamCheck?: SpamCheck
  db?: D1Database
}

let bodyCounter = 0

/**
 * One public submission, through the same two steps the route takes (#207): resolve every
 * settings row in one statement, then run the pipeline with the policy that read produced.
 *
 * The settings read goes through the *same* binding the pipeline gets, which is what keeps
 * the query-budget block below counting the whole of what a submission costs — and what
 * makes the failing-database cases cover the read that now happens first.
 */
async function post(options: PostOptions = {}) {
  bodyCounter += 1
  const email = options.email === undefined ? REGULAR : options.email
  const database = options.db ?? db
  const { moderationPolicy } = await readSiteSettings(database, {})
  return runSubmission(
    {
      authorName: 'Rahul Kanwar',
      body: options.body ?? `The part people underestimate is the export, take ${bodyCounter}.`,
      url: 'https://maya.build/notes/leaving',
      ...(email === null ? {} : { authorEmail: email }),
    },
    {
      db: database,
      spamCheck: options.spamCheck ?? allowAllSpamCheck,
      request: requestFrom(options.from ?? HER_ADDRESS),
      now: t0,
      moderationPolicy,
      ipSecret: IP_SECRET,
    },
  )
}

/** The moderator's click, as the dashboard's endpoint would make it. */
async function decide(status: 'approved' | 'spam' | 'deleted'): Promise<void> {
  await db
    .prepare(`update comments set status = ?1, moderated_at = ?2 where status = 'pending'`)
    .bind(status, t0 + 60)
    .run()
}

async function statuses(): Promise<string[]> {
  const { results } = await db
    .prepare('select status from comments order by id')
    .all<{ status: string }>()
  return results.map((row) => row.status)
}

async function trustReturning(): Promise<void> {
  await writeSetting(db, MODERATION_POLICY_SETTING, 'trust-returning', t0)
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  await db.exec('DELETE FROM settings')
})

describe('hold-all, which is what a deployment that has changed nothing does', () => {
  it('holds a first comment', async () => {
    const result = await post()

    expect(result.outcome).toBe('pending')
  })

  it('holds the second one too, from the same commenter the owner just approved', async () => {
    // The whole feature, switched off. This is the assertion that says the default is
    // unchanged: the same sequence that publishes under `trust-returning` below does
    // not publish here.
    await post()
    await decide('approved')

    expect((await post()).outcome).toBe('pending')
  })

  it('holds it even with the setting stored as something unrecognisable', async () => {
    await writeSetting(db, MODERATION_POLICY_SETTING, 'trust-clean', t0)
    await post()
    await decide('approved')

    expect((await post()).outcome).toBe('pending')
  })
})

describe('trust-returning', () => {
  beforeEach(trustReturning)

  it('holds the first comment, because nobody has judged this commenter', async () => {
    const result = await post()

    expect(result.outcome).toBe('pending')
    expect(await statuses()).toEqual(['pending'])
  })

  it('publishes the second one once the owner has approved the first', async () => {
    await post()
    await decide('approved')

    const result = await post()

    expect(result.outcome).toBe('published')
    expect(await statuses()).toEqual(['approved', 'approved'])
  })

  it('still holds it while the first is only waiting in the queue', async () => {
    // Standing is the owner's decision replayed, not the arrival of a previous comment.
    // Without this, one comment plus a second from the same person would be a way to
    // publish without anybody ever having approved anything.
    await post()

    expect((await post()).outcome).toBe('pending')
  })

  it('does not mark a published comment as the owner’s own', async () => {
    await post()
    await decide('approved')
    await post()

    const row = await db
      .prepare('select by_owner, moderated_at from comments order by id desc limit 1')
      .first<{ by_owner: number; moderated_at: number | null }>()
    // `by_owner` would badge a stranger's comment as the owner's on the page, and would
    // let a trusted commenter confer standing on the next arrival — the trust lookup
    // excludes owner rows. `moderated_at` stays null because nobody moderated it, and
    // that null is how the dashboard tells an auto-approved comment from an approved one.
    expect(row?.by_owner).toBe(0)
    expect(row?.moderated_at).toBeNull()
  })
})

describe('what trust does not survive', () => {
  beforeEach(async () => {
    await trustReturning()
    await post()
    await decide('approved')
  })

  it('a layer flagging the comment', async () => {
    // The decision #173 makes explicitly: history does not overrule a live signal. A
    // regular whose next comment trips the content heuristics is exactly the case the
    // owner should get to look at.
    const result = await post({ spamCheck: verdict({ action: 'review', reason: 'links' }) })

    expect(result.outcome).toBe('pending')
    const row = await db
      .prepare('select status, spam_reason from comments order by id desc limit 1')
      .first<{ status: string; spam_reason: string | null }>()
    expect(row?.status).toBe('pending')
    expect(row?.spam_reason).toBe('links')
  })

  it('a layer rejecting the comment, which is not stored at all', async () => {
    const result = await post({ spamCheck: verdict({ action: 'reject', reason: 'honeypot' }) })

    expect(result.outcome).toBe('rejected')
    expect(await statuses()).toEqual(['approved'])
  })

  it('the owner marking one of their comments as spam', async () => {
    // Revocation, and the second decision #173 asks the queue to be able to express.
    await post()
    await db
      .prepare(
        `update comments set status = 'spam', moderated_at = ?1 where id = (
                  select id from comments order by id desc limit 1)`,
      )
      .bind(t0 + 120)
      .run()

    expect((await post()).outcome).toBe('pending')
  })

  it('the retention sweep taking the address hash away', async () => {
    // #19 nulls `ip_hash` past the window, so an approval older than the window stops
    // being an identity. Decay by design, and the fail-closed direction: whoever holds
    // that address next must not inherit anything.
    await db.exec('UPDATE comments SET ip_hash = null')

    expect((await post()).outcome).toBe('pending')
  })
})

describe('an attacker holding half the identity', () => {
  beforeEach(async () => {
    await trustReturning()
    await post()
    await decide('approved')
  })

  it('claiming the approved commenter’s email from somewhere else is held', async () => {
    // The attack `author_email` alone would allow. The address is unverified and public
    // enough to guess, so this is the case that decides the design.
    const result = await post({ from: ANOTHER_ADDRESS })

    expect(result.outcome).toBe('pending')
  })

  it('commenting from the same network under another email is held', async () => {
    const result = await post({ email: 'someone@else.example' })

    expect(result.outcome).toBe('pending')
  })

  it('giving no email at all is held, from that network or any other', async () => {
    expect((await post({ email: null })).outcome).toBe('pending')
    expect((await post({ email: null, from: ANOTHER_ADDRESS })).outcome).toBe('pending')
  })
})

describe('what the request body cannot do', () => {
  // The property `insertComment` has always had, restated for the field #173 added: the
  // status is derived from two flags the Worker computes, and nothing on the wire
  // reaches either. src/submit/schema.ts strips what it does not know.
  const forged = {
    authorName: 'Rahul Kanwar',
    body: 'A comment that would very much like to be approved on arrival, thank you.',
    url: 'https://maya.build/notes/leaving',
    status: 'approved',
    autoApprove: true,
    byOwner: true,
    trusted: true,
    moderationPolicy: 'trust-returning',
  }

  it('cannot publish itself on a hold-all deployment', async () => {
    const result = await runSubmission(forged, {
      db,
      spamCheck: allowAllSpamCheck,
      request: requestFrom(HER_ADDRESS),
      now: t0,
      ipSecret: IP_SECRET,
    })

    expect(result.outcome).toBe('pending')
    expect(await statuses()).toEqual(['pending'])
  })

  it('cannot set the policy either — the setting is untouched', async () => {
    await runSubmission(forged, {
      db,
      spamCheck: allowAllSpamCheck,
      request: requestFrom(HER_ADDRESS),
      now: t0,
      ipSecret: IP_SECRET,
    })

    const row = await db
      .prepare('select value from settings where key = ?1')
      .bind(MODERATION_POLICY_SETTING)
      .first<{ value: string }>()
    expect(row).toBeNull()
  })

  it('cannot publish itself on a trust-returning deployment it has no standing on', async () => {
    await trustReturning()

    const result = await runSubmission(forged, {
      db,
      spamCheck: allowAllSpamCheck,
      request: requestFrom(HER_ADDRESS),
      now: t0,
      ipSecret: IP_SECRET,
    })

    expect(result.outcome).toBe('pending')
  })

  it('cannot pass itself off as the owner’s comment', async () => {
    await runSubmission(forged, {
      db,
      spamCheck: allowAllSpamCheck,
      request: requestFrom(HER_ADDRESS),
      now: t0,
      ipSecret: IP_SECRET,
    })

    const row = await db.prepare('select by_owner from comments').first<{ by_owner: number }>()
    expect(row?.by_owner).toBe(0)
  })
})

describe('a deployment with no IP_HASH_SECRET', () => {
  it('trusts nobody, because it stores no second half of the identity', async () => {
    // Not a degradation to work around: with no hash there is nothing that identifies a
    // returning commenter, and guessing from the email alone is the attack. The Setup
    // tab says so, because a feature that silently does nothing is the worse failure.
    await trustReturning()
    const withoutSecret = {
      db,
      spamCheck: allowAllSpamCheck,
      request: requestFrom(HER_ADDRESS),
      now: t0,
    }
    const comment = {
      authorName: 'Rahul Kanwar',
      authorEmail: REGULAR,
      url: 'https://maya.build/notes/leaving',
    }

    await runSubmission({ ...comment, body: 'A first comment with no hash stored.' }, withoutSecret)
    await decide('approved')
    const result = await runSubmission(
      { ...comment, body: 'A second comment with no hash stored.' },
      withoutSecret,
    )

    expect(result.outcome).toBe('pending')
  })
})

describe('the query budget', () => {
  /**
   * What a submission costs, by policy and by what the commenter gave.
   *
   * Written down rather than compared against itself. The 50-query invocation budget is
   * the constraint, and the rule CLAUDE.md states is that the count be *constant* — the
   * numbers below do not move with the number of comments on the page, in the thread, or
   * in the commenter's history, which is what the fixture's forty comments check.
   *
   * The baseline is the settings read + `getOrCreateThread` + `insertComment`;
   * `allowAllSpamCheck` reads nothing. A trust decision adds at most one: the identity
   * seek.
   *
   * **The settings read is one statement and it is in the baseline, which is #207.** It
   * used to be a `readSetting` for the policy, conditional on the commenter having given
   * an email — so a comment with an address cost one more than a comment without. Now the
   * moderation policy, the site URL layer 8 needs and the notifier's two addresses and
   * display name are one `where key in (…)`, and the constant that would have grown to
   * five does not move at all. The seventh setting will cost nothing either.
   */
  const SETTINGS_READ = 1
  const BASELINE = SETTINGS_READ + 2

  function counting(): { statements: string[]; wrapped: D1Database } {
    const statements: string[] = []
    const wrapped = {
      ...db,
      prepare(sql: string) {
        statements.push(sql)
        return db.prepare(sql)
      },
    } as unknown as D1Database
    return { statements, wrapped }
  }

  it('costs nothing extra for a commenter who gave no email', async () => {
    await trustReturning()
    const { statements, wrapped } = counting()

    await post({ email: null, db: wrapped })

    expect(statements).toHaveLength(BASELINE)
  })

  it('costs the same on the default deployment as under a policy that publishes', async () => {
    // The reads a submission makes no longer depend on which policy is stored: the row is
    // in the batch either way. What differs is only whether the identity seek below is
    // reached.
    const { statements, wrapped } = counting()

    await post({ db: wrapped })

    expect(statements).toHaveLength(BASELINE)
  })

  it('reads every setting in one statement, not one per row', async () => {
    // The property the constant above rests on, asserted directly rather than inferred
    // from a total that a second settings read would also satisfy.
    const { statements, wrapped } = counting()

    await post({ db: wrapped })

    expect(statements.filter((sql) => sql.includes('from settings'))).toHaveLength(1)
  })

  it('costs one extra under trust-returning, whatever the commenter has posted', async () => {
    await trustReturning()
    for (let i = 0; i < 40; i += 1) {
      await post({ body: `An earlier comment from the same person, number ${i}.` })
    }
    await decide('approved')

    const { statements, wrapped } = counting()
    const result = await post({ db: wrapped })

    expect(result.outcome).toBe('published')
    expect(statements).toHaveLength(BASELINE + 1)
  })

  it('costs nothing extra for a comment a layer held', async () => {
    // A held comment cannot be published whatever the policy says, so the identity seek is
    // never reached — the same argument `reviewOnly` makes in src/spam/layer.ts. The
    // settings read still happens, because it happens before the layers run and the
    // notifier's addresses come out of it.
    await trustReturning()
    const { statements, wrapped } = counting()

    await post({ db: wrapped, spamCheck: verdict({ action: 'review', reason: 'links' }) })

    expect(statements).toHaveLength(BASELINE)
  })
})

describe('a database that fails while the policy is being read', () => {
  /** A binding that answers everything except the statement `match` names. */
  function failingOn(match: string): D1Database {
    return {
      ...db,
      prepare(sql: string) {
        if (sql.includes(match)) throw new Error('D1_ERROR: the database is unavailable')
        return db.prepare(sql)
      },
    } as unknown as D1Database
  }

  it('fails the submission rather than quietly holding the comment', async () => {
    // The tempting shape is a `catch` returning false: the comment lands `pending`, the
    // reader gets a 202, and a broken database is invisible. It reaches the right
    // *status* by hiding a fault. Throwing is closed in the way that matters — nothing
    // is published, nothing is stored, and the reader is told the truth.
    await trustReturning()

    await expect(post({ db: failingOn('from settings') })).rejects.toThrow(/D1_ERROR/)
    expect(await statuses()).toEqual([])
  })

  it('fails the same way when the trust lookup itself is the read that breaks', async () => {
    await trustReturning()
    await post()
    await decide('approved')

    await expect(post({ db: failingOn('by_owner = 0') })).rejects.toThrow(/D1_ERROR/)
    // Only the first comment, which the owner approved. Nothing was stored by the
    // submission that failed.
    expect(await statuses()).toEqual(['approved'])
  })
})
