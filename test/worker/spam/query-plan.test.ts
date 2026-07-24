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
  it('seeks the partial ip index rather than scanning the comments table', async () => {
    const plan = await planOf(RECENT_BY_IP_SQL, 'a-hash', 1000)

    expect(plan).toMatch(/USING (?:COVERING )?INDEX comments_by_ip/)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })
})

describe('the per-thread rate-limit read', () => {
  it('resolves the page and its comments on indexes, never a scan', async () => {
    const plan = await planOf(RECENT_ON_PAGE_SQL, '/hello', 1000)

    expect(plan).toMatch(/SEARCH t/)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })
})

describe('the duplicate-body read', () => {
  it('seeks (thread_id, body_hash) rather than scanning the thread', async () => {
    const plan = await planOf(DUPLICATE_BODY_SQL, '/hello', 'a-body-hash')

    expect(plan).toMatch(/USING (?:COVERING )?INDEX comments_by_body/)
    expect(plan).not.toMatch(/\bSCAN\b/)
  })
})
