// The ordering IS the design (#1, CLAUDE.md). These tests are about the order and
// the short-circuit, not about any one layer's judgement.

import { beforeEach, describe, expect, it } from 'vitest'
import { getOrCreateThread, insertComment } from '../../../src/db'
import { computeBodyHash } from '../../../src/submit/hash'
import { ELAPSED_FIELD, HONEYPOT_FIELD, TURNSTILE_FIELD } from '../../../src/spam/fields'
import { hashIp } from '../../../src/spam/ip'
import { SPAM_LAYER_ORDER, createSpamCheck } from '../../../src/spam'
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

  it('skips a reviewOnly layer once a review is held, because its answer is discarded', async () => {
    // #10. The first review's reason is the one kept and a reviewOnly layer cannot
    // reject, so asking one after a review can no longer change the verdict — it can
    // only cost. For layer 7 that cost is a metered Workers AI call on the public
    // write endpoint, spent on an answer nobody reads, and omitting one form field is
    // enough to make layer 2 hold every submission.
    const seen: string[] = []
    const verdict = await runLayers(
      [
        spy('holder', { action: 'review', reason: 'unsure' }, seen),
        {
          ...spy('expensive', { action: 'review', reason: 'never-asked' }, seen),
          reviewOnly: true,
        },
      ],
      contextFor(),
    )

    expect(seen).toEqual(['holder'])
    if (verdict.action !== 'review') throw new Error('expected review')
    expect(verdict.reason).toContain('unsure')
  })

  it('still runs a reviewOnly layer when nothing has been held', async () => {
    const seen: string[] = []
    const verdict = await runLayers(
      [
        spy('quiet', null, seen),
        { ...spy('expensive', { action: 'review', reason: 'spoke' }, seen), reviewOnly: true },
      ],
      contextFor(),
    )

    expect(seen).toEqual(['quiet', 'expensive'])
    expect(verdict.action).toBe('review')
  })

  it('never skips a layer that can reject, because a reject overrules a review', async () => {
    // The boundary of the rule above. A rejecting layer's answer still matters after
    // a review, so marking one `reviewOnly` would let a held comment skip the layer
    // that would have refused it — which is the rate limit, among others.
    const seen: string[] = []
    const verdict = await runLayers(
      [
        spy('holder', { action: 'review', reason: 'unsure' }, seen),
        spy('refuser', { action: 'reject', reason: 'caught' }, seen),
      ],
      contextFor(),
    )

    expect(seen).toEqual(['holder', 'refuser'])
    expect(verdict.action).toBe('reject')
  })

  it('marks exactly the layers that never reject, and no others', () => {
    // `reviewOnly` is a promise about a layer's strongest answer, and getting it
    // wrong on a rejecting layer would silently disable that layer for any held
    // comment. The two layers that make the promise are the two that cost money to
    // ask — layer 7 in neurons (#10) and layer 8 in a third party's metered checks
    // (#11), which is not a coincidence but the reason the flag exists.
    const check = createSpamCheck({})
    const reviewOnly = check.layers.filter((layer) => layer.reviewOnly === true)

    expect(reviewOnly.map((layer) => layer.name)).toEqual(['classifier', 'provider'])
  })
})

describe('createSpamCheck — the assembled ordering', () => {
  it('assembles exactly the order #1 specifies', () => {
    // Pinned as a list, because the two behavioural tests below are satisfied by
    // any arrangement that keeps the honeypot first — moving Turnstile ahead of
    // timing, or content ahead of rate limiting, would break neither. "The
    // ordering is the design" has to be a property something checks.
    const check = createSpamCheck({})

    expect(check.layers.map((layer) => layer.name)).toEqual([...SPAM_LAYER_ORDER])
  })

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

  it('never spends a third-party check on a comment an earlier layer refused', async () => {
    // #11's whole economics. Akismet's paid tier is 500 checks a month, so a check
    // spent on a comment the honeypot already caught is a check the site owner paid
    // for an answer nobody needed.
    const asked: string[] = []
    const check = createSpamCheck(
      {},
      {
        provider: {
          siteUrl: 'https://maya.build',
          provider: {
            name: 'stub',
            check() {
              asked.push('check')
              return Promise.resolve('spam' as const)
            },
          },
        },
      },
    )

    const verdict = await check.check(
      contextFor({ form: goodForm({ [HONEYPOT_FIELD]: 'filled' }) }),
    )

    expect(verdict.action).toBe('reject')
    expect(asked).toHaveLength(0)
  })

  it('never spends a third-party check on a comment another layer already held', async () => {
    // The `reviewOnly` rule in situ, on the layer it matters most for. `runLayers`
    // keeps the first review's reason and layer 8 cannot reject, so its answer here
    // would be discarded — while still costing 1/500th of a month's allowance, to an
    // unauthenticated caller who need only omit one form field.
    const asked: string[] = []
    const check = createSpamCheck(
      {},
      {
        provider: {
          siteUrl: 'https://maya.build',
          provider: {
            name: 'stub',
            check() {
              asked.push('check')
              return Promise.resolve('spam' as const)
            },
          },
        },
      },
    )

    // No elapsed field, which is enough to make layer 2 hold every submission.
    const verdict = await check.check(
      contextFor({ form: goodForm({ [ELAPSED_FIELD]: undefined }) }),
    )

    expect(verdict.action).toBe('review')
    expect(asked).toHaveLength(0)
  })

  it('asks the provider, and holds the comment, when nothing above it had an opinion', async () => {
    const check = createSpamCheck(
      { IP_HASH_SECRET: 'ip-secret' },
      {
        provider: {
          siteUrl: 'https://maya.build',
          provider: { name: 'stub', check: () => Promise.resolve('spam' as const) },
        },
      },
    )

    const verdict = await check.check(contextFor({ form: goodForm() }))

    expect(verdict).toEqual({ action: 'review', reason: 'provider: stub' })
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

  it('costs at most five database reads once the classifier is wired in', async () => {
    // Five: one per-IP count, one per-thread count, the repeat-offender lookup (#184),
    // one duplicate-body lookup, and the classifier's model row (#10). Constant in the
    // number of comments *and* in
    // the number of comments the site has ever moderated, which is the rule the
    // 50-query budget produces (CLAUDE.md) and the property layer 7's single weight
    // vector exists to keep — a nearest-neighbour classifier would read one row per
    // stored vector right here.
    //
    // **The model must be past the cold-start gate for this to assert anything**, and
    // that is not a detail: below the gate the layer abstains before the embedding,
    // so a fixture with too little history measures the untrained path and reads as
    // coverage of the trained one. A kill-shot found exactly that here — an added
    // per-vector read on the classify path left this test green until the seeding
    // below reached MIN_LABELS_PER_CLASS in both classes.
    const trained = await import('../../../src/spam/train')
    const model = await import('../../../src/spam/model')
    const unit = (index: number) => {
      const vector = new Float32Array(8)
      vector[index] = 1
      return model.toUnitVector(vector)
    }

    const thread = await getOrCreateThread(db, { pageKey: '/notes/leaving', now: t0 })
    for (let i = 0; i < model.MIN_LABELS_PER_CLASS * 2; i++) {
      const body = `an earlier comment number ${i}, long enough to be a real one on this thread`
      const stored = await insertComment(db, {
        threadId: thread.id,
        authorName: `Reader ${i}`,
        body,
        bodyHash: await computeBodyHash(body),
        ipHash: null,
        now: t0 - DEFAULT_WINDOW_AGO,
      })
      await trained.trainOnDecision(stored.id, i % 2 === 0 ? 'spam' : 'approved', {
        db,
        embed: () => Promise.resolve(unit(i % 2)),
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

    // The model really is past the gate, or the five below is the untrained path
    // wearing the trained path's name.
    const { readSpamModel } = await import('../../../src/db')
    const fitted = await readSpamModel(db)
    expect(fitted?.hamCount).toBeGreaterThanOrEqual(model.MIN_LABELS_PER_CLASS)
    expect(fitted?.spamCount).toBeGreaterThanOrEqual(model.MIN_LABELS_PER_CLASS)

    const check = createSpamCheck(
      { IP_HASH_SECRET: 'ip-secret' },
      { classifier: { embed: () => Promise.resolve(unit(1)) } },
    )
    await check.check({ ...contextFor({ form: goodForm() }), db: counting })

    expect(statements).toHaveLength(5)
  })

  it('costs at most four database reads on a deployment with no Workers AI', async () => {
    // Four: one per-IP count, one per-thread count, the repeat-offender lookup, one
    // duplicate-body lookup. The classifier reads nothing at all without a binding —
    // it abstains before the model row, so the feature costs an unprovisioned
    // deployment exactly zero.
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

    expect(statements).toHaveLength(4)
  })

  it('costs two database reads on a deployment with no IP_HASH_SECRET', async () => {
    // Two: the per-thread count and the duplicate-body lookup. Both layers that need
    // an address to recognise anybody by — the per-IP half of layer 4 and the whole of
    // layer 5 — abstain before their read rather than after it, which is what makes
    // #184 free on a deployment that has not run `wrangler secret put`.
    const statements: string[] = []
    const counting = {
      ...db,
      prepare(sql: string) {
        statements.push(sql)
        return db.prepare(sql)
      },
    } as unknown as D1Database

    const check = createSpamCheck({})
    await check.check({ ...contextFor({ form: goodForm() }), db: counting })

    expect(statements).toHaveLength(2)
  })

  it('costs no more reads on a deployment with a long history of refusals', async () => {
    // The rule CLAUDE.md states, applied to the two new signals together: the count is
    // constant in the number of comments on the page, in the number the site has ever
    // moderated, and in the number it has ever refused from this address. A lookup that
    // listed a spammer's history instead of aggregating it would fail here and nowhere
    // else.
    const thread = await getOrCreateThread(db, { pageKey: '/notes/leaving', now: t0 })
    const ipHash = await hashIp('198.51.100.7', 'ip-secret')
    for (let i = 0; i < 25; i++) {
      const body = `an earlier comment number ${i}, long enough to be a real one on this thread`
      await db
        .prepare(
          `insert into comments (thread_id, author_name, author_email, body, body_hash, status,
                                 by_owner, ip_hash, created_at)
           values (?1, 'Someone', 'buy@pills.example', ?2, ?3, 'spam', 0, ?4, ?5)`,
        )
        .bind(thread.id, body, await computeBodyHash(body), ipHash, t0 - DEFAULT_WINDOW_AGO)
        .run()
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
    const verdict = await check.check({
      ...contextFor({ form: goodForm(), authorEmail: 'buy@pills.example' }),
      db: counting,
    })

    // Refused by layer 5, so layer 6 and after are never asked: three reads, not four.
    expect(verdict.action).toBe('reject')
    expect(statements).toHaveLength(3)
  })
})

/** Older than any rate-limit window, so the seeded history cannot trip layer 4. */
const DEFAULT_WINDOW_AGO = 86_400
