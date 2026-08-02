// The spam layers' three reads sit on the busiest write path in the Worker, and
// every one of them runs on a comment that may turn out to be spam. A scan here
// means an attacker who is about to be rejected still spends row reads
// proportional to the whole database — the free tier's 5M/day, account-wide,
// burnt by the traffic this feature exists to refuse.
//
// Asserted against the same constants src/db sends, never a copy: a plan test
// against a hand-written duplicate passes happily while production scans.

import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  DUPLICATE_BODY_SQL,
  PRUNE_COMMENT_VECTORS_SQL,
  READ_SPAM_MODEL_SQL,
  READ_SPAM_MODEL_STATUS_SQL,
  RECENT_BY_IP_SQL,
  RECENT_ON_PAGE_SQL,
  SPAM_HISTORY_SQL,
  TRAINING_SUBJECT_SQL,
} from '../../../src/db'

const db = env.DB

async function planOf(sql: string, ...bindings: unknown[]): Promise<string> {
  const { results } = await db
    .prepare(`explain query plan ${sql}`)
    .bind(...bindings)
    .all<{ detail: string }>()
  return results.map((row) => row.detail).join('\n')
}

describe('the per-IP rate-limit read', () => {
  it('constrains both the hash and the window on the index, not only the hash', async () => {
    // `not.toMatch(/SCAN/)` is not enough on its own: SQLite says SEARCH for a
    // seek that then filters every entry it finds, so the assertion has to name
    // the columns the index actually constrained. `comments_by_ip` is
    // (ip_hash, created_at) and partial on `ip_hash is not null`.
    const plan = await planOf(RECENT_BY_IP_SQL, 'a-hash', 1000)

    expect(plan).toMatch(
      /USING (?:COVERING )?INDEX comments_by_ip \(ip_hash=\? AND created_at>\?\)/,
    )
    expect(plan).not.toMatch(/\bSCAN\b/)
  })
})

describe('the per-thread rate-limit read', () => {
  it('resolves the page on the unique key rather than scanning threads', async () => {
    const plan = await planOf(RECENT_ON_PAGE_SQL, '/hello', 1000)

    expect(plan).toMatch(
      /SEARCH t USING (?:COVERING )?INDEX sqlite_autoindex_threads_1 \(page_key=\?\)/,
    )
    expect(plan).not.toMatch(/\bSCAN\b/)
  })

  it('constrains both the thread and the window on the index, not only the thread', async () => {
    // The same trap as the per-IP read, and #69 is where this one was closed.
    // `comments_by_thread` is (thread_id, status, created_at, id) and this query
    // has no status predicate, so against *that* index created_at cannot be a
    // constraint — SQLite would seek the thread and then filter one index entry
    // per comment on the page, on every submission including the ones about to be
    // rejected. `comments_by_thread_time` is (thread_id, created_at), so the read
    // is bounded by the rate-limit window instead of by the page.
    //
    // Naming the index and its constrained columns is the whole assertion:
    // `not.toMatch(/SCAN/)` passed on the filtered plan too, because SQLite calls
    // that a SEARCH.
    const plan = await planOf(RECENT_ON_PAGE_SQL, '/hello', 1000)

    expect(plan).toMatch(
      /SEARCH c USING (?:COVERING )?INDEX comments_by_thread_time \(thread_id=\? AND created_at>\?\)/,
    )
    expect(plan).not.toMatch(/\bSCAN\b/)
  })
})

describe("the classifier's model read (#10)", () => {
  it('is a rowid seek and reads no other table', async () => {
    // This one is on the public submission path — the busiest write endpoint in the
    // Worker — so it carries the same burden as the three reads above. It is also
    // the read that a nearest-neighbour classifier would have made per stored
    // vector, which is the design this shape exists to avoid: `spam_model` is
    // `CHECK (id = 1)`, so there is one row to seek to, forever.
    const plan = await planOf(READ_SPAM_MODEL_SQL)

    expect(plan).toMatch(/SEARCH spam_model USING INTEGER PRIMARY KEY \(rowid=\?\)/)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })

  it('answers the Setup tab from the same one row, and never selects the weights', async () => {
    // #177's read. Authenticated and rare, so the plan is not the reason it is here —
    // the column list is. D1 converts a BLOB to a JavaScript `Array` of byte values — one
    // number per byte — so a `select *` would build 4,096 of them at this model's
    // expected 1,024 dimensions, and up to 16,384 at the MAX_MODEL_DIMS ceiling, for a
    // screen that has nothing to say about any of them. Asserted against the constant
    // src/db actually sends, so a later edit that widened it fails here.
    const plan = await planOf(READ_SPAM_MODEL_STATUS_SQL)

    expect(plan).toMatch(/SEARCH spam_model USING INTEGER PRIMARY KEY \(rowid=\?\)/)
    expect(plan).not.toMatch(/\bSCAN\b/)
    expect(READ_SPAM_MODEL_STATUS_SQL).not.toMatch(/weights|\*/)
  })
})

describe("the trainer's reads (#10)", () => {
  it('seeks the one comment and its one vector, both on a primary key', async () => {
    // The moderator's decision is authenticated and rare, so this is not the hot
    // path — but it must not grow with the site either, because it runs on every
    // decision and D1's row reads are an account-wide daily budget. Both halves are
    // primary keys: `comments.id` is the rowid, and `comment_vectors.comment_id` is
    // the table's own INTEGER PRIMARY KEY.
    const plan = await planOf(TRAINING_SUBJECT_SQL, 1)

    expect(plan).toMatch(/SEARCH c USING INTEGER PRIMARY KEY \(rowid=\?\)/)
    expect(plan).toMatch(/SEARCH v USING INTEGER PRIMARY KEY \(rowid=\?\)/)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })

  it('finds the vectors to prune on the label index rather than sorting the table', async () => {
    // The subquery walks one label's entries in `created_at` order. Naming the index
    // is the assertion: without `comment_vectors_by_label` this is a full scan plus a
    // B-TREE sort of every vector ever stored, on a statement whose whole job is to
    // stop that table growing.
    const plan = await planOf(PRUNE_COMMENT_VECTORS_SQL, 'spam', 2000)

    expect(plan).toMatch(/USING (?:COVERING )?INDEX comment_vectors_by_label \(label=\?\)/)
    expect(plan).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/)
  })
})

describe('the duplicate-body read', () => {
  it('constrains the body hash and the window on one index, across every page', async () => {
    // #184 made this read deployment-wide: the page-scoped version could not see one
    // payload blasted at fifty URLs at all, because `comments_by_body` led with
    // thread_id and a prefix of that answers nothing when the thread is unknown.
    //
    // The window is asserted and not only the hash, which is #69's lesson carried
    // over: an index constrained on one column and then filtering every entry it
    // finds is still reported as a SEARCH, so a plan test that asserts less than the
    // full seek passes while the read grows with the copies of a body ever stored.
    const plan = await planOf(DUPLICATE_BODY_SQL, '/hello', 'a-body-hash', 1000)

    expect(plan).toMatch(
      /SEARCH c USING COVERING INDEX comments_by_body_hash \(body_hash=\? AND created_at>\?\)/,
    )
    expect(plan).not.toMatch(/\bSCAN\b/)
  })

  it('is covering, so counting the pages a body reached reads no comment row', async () => {
    // COVERING is the load-bearing word, and `thread_id` being the index's third
    // column is what earns it. Without it SQLite seeks back into `comments` once per
    // copy of the body — each row carrying up to 10,000 characters of body into a
    // 128 MB isolate — on the public write endpoint.
    const plan = await planOf(DUPLICATE_BODY_SQL, '/hello', 'a-body-hash', 1000)

    expect(plan).toMatch(/COVERING INDEX comments_by_body_hash/)
  })

  it('resolves each copy’s page on the threads primary key, never by scanning threads', async () => {
    const plan = await planOf(DUPLICATE_BODY_SQL, '/hello', 'a-body-hash', 1000)

    expect(plan).toMatch(/SEARCH t USING INTEGER PRIMARY KEY \(rowid=\?\)/)
  })
})

describe('the repeat-offender read (#184)', () => {
  const BINDINGS = ['a-hash-of-an-address', 'rahul@kanwar.example'] as const

  it('answers out of comments_by_spam_origin without reading a comment row', async () => {
    // The mirror of the trust lookup's plan test, and it carries the same warning:
    // `not.toMatch(/SCAN/)` alone is a kill-shot that passes here, because dropping
    // `comments_by_spam_origin` leaves SQLite `comments_by_ip (ip_hash=?)` — still a
    // seek, still no SCAN, and one row read for every comment ever posted from that
    // address, on the public write endpoint. The index by name and COVERING are what
    // make the assertion mean anything.
    const plan = await planOf(SPAM_HISTORY_SQL, ...BINDINGS)

    expect(plan).toMatch(/USING COVERING INDEX comments_by_spam_origin \(ip_hash=\?\)/)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })
})
