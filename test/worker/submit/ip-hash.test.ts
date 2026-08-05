import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { hashIp } from '../../../src/spam/ip'
import { runSubmission } from '../../../src/submit/pipeline'
import { allowAllSpamCheck } from '../../../src/submit/spam'
import { createSpamCheck } from '../../../src/spam'
import { DEFAULT_MAX_PER_IP } from '../../../src/spam/rate-limit'

const db = env.DB
const t0 = 1_753_300_000
const SECRET = 'a-test-hmac-secret'

/**
 * The address these submissions report, declared (#224). Passed as a dep rather than
 * written to `settings` because this file drives the pipeline directly, exactly as
 * src/submit/route.ts does with what it read.
 */
const DECLARED = ['https://maya.build']

function submission(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://maya.build/notes/hello',
    authorName: 'Rahul',
    body: 'A comment long enough to be ordinary.',
    ...overrides,
  }
}

function request(ip: string | null): Request {
  const headers = new Headers()
  if (ip !== null) headers.set('CF-Connecting-IP', ip)
  return new Request('https://api.example/comments', { method: 'POST', headers })
}

async function storedIpHash(): Promise<string | null> {
  const row = await db
    .prepare('select ip_hash from comments order by id desc limit 1')
    .first<{ ip_hash: string | null }>()
  return row?.ip_hash ?? null
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

describe('the submission pipeline stores an IP hash (#65)', () => {
  // Without this the per-IP rate limit in src/spam/rate-limit.ts counts an
  // always-empty column and returns 0 for every address — a guard that is
  // correct, indexed, tested, and inert. #19's retention janitor also has
  // nothing to purge.
  it('writes a hash of the client address when a secret is configured', async () => {
    const result = await runSubmission(submission(), {
      db,
      spamCheck: allowAllSpamCheck,
      request: request('203.0.113.9'),
      now: t0,
      declaredOrigins: DECLARED,
      ipSecret: SECRET,
    })

    expect(result.outcome).toBe('pending')
    expect(await storedIpHash()).toBe(await hashIp('203.0.113.9', SECRET))
  })

  it('never stores the address itself, only the hash', async () => {
    await runSubmission(submission(), {
      db,
      spamCheck: allowAllSpamCheck,
      request: request('203.0.113.9'),
      now: t0,
      declaredOrigins: DECLARED,
      ipSecret: SECRET,
    })

    const stored = await storedIpHash()
    expect(stored).not.toBeNull()
    expect(stored).not.toContain('203.0.113')
  })

  it('stores nothing when no secret is configured, because an unkeyed hash is reversible', async () => {
    await runSubmission(submission(), {
      db,
      spamCheck: allowAllSpamCheck,
      request: request('203.0.113.9'),
      now: t0,
      declaredOrigins: DECLARED,
    })

    expect(await storedIpHash()).toBeNull()
  })

  it('stores nothing when the request carries no client address', async () => {
    await runSubmission(submission(), {
      db,
      spamCheck: allowAllSpamCheck,
      request: request(null),
      now: t0,
      declaredOrigins: DECLARED,
      ipSecret: SECRET,
    })

    expect(await storedIpHash()).toBeNull()
  })

  it('gives one address the same hash twice, so the rate limit can count it', async () => {
    for (const body of ['first comment here', 'second comment here']) {
      await runSubmission(submission({ body }), {
        db,
        spamCheck: allowAllSpamCheck,
        request: request('203.0.113.9'),
        now: t0,
      declaredOrigins: DECLARED,
        ipSecret: SECRET,
      })
    }

    const { results } = await db.prepare('select ip_hash from comments').all<{ ip_hash: string }>()
    expect(results).toHaveLength(2)
    expect(new Set(results.map((r) => r.ip_hash)).size).toBe(1)
  })
})

describe('the per-IP rate limit actually fires now (#65 end to end)', () => {
  // The point of #65. Before it, this loop admitted every submission: the limit
  // counted rows by ip_hash, nothing wrote that column, so the count was always 0.
  // This drives the real pipeline with the real layers rather than asserting on the
  // column, which is the difference between "the write happened" and "the guard works".
  it('rejects the sixth comment from one address, and admits five', async () => {
    const spamCheck = createSpamCheck({ IP_HASH_SECRET: SECRET })
    const outcomes: string[] = []

    for (let i = 0; i < DEFAULT_MAX_PER_IP + 1; i++) {
      const result = await runSubmission(
        {
          ...submission({ body: `a distinct ordinary comment number ${i}` }),
          subject: '',
          t: 5000,
        },
        {
          db,
          spamCheck,
          request: request('203.0.113.9'),
          now: t0 + i,
          declaredOrigins: DECLARED,
          ipSecret: SECRET,
        },
      )
      outcomes.push(result.outcome)
    }

    expect(outcomes.slice(0, DEFAULT_MAX_PER_IP)).toEqual(Array(DEFAULT_MAX_PER_IP).fill('pending'))
    expect(outcomes[DEFAULT_MAX_PER_IP]).toBe('rejected')
  })

  it('does not count a different address towards that limit', async () => {
    const spamCheck = createSpamCheck({ IP_HASH_SECRET: SECRET })
    for (let i = 0; i < DEFAULT_MAX_PER_IP; i++) {
      await runSubmission(
        { ...submission({ body: `filling the bucket ${i}` }), subject: '', t: 5000 },
        { db, spamCheck, request: request('203.0.113.9'), now: t0 + i, declaredOrigins: DECLARED, ipSecret: SECRET },
      )
    }

    const other = await runSubmission(
      { ...submission({ body: 'a comment from somebody else entirely' }), subject: '', t: 5000 },
      { db, spamCheck, request: request('198.51.100.7'), now: t0 + 10, declaredOrigins: DECLARED, ipSecret: SECRET },
    )

    expect(other.outcome).toBe('pending')
  })
})

describe('the writer and the rate limit must derive the same key', () => {
  // Found reviewing this branch. The rate limit trimmed the secret and the pipeline
  // did not, so `IP_HASH_SECRET` with a trailing newline — the likely shape of a
  // pasted dashboard secret — made the two hash different values. The column would
  // fill up and the limit would still never match: #65 again, and silent again.
  it('trims the secret on the write path, as the rate limit does on the read path', async () => {
    await runSubmission(submission(), {
      db,
      spamCheck: allowAllSpamCheck,
      request: request('203.0.113.9'),
      now: t0,
      declaredOrigins: DECLARED,
      ipSecret: `  ${SECRET}\n`,
    })

    expect(await storedIpHash()).toBe(await hashIp('203.0.113.9', SECRET))
  })

  it('still rejects the sixth comment when the secret arrives untrimmed', async () => {
    const spamCheck = createSpamCheck({ IP_HASH_SECRET: `${SECRET}\n` })
    let last = ''
    for (let i = 0; i < DEFAULT_MAX_PER_IP + 1; i++) {
      const result = await runSubmission(
        { ...submission({ body: `an ordinary comment number ${i}` }), subject: '', t: 5000 },
        {
          db,
          spamCheck,
          request: request('203.0.113.9'),
          now: t0 + i,
          declaredOrigins: DECLARED,
          ipSecret: `${SECRET}\n`,
        },
      )
      last = result.outcome
    }
    expect(last).toBe('rejected')
  })

  it('stores nothing for a blank secret, because an unkeyed hash is reversible', async () => {
    await runSubmission(submission(), {
      db,
      spamCheck: allowAllSpamCheck,
      request: request('203.0.113.9'),
      now: t0,
      declaredOrigins: DECLARED,
      ipSecret: '   ',
    })

    expect(await storedIpHash()).toBeNull()
  })
})
