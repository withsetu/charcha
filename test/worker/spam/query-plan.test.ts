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
  RECENT_BY_IP_SQL,
  RECENT_ON_PAGE_SQL,
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
  it('constrains the thread, the body hash and the window on one index', async () => {
    // The window is asserted, not just the two equalities, and that is #69's
    // doing rather than tidiness. Adding `comments_by_thread_time` gave SQLite a
    // second candidate for this statement — (thread_id, created_at) also answers
    // two of its three predicates — and the planner took it, downgrading an exact
    // two-column seek into a window scan filtered on body_hash. Carrying
    // created_at on `comments_by_body` makes that index strictly the more
    // constrained of the two, so the choice is decided by the schema rather than
    // by which index the planner's estimates happen to favour.
    const plan = await planOf(DUPLICATE_BODY_SQL, '/hello', 'a-body-hash', 1000)

    expect(plan).toMatch(
      /USING (?:COVERING )?INDEX comments_by_body \(thread_id=\? AND body_hash=\? AND created_at>\?\)/,
    )
    expect(plan).not.toMatch(/\bSCAN\b/)
  })
})
