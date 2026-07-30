// What the owner's past *spam* decisions say about the address a comment came from.
// Designed on issue #184, and the mirror of test/worker/db/commenter-trust.test.ts.
//
// **The two tiers are the whole subject of this file.** `seen` is a loose match on the
// address alone and its consequence is a review; `sameCommenter` is #173's strict
// identity — this email and this address on the *same* condemned row — and its
// consequence is a refusal. So most of these tests are about what must not reach the
// strict tier: an email matched against a different row, an owner's own comment, a
// status nobody has judged, and a hash the retention sweep has taken away.

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { readSpamHistory } from '../../../src/db'

const db = env.DB
const t0 = 1_753_300_000

const SPAMMER = 'buy@pills.example'
const HIS_HASH = 'hash-of-the-address-he-posted-from'
const OTHER_HASH = 'hash-of-somebody-elses-address'

let threadId: number

/**
 * One comment, written straight to the table.
 *
 * Deliberately not through `insertComment`, for the reason commenter-trust.test.ts
 * gives: that function cannot produce a `spam` row, and every row this lookup reads is
 * one the *owner* put into that state.
 */
async function comment(input: {
  email: string | null
  ipHash: string | null
  status: string
  byOwner?: boolean
}): Promise<void> {
  await db
    .prepare(
      `insert into comments (thread_id, author_name, author_email, body, body_hash, status,
                             by_owner, ip_hash, created_at)
       values (?1, 'Someone', ?2, 'A comment somebody wrote.', 'hash', ?3, ?4, ?5, ?6)`,
    )
    .bind(threadId, input.email, input.status, input.byOwner === true ? 1 : 0, input.ipHash, t0)
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

describe('an address nobody has been refused from', () => {
  it('has no history at all', async () => {
    expect(await readSpamHistory(db, HIS_HASH, SPAMMER)).toEqual({
      seen: false,
      sameCommenter: false,
    })
  })

  it('is unaffected by comments from it that the owner has not judged', async () => {
    // `pending` is the owner not having decided, and `deleted` is them taking a comment
    // down without calling it spam — a different judgement, and not one to replay.
    await comment({ email: SPAMMER, ipHash: HIS_HASH, status: 'pending' })
    await comment({ email: SPAMMER, ipHash: HIS_HASH, status: 'deleted' })
    await comment({ email: SPAMMER, ipHash: HIS_HASH, status: 'approved' })

    expect(await readSpamHistory(db, HIS_HASH, SPAMMER)).toEqual({
      seen: false,
      sameCommenter: false,
    })
  })
})

describe('an address the owner has marked spam from', () => {
  beforeEach(async () => {
    await comment({ email: SPAMMER, ipHash: HIS_HASH, status: 'spam' })
  })

  it('is recognised, and recognised as the same commenter when the email matches too', async () => {
    expect(await readSpamHistory(db, HIS_HASH, SPAMMER)).toEqual({
      seen: true,
      sameCommenter: true,
    })
  })

  it('is recognised loosely for a different person behind the same address', async () => {
    // The NAT case, stated as a fact of the design rather than discovered later: a
    // stranger who shares the spammer's address is `seen` and is therefore held. It is
    // the price of the loose match, and it is bounded by `sameCommenter` staying false
    // — the layer refuses only on that.
    expect(await readSpamHistory(db, HIS_HASH, 'priya@example.com')).toEqual({
      seen: true,
      sameCommenter: false,
    })
  })

  it('is recognised loosely for a comment that carries no email at all', async () => {
    expect(await readSpamHistory(db, HIS_HASH, null)).toEqual({
      seen: true,
      sameCommenter: false,
    })
  })

  it('says nothing about any other address', async () => {
    expect(await readSpamHistory(db, OTHER_HASH, SPAMMER)).toEqual({
      seen: false,
      sameCommenter: false,
    })
  })

  it('stops recognising anybody once #19 has purged the hash', async () => {
    // Retention decides how long this lasts, and the direction is the fail-closed one:
    // an identity the deployment can no longer recognise must not be inheritable by
    // whoever holds that address now.
    await db.prepare(`update comments set ip_hash = null`).run()

    expect(await readSpamHistory(db, HIS_HASH, SPAMMER)).toEqual({
      seen: false,
      sameCommenter: false,
    })
  })
})

describe('what must not add up to the strict identity', () => {
  it('does not let an email matched against a *different* row earn a refusal', async () => {
    // The heart of it. One spam row from this address with no email, and one spam row
    // carrying this email from somewhere else, must not combine into "this commenter
    // was refused" — that is exactly the forgery #173's index shape rules out, and the
    // aggregate has to rule it out too.
    await comment({ email: null, ipHash: HIS_HASH, status: 'spam' })
    await comment({ email: SPAMMER, ipHash: OTHER_HASH, status: 'spam' })

    expect(await readSpamHistory(db, HIS_HASH, SPAMMER)).toEqual({
      seen: true,
      sameCommenter: false,
    })
  })

  it('ignores the owner’s own comments, whatever status they carry', async () => {
    await comment({ email: SPAMMER, ipHash: HIS_HASH, status: 'spam', byOwner: true })

    expect(await readSpamHistory(db, HIS_HASH, SPAMMER)).toEqual({
      seen: false,
      sameCommenter: false,
    })
  })

  it('compares the email exactly, so a different spelling is not the same commenter', async () => {
    // The same rule as the trust lookup, and for the same reason: loosening the
    // comparison widens who can claim an address for no gain, because the attacker
    // types whatever spelling matches. Here the direction of the error is the safe one
    // anyway — they are still `seen`, and still held.
    await comment({ email: SPAMMER, ipHash: HIS_HASH, status: 'spam' })

    expect(await readSpamHistory(db, HIS_HASH, SPAMMER.toUpperCase())).toEqual({
      seen: true,
      sameCommenter: false,
    })
  })

  it('gives the standing back when the owner approves the comment they condemned', async () => {
    await comment({ email: SPAMMER, ipHash: HIS_HASH, status: 'spam' })
    expect(await readSpamHistory(db, HIS_HASH, SPAMMER)).toEqual({
      seen: true,
      sameCommenter: true,
    })

    await db.prepare(`update comments set status = 'approved'`).run()

    expect(await readSpamHistory(db, HIS_HASH, SPAMMER)).toEqual({
      seen: false,
      sameCommenter: false,
    })
  })
})
