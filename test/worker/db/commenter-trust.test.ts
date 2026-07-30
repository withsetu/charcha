// What the owner's past decisions say about a commenter. Designed on issue #173.
//
// **This is the identity check, and it is the security heart of the feature.** Whatever
// it says `approved` about gets published without a human seeing it, so most of this
// file is about what must *not* match: an email on its own, an address on its own, an
// owner's own comment, a comment nobody has judged yet, and a hash the retention sweep
// has taken away.

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MODERATION_POLICY_SETTING,
  getModerationPolicy,
  readCommenterTrust,
  writeSetting,
} from '../../../src/db'

const db = env.DB
const t0 = 1_753_300_000

const REGULAR = 'rahul@kanwar.example'
const HER_HASH = 'hash-of-the-address-she-comments-from'
const OTHER_HASH = 'hash-of-somebody-elses-address'

let threadId: number

/**
 * One comment, written straight to the table.
 *
 * Deliberately not through `insertComment`: that function cannot produce a `spam` row
 * or a moderated one, and the rows this lookup reads are rows the *owner* put into
 * those states. Building them by hand is what lets the fixture cover every status.
 */
async function comment(input: {
  email: string | null
  ipHash: string | null
  status: string
  byOwner?: boolean
  body?: string
}): Promise<number> {
  const row = await db
    .prepare(
      `insert into comments (thread_id, author_name, author_email, body, body_hash, status,
                             by_owner, ip_hash, created_at)
       values (?1, 'Rahul Kanwar', ?2, ?3, 'hash', ?4, ?5, ?6, ?7)
       returning id`,
    )
    .bind(
      threadId,
      input.email,
      input.body ?? 'A comment somebody wrote.',
      input.status,
      input.byOwner === true ? 1 : 0,
      input.ipHash,
      t0,
    )
    .first<{ id: number }>()
  if (row === null) throw new Error('fixture comment was not stored')
  return row.id
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  await db.exec('DELETE FROM settings')

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

describe('a commenter nobody has judged', () => {
  it('has no standing', async () => {
    expect(await readCommenterTrust(db, REGULAR, HER_HASH)).toEqual({
      approved: false,
      spammed: false,
    })
  })

  it('still has none once they have a comment waiting in the queue', async () => {
    await comment({ email: REGULAR, ipHash: HER_HASH, status: 'pending' })

    expect(await readCommenterTrust(db, REGULAR, HER_HASH)).toEqual({
      approved: false,
      spammed: false,
    })
  })
})

describe('a commenter the owner has approved', () => {
  beforeEach(async () => {
    await comment({ email: REGULAR, ipHash: HER_HASH, status: 'approved' })
  })

  it('has standing', async () => {
    expect(await readCommenterTrust(db, REGULAR, HER_HASH)).toMatchObject({ approved: true })
  })

  // The crux of #173. Every one of these is a way an attacker could hold half the
  // identity, and none of them may be enough.
  it('does not lend it to somebody who only knows the email address', async () => {
    // The attacker types an address they do not control, from their own network. This
    // is the case that disqualifies `author_email` on its own: an unverified field
    // anyone can fill in would otherwise buy a stranger's standing forever.
    expect(await readCommenterTrust(db, REGULAR, OTHER_HASH)).toMatchObject({ approved: false })
  })

  it('does not lend it to somebody who only shares the network', async () => {
    // Everyone behind one NAT — a household, an office, a CGNAT range — has the same
    // hash. Without the email half they would inherit each other's standing.
    expect(await readCommenterTrust(db, 'someone@else.example', HER_HASH)).toMatchObject({
      approved: false,
    })
  })

  it('does not lend it to somebody holding neither half', async () => {
    expect(await readCommenterTrust(db, 'someone@else.example', OTHER_HASH)).toMatchObject({
      approved: false,
    })
  })

  it('does not accept the two halves from two different comments', async () => {
    // The attacker has had one comment of their own approved, from their own address
    // and their own email, and separately knows the regular's address. Matching the
    // halves against *different* rows would hand them the regular's identity, so the
    // statement requires both on one comment.
    await comment({ email: 'attacker@elsewhere.example', ipHash: OTHER_HASH, status: 'approved' })

    expect(await readCommenterTrust(db, REGULAR, OTHER_HASH)).toMatchObject({ approved: false })
    expect(await readCommenterTrust(db, 'attacker@elsewhere.example', HER_HASH)).toMatchObject({
      approved: false,
    })
  })

  it('compares the email exactly, so a different spelling is a different commenter', async () => {
    // Strictness in the free direction: this comment is held, which is what would have
    // happened anyway. Folding case would widen who can claim an address and buy
    // nothing, since an attacker types whichever spelling matches.
    expect(await readCommenterTrust(db, REGULAR.toUpperCase(), HER_HASH)).toMatchObject({
      approved: false,
    })
  })

  it('loses it when #19 purges the hash, because trust decays with retention', async () => {
    // The sweep nulls `ip_hash` past the window. The row leaves the partial index and
    // the identity stops being recognisable — deliberately: an approval from an address
    // this deployment no longer stores must not be inheritable by whoever holds that
    // address now.
    await db.exec('UPDATE comments SET ip_hash = null')

    expect(await readCommenterTrust(db, REGULAR, HER_HASH)).toMatchObject({ approved: false })
  })
})

describe('a comment the owner wrote', () => {
  it('confers nothing, whatever email and address are on it', async () => {
    // Owner comments are stored `approved` without ever passing a moderation decision,
    // so counting them would mean the dashboard's own replies handing standing to
    // whoever next arrives with that email and that address.
    await comment({ email: REGULAR, ipHash: HER_HASH, status: 'approved', byOwner: true })

    expect(await readCommenterTrust(db, REGULAR, HER_HASH)).toMatchObject({ approved: false })
  })
})

describe('revocation', () => {
  it('is what marking a trusted commenter spam does', async () => {
    await comment({ email: REGULAR, ipHash: HER_HASH, status: 'approved' })
    await comment({ email: REGULAR, ipHash: HER_HASH, status: 'spam' })

    expect(await readCommenterTrust(db, REGULAR, HER_HASH)).toEqual({
      approved: true,
      spammed: true,
    })
  })

  it('survives any number of approvals, because one spam decision is the owner saying so', async () => {
    for (let i = 0; i < 5; i += 1) {
      await comment({ email: REGULAR, ipHash: HER_HASH, status: 'approved', body: `one ${i}` })
    }
    await comment({ email: REGULAR, ipHash: HER_HASH, status: 'spam' })

    expect(await readCommenterTrust(db, REGULAR, HER_HASH)).toMatchObject({ spammed: true })
  })

  it('does not follow from a deletion, which is a different judgement', async () => {
    // Taking a comment down is not calling its author a spammer — it covers a duplicate,
    // an off-topic post, a request from the commenter themselves. Only `spam` is the
    // owner judging the commenter.
    await comment({ email: REGULAR, ipHash: HER_HASH, status: 'approved' })
    await comment({ email: REGULAR, ipHash: HER_HASH, status: 'deleted' })

    expect(await readCommenterTrust(db, REGULAR, HER_HASH)).toEqual({
      approved: true,
      spammed: false,
    })
  })

  it('does not reach past the identity to somebody else', async () => {
    await comment({ email: REGULAR, ipHash: HER_HASH, status: 'approved' })
    await comment({ email: 'spammer@elsewhere.example', ipHash: OTHER_HASH, status: 'spam' })

    expect(await readCommenterTrust(db, REGULAR, HER_HASH)).toEqual({
      approved: true,
      spammed: false,
    })
  })
})

describe('the cost of asking', () => {
  it('reads one row whatever the commenter has posted', async () => {
    // The property the aggregate exists for. A lookup returning the commenter's
    // comments would cost one row read per comment, on the public write endpoint,
    // against an account budget of 5M a day — a read an attacker inflates by commenting.
    for (let i = 0; i < 40; i += 1) {
      await comment({ email: REGULAR, ipHash: HER_HASH, status: 'approved', body: `one ${i}` })
    }

    const statements: string[] = []
    const counting = {
      ...db,
      prepare(sql: string) {
        statements.push(sql)
        return db.prepare(sql)
      },
    } as unknown as D1Database

    expect(await readCommenterTrust(counting, REGULAR, HER_HASH)).toMatchObject({ approved: true })
    expect(statements).toHaveLength(1)
  })
})

describe('the policy setting', () => {
  it('is hold-all on a deployment that has never set it', async () => {
    expect(await getModerationPolicy(db)).toBe('hold-all')
  })

  it('is what the owner stored, when the owner stored one', async () => {
    await writeSetting(db, MODERATION_POLICY_SETTING, 'trust-returning', t0)

    expect(await getModerationPolicy(db)).toBe('trust-returning')
  })

  it('falls back to hold-all on a row nothing recognises', async () => {
    // The row is free text and this is a fail-closed read: a value nobody can parse
    // must not become a policy that publishes comments. See src/moderation/policy.ts.
    await writeSetting(db, MODERATION_POLICY_SETTING, 'trust-everything', t0)

    expect(await getModerationPolicy(db)).toBe('hold-all')
  })
})
