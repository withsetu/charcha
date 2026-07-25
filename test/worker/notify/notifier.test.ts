// The assembled notifier: whether it sends at all, and what it does when the send
// fails. Three properties are load-bearing and each has its own kill-shot —
// unconfigured means silently off, a failed send never becomes a rejection, and a
// burst cannot become a mail flood.

import { describe, expect, it } from 'vitest'
import { createNotifier, noopNotifier } from '../../../src/notify'
import type { CommentCreatedEvent } from '../../../src/notify'
import { NOTIFY_BURST, NOTIFY_REFILL_INTERVAL_MS, sendBudget } from '../../../src/notify/throttle'

const CONFIGURED = {
  RESEND_API_KEY: 'test-not-a-real-key',
  CHARCHA_NOTIFY_FROM: 'Charcha <comments@maya.build>',
  CHARCHA_NOTIFY_TO: 'maya@maya.build',
}

function eventFor(overrides: Partial<CommentCreatedEvent> = {}): CommentCreatedEvent {
  return {
    commentId: 412,
    authorName: 'Rahul Kanwar',
    body: 'The part people underestimate is the export.',
    pageKey: '/notes/leaving',
    pageUrl: 'https://maya.build/notes/leaving',
    status: 'pending',
    ...overrides,
  }
}

function recorder() {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl: typeof fetch = (_input, request) => {
    const sent = typeof request?.body === 'string' ? request.body : '{}'
    bodies.push(JSON.parse(sent) as Record<string, unknown>)
    return Promise.resolve(
      new Response(JSON.stringify({ id: 'sent' }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
  return { bodies, fetchImpl }
}

/** A clock the test moves, so nothing here depends on the wall clock. */
function clock(startMs = 1_753_300_000_000) {
  let nowMs = startMs
  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms
    },
  }
}

describe('when the owner has not configured notifications', () => {
  it('is silently off — no send, and no error', async () => {
    // Absence of an API key is a valid state, not a fault (#14). A deployment that
    // never sets one still takes comments, and never learns about Resend at all.
    const { bodies, fetchImpl } = recorder()
    const notifier = createNotifier({}, { fetch: fetchImpl })

    await expect(notifier.commentCreated(eventFor())).resolves.toBeUndefined()
    expect(bodies).toHaveLength(0)
  })

  it('stays off when the key is set but there is nowhere to send to', async () => {
    // All three are required together. A key with no recipient is a half-configured
    // deployment, and guessing a recipient is not available to us — there is no
    // account and no owner email anywhere in the schema.
    const { bodies, fetchImpl } = recorder()

    await createNotifier(
      {
        RESEND_API_KEY: CONFIGURED.RESEND_API_KEY,
        CHARCHA_NOTIFY_FROM: CONFIGURED.CHARCHA_NOTIFY_FROM,
      },
      { fetch: fetchImpl },
    ).commentCreated(eventFor())

    await createNotifier(
      {
        RESEND_API_KEY: CONFIGURED.RESEND_API_KEY,
        CHARCHA_NOTIFY_TO: CONFIGURED.CHARCHA_NOTIFY_TO,
      },
      { fetch: fetchImpl },
    ).commentCreated(eventFor())

    expect(bodies).toHaveLength(0)
  })

  it('treats a blank secret as unconfigured, not as a secret', async () => {
    const { bodies, fetchImpl } = recorder()
    const notifier = createNotifier({ ...CONFIGURED, RESEND_API_KEY: '   ' }, { fetch: fetchImpl })

    await notifier.commentCreated(eventFor())

    expect(bodies).toHaveLength(0)
  })

  it('the noop notifier sends nothing and resolves', async () => {
    await expect(noopNotifier.commentCreated(eventFor())).resolves.toBeUndefined()
  })
})

describe('when the owner has configured notifications', () => {
  it('sends one email for one comment', async () => {
    const { bodies, fetchImpl } = recorder()
    const notifier = createNotifier(CONFIGURED, { fetch: fetchImpl, budget: sendBudget() })

    await notifier.commentCreated(eventFor())

    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.to).toBe(CONFIGURED.CHARCHA_NOTIFY_TO)
    expect(bodies[0]?.from).toBe(CONFIGURED.CHARCHA_NOTIFY_FROM)
    expect(bodies[0]?.subject).toBe('New comment awaiting moderation')
  })

  it('never rejects, whatever the send did', async () => {
    // This is the property `ctx.waitUntil` depends on. A rejected promise handed to
    // waitUntil is an unreported failure, which CLAUDE.md names by name — so the
    // notifier reports its own failures and resolves, and the caller has nothing to
    // catch. Enforced here rather than trusted.
    const notifier = createNotifier(CONFIGURED, {
      fetch: () => Promise.reject(new Error('network is down')),
      budget: sendBudget(),
    })

    await expect(notifier.commentCreated(eventFor())).resolves.toBeUndefined()
  })

  it('never rejects even when something unforeseen throws inside it', async () => {
    // A stand-in for any bug this module could grow later. The clock throwing is
    // the cheapest way to make the *synchronous* part of commentCreated fail.
    const notifier = createNotifier(CONFIGURED, {
      fetch: recorder().fetchImpl,
      budget: sendBudget(),
      now: () => {
        throw new Error('no clock')
      },
    })

    await expect(notifier.commentCreated(eventFor())).resolves.toBeUndefined()
  })
})

describe('flood control — a spam burst must not become a mail flood', () => {
  it('stops sending once the burst allowance is spent', async () => {
    const { bodies, fetchImpl } = recorder()
    const time = clock()
    const notifier = createNotifier(CONFIGURED, {
      fetch: fetchImpl,
      budget: sendBudget(),
      now: time.now,
    })

    for (let i = 0; i < NOTIFY_BURST + 20; i += 1) {
      await notifier.commentCreated(eventFor({ commentId: i }))
    }

    expect(bodies).toHaveLength(NOTIFY_BURST)
  })

  it('tells the owner how many comments the suppressed ones were, on the next email', async () => {
    // The digest #14 asks for, without a table to hold one. The owner learns the
    // true count even though they did not get the true number of emails.
    const { bodies, fetchImpl } = recorder()
    const time = clock()
    const notifier = createNotifier(CONFIGURED, {
      fetch: fetchImpl,
      budget: sendBudget(),
      now: time.now,
    })

    for (let i = 0; i < NOTIFY_BURST + 7; i += 1) {
      await notifier.commentCreated(eventFor({ commentId: i }))
    }
    time.advance(NOTIFY_REFILL_INTERVAL_MS)
    await notifier.commentCreated(eventFor({ commentId: 999 }))

    expect(bodies).toHaveLength(NOTIFY_BURST + 1)
    expect(bodies.at(-1)?.subject).toBe('New comment awaiting moderation (+7 more)')
  })

  it('refills over time, so a quiet site is never throttled', async () => {
    const { bodies, fetchImpl } = recorder()
    const time = clock()
    const notifier = createNotifier(CONFIGURED, {
      fetch: fetchImpl,
      budget: sendBudget(),
      now: time.now,
    })

    for (let i = 0; i < 30; i += 1) {
      time.advance(NOTIFY_REFILL_INTERVAL_MS)
      await notifier.commentCreated(eventFor({ commentId: i }))
    }

    expect(bodies).toHaveLength(30)
  })
})

describe('the budget, on its own', () => {
  it('never accumulates more than its capacity, however long the site was quiet', () => {
    const budget = sendBudget({ capacity: 3, refillIntervalMs: 1_000 })

    // A year of silence must not buy a year's worth of tokens.
    expect(budget.take(0)).not.toBeNull()
    const later = 365 * 24 * 60 * 60 * 1_000
    let granted = 0
    for (let i = 0; i < 10; i += 1) {
      if (budget.take(later) !== null) granted += 1
    }

    expect(granted).toBe(3)
  })

  it('does not refill when the clock goes backwards', () => {
    const budget = sendBudget({ capacity: 1, refillIntervalMs: 1_000 })

    expect(budget.take(10_000)).not.toBeNull()
    expect(budget.take(0)).toBeNull()
  })
})
