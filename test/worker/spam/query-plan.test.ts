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
import { DUPLICATE_BODY_SQL, RECENT_BY_IP_SQL, RECENT_ON_PAGE_SQL } from '../../../src/db'

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

  it('constrains the thread but NOT the window, which is the cost recorded on #69', async () => {
    // Pinned as it really is rather than as it should be. `comments_by_thread` is
    // (thread_id, status, created_at, id) and this query has no status predicate,
    // so created_at cannot be an index constraint — SQLite seeks the thread and
    // filters its entries. This assertion fails the moment #69 adds
    // (thread_id, created_at), which is the point: the improvement should have to
    // come back and update the claim rather than land silently.
    const plan = await planOf(RECENT_ON_PAGE_SQL, '/hello', 1000)

    expect(plan).toMatch(/SEARCH c USING (?:COVERING )?INDEX comments_by_thread \(thread_id=\?\)/)
  })
})

describe('the duplicate-body read', () => {
  it('constrains both the thread and the body hash on the index', async () => {
    const plan = await planOf(DUPLICATE_BODY_SQL, '/hello', 'a-body-hash', 1000)

    expect(plan).toMatch(
      /USING (?:COVERING )?INDEX comments_by_body \(thread_id=\? AND body_hash=\?\)/,
    )
    expect(plan).not.toMatch(/\bSCAN\b/)
  })
})
