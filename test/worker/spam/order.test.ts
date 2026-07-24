// The ordering IS the design (#1, CLAUDE.md). These tests are about the order and
// the short-circuit, not about any one layer's judgement.

import { beforeEach, describe, expect, it } from 'vitest'
import { getOrCreateThread, insertComment } from '../../../src/db'
import { computeBodyHash } from '../../../src/submit/hash'
import { ELAPSED_FIELD, HONEYPOT_FIELD, TURNSTILE_FIELD } from '../../../src/spam/fields'
import { createSpamCheck } from '../../../src/spam'
import type { SpamLayer } from '../../../src/spam/layer'
import { runLayers } from '../../../src/spam/layer'
import { contextFor, db, t0, validBody } from './context'

/** A submission with every field a well-behaved embed sends, all of them innocent. */
function goodForm(extra: Record<string, unknown> = {}) {
  return {
    [HONEYPOT_FIELD]: '',
    [ELAPSED_FIELD]: 31_000,
    [TURNSTILE_FIELD]: 'a-good-token',
    ...extra,
  }
}

function siteverifyOk() {
  const calls: string[] = []
  const fetchImpl: typeof fetch = (input) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return Promise.resolve(
      new Response(JSON.stringify({ success: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
  return { calls, fetchImpl }
}

function spy(
  name: string,
  outcome: ReturnType<SpamLayer['run']> = null,
  seen: string[] = [],
): SpamLayer {
  return {
    name,
    run() {
      seen.push(name)
      return outcome
    },
  }
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

describe('the layered run', () => {
  it('stops at the first reject, so nothing later is even asked', async () => {
    const seen: string[] = []
    const verdict = await runLayers(
      [
        spy('first', null, seen),
        spy('second', { action: 'reject', reason: 'caught' }, seen),
        spy('third', null, seen),
      ],
      contextFor(),
    )

    expect(verdict.action).toBe('reject')
    expect(seen).toEqual(['first', 'second'])
  })

  it('keeps going after a review, so a review cannot be used to skip the rate limit', async () => {
    // If review short-circuited, anything that reliably produces one — a Turnstile
    // outage, a link-heavy body — would be a way past layers 4 and 5. Review still
    // costs a database write, so the layers that bound writes must still run.
    const seen: string[] = []
    const verdict = await runLayers(
      [
        spy('first', { action: 'review', reason: 'unsure' }, seen),
        spy('second', null, seen),
        spy('third', null, seen),
      ],
      contextFor(),
    )

    expect(verdict.action).toBe('review')
    expect(seen).toEqual(['first', 'second', 'third'])
  })

  it('lets a later reject overrule an earlier review', async () => {
    const verdict = await runLayers(
      [
        spy('first', { action: 'review', reason: 'unsure' }),
        spy('second', { action: 'reject', reason: 'sure' }),
      ],
      contextFor(),
    )

    expect(verdict.action).toBe('reject')
  })

  it('keeps the first review reason, which is the layer that first doubted the comment', async () => {
    const verdict = await runLayers(
      [
        spy('first', { action: 'review', reason: 'timing-missing' }),
        spy('second', { action: 'review', reason: 'links-many' }),
      ],
      contextFor(),
    )

    if (verdict.action !== 'review') throw new Error('expected review')
    expect(verdict.reason).toContain('timing-missing')
  })

  it('allows when no layer has an opinion', async () => {
    const verdict = await runLayers([spy('first'), spy('second')], contextFor())

    expect(verdict.action).toBe('allow')
  })
})

describe('createSpamCheck — the assembled ordering', () => {
  it('runs the free local layers before it will spend a Turnstile call', async () => {
    // Turnstile is a subrequest; layers 1 and 2 are string comparisons. A comment
    // stopped by the honeypot must not cost a network round trip, and this is the
    // property that makes the ordering the design rather than a preference.
    const { calls, fetchImpl } = siteverifyOk()
    const check = createSpamCheck(
      { TURNSTILE_SECRET_KEY: 'secret' },
      { turnstile: { fetch: fetchImpl } },
    )

    const verdict = await check.check(
      contextFor({ form: goodForm({ [HONEYPOT_FIELD]: 'filled' }) }),
    )

    expect(verdict.action).toBe('reject')
    expect(calls).toHaveLength(0)
  })

  it('runs the free local layers before it will spend a database read', async () => {
    const statements: string[] = []
    const counting = {
      ...db,
      prepare(sql: string) {
        statements.push(sql)
        return db.prepare(sql)
      },
    } as unknown as D1Database

    const check = createSpamCheck({})
    const verdict = await check.check({
      ...contextFor({ form: goodForm({ [ELAPSED_FIELD]: 12 }) }),
      db: counting,
    })

    expect(verdict.action).toBe('reject')
    expect(statements).toHaveLength(0)
  })

  it('still runs the rate limit when Turnstile could not answer', async () => {
    const failing: typeof fetch = () => Promise.reject(new Error('down'))
    const statements: string[] = []
    const counting = {
      ...db,
      prepare(sql: string) {
        statements.push(sql)
        return db.prepare(sql)
      },
    } as unknown as D1Database

    const check = createSpamCheck(
      { TURNSTILE_SECRET_KEY: 'secret', IP_HASH_SECRET: 'ip-secret' },
      { turnstile: { fetch: failing } },
    )
    const verdict = await check.check({ ...contextFor({ form: goodForm() }), db: counting })

    expect(verdict.action).toBe('review')
    expect(statements.length).toBeGreaterThan(0)
  })
})

describe('createSpamCheck — a comment from a real person', () => {
  it('passes every layer, on a deployment with Turnstile configured', async () => {
    // A defence that rejects everything passes every attack test. This is the one
    // that fails if any layer's threshold is set where a real comment lands.
    const { fetchImpl } = siteverifyOk()
    const check = createSpamCheck(
      { TURNSTILE_SECRET_KEY: 'secret', IP_HASH_SECRET: 'ip-secret' },
      { turnstile: { fetch: fetchImpl } },
    )

    const verdict = await check.check(contextFor({ form: goodForm() }))

    expect(verdict).toEqual({ action: 'allow' })
  })

  it('passes every layer on a deployment with no Turnstile and no IP secret', async () => {
    const check = createSpamCheck({})

    const verdict = await check.check(contextFor({ form: goodForm() }))

    expect(verdict).toEqual({ action: 'allow' })
  })

  it('passes even when the thread is already busy and other people have commented', async () => {
    const thread = await getOrCreateThread(db, { pageKey: '/notes/leaving', now: t0 })
    for (let i = 0; i < 12; i++) {
      const body = `an earlier comment number ${i}, long enough to be a real one on this thread`
      await insertComment(db, {
        threadId: thread.id,
        authorName: `Reader ${i}`,
        body,
        bodyHash: await computeBodyHash(body),
        ipHash: null,
        now: t0 - 60,
      })
    }
    const check = createSpamCheck({})

    const verdict = await check.check(contextFor({ form: goodForm(), body: validBody }))

    expect(verdict).toEqual({ action: 'allow' })
  })

  it('costs at most three database reads, whatever the page already holds', async () => {
    // Three: one per-IP count, one per-thread count, one duplicate-body lookup.
    // Constant in the number of comments, which is the rule the 50-query budget
    // produces (CLAUDE.md).
    const thread = await getOrCreateThread(db, { pageKey: '/notes/leaving', now: t0 })
    for (let i = 0; i < 30; i++) {
      const body = `an earlier comment number ${i}, long enough to be a real one on this thread`
      await insertComment(db, {
        threadId: thread.id,
        authorName: `Reader ${i}`,
        body,
        bodyHash: await computeBodyHash(body),
        ipHash: null,
        now: t0 - DEFAULT_WINDOW_AGO,
      })
    }
    const statements: string[] = []
    const counting = {
      ...db,
      prepare(sql: string) {
        statements.push(sql)
        return db.prepare(sql)
      },
    } as unknown as D1Database

    const check = createSpamCheck({ IP_HASH_SECRET: 'ip-secret' })
    await check.check({ ...contextFor({ form: goodForm() }), db: counting })

    expect(statements).toHaveLength(3)
  })
})

/** Older than any rate-limit window, so the seeded history cannot trip layer 4. */
const DEFAULT_WINDOW_AGO = 86_400
