// The seam between the submission pipeline and the notifier.
//
// Three properties, each with its own kill-shot: a notification never blocks or
// fails a reader's submission, a rejected comment never mails at all, and the
// commenter's email address never reaches the notifier.

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { createNotifier } from '../../../src/notify'
import type { CommentCreatedEvent, Notifier } from '../../../src/notify'
import { sendBudget } from '../../../src/notify/throttle'
import { runSubmission } from '../../../src/submit/pipeline'
import { allowAllSpamCheck } from '../../../src/submit/spam'
import type { SpamCheck, SpamVerdict } from '../../../src/submit/spam'

const db = env.DB
const t0 = 1_753_300_000
const request = new Request('https://charcha.example/comments', { method: 'POST' })

const validRoot = {
  authorName: 'Rahul Kanwar',
  body: 'The part people underestimate is the export.',
  url: 'https://maya.build/notes/leaving',
}

function verdict(action: SpamVerdict): SpamCheck {
  return { check: () => Promise.resolve(action) }
}

/** Collects what was deferred, so a test can await it deliberately. */
function deferrer() {
  const deferred: Promise<unknown>[] = []
  const defer = (work: Promise<unknown>) => {
    deferred.push(work)
  }
  const settle = () => Promise.allSettled(deferred)
  return { deferred, defer, settle }
}

function spy() {
  const events: CommentCreatedEvent[] = []
  const notifier: Notifier = {
    commentCreated(event) {
      events.push(event)
      return Promise.resolve()
    },
  }
  return { events, notifier }
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

describe('what the pipeline hands the notifier', () => {
  it('notifies with the stored comment, once, for an accepted comment', async () => {
    const { events, notifier } = spy()
    const run = deferrer()

    const result = await runSubmission(validRoot, {
      db,
      spamCheck: allowAllSpamCheck,
      request,
      now: t0,
      notifier,
      defer: run.defer,
    })
    await run.settle()

    expect(result.outcome).toBe('pending')
    expect(events).toHaveLength(1)
    expect(events[0]?.authorName).toBe('Rahul Kanwar')
    expect(events[0]?.body).toBe(validRoot.body)
    expect(events[0]?.pageKey).toBe('/notes/leaving')
    // No absolute URL: its origin is attacker-chosen. See src/notify/index.ts.
    expect(events[0]).not.toHaveProperty('pageUrl')
    expect(JSON.stringify(events)).not.toContain('maya.build')
    expect(events[0]?.status).toBe('pending')
    expect(events[0]?.commentId).toBeGreaterThan(0)
  })

  it('never hands over the commenter’s email address', async () => {
    // `author_email` is collected for reply notifications, which v1 does not send,
    // and the embed's privacy line promises it is never rendered. It is also not
    // the owner's notification's business: putting it in the email would transmit a
    // reader's address to Resend, which is the disclosure layer 8 is opt-in to
    // avoid. The event type has no field for it — this asserts the pipeline does
    // not smuggle it through another one.
    const { events, notifier } = spy()
    const run = deferrer()

    await runSubmission(
      { ...validRoot, authorEmail: 'rahul@example.com' },
      { db, spamCheck: allowAllSpamCheck, request, now: t0, notifier, defer: run.defer },
    )
    await run.settle()

    expect(JSON.stringify(events)).not.toContain('rahul@example.com')
    expect(JSON.stringify(events)).not.toContain('example.com')
  })

  it('notifies for a comment a spam layer held for review — it is in the queue too', async () => {
    const { events, notifier } = spy()
    const run = deferrer()

    await runSubmission(validRoot, {
      db,
      spamCheck: verdict({ action: 'review', reason: 'turnstile:unreachable' }),
      request,
      now: t0,
      notifier,
      defer: run.defer,
    })
    await run.settle()

    expect(events).toHaveLength(1)
  })

  it('sends nothing for a comment the spam layers rejected', async () => {
    // The cheapest flood control there is, and it comes free from where the seam
    // sits: layers 1-5 run before the write, and the notification is after it. A
    // rejected flood costs zero emails and zero Resend quota.
    const { events, notifier } = spy()
    const run = deferrer()

    const result = await runSubmission(validRoot, {
      db,
      spamCheck: verdict({ action: 'reject', reason: 'honeypot:filled' }),
      request,
      now: t0,
      notifier,
      defer: run.defer,
    })
    await run.settle()

    expect(result.outcome).toBe('rejected')
    expect(events).toHaveLength(0)
  })

  it('sends nothing for an invalid submission', async () => {
    const { events, notifier } = spy()
    const run = deferrer()

    await runSubmission(
      { authorName: '', body: '' },
      { db, spamCheck: allowAllSpamCheck, request, now: t0, notifier, defer: run.defer },
    )
    await run.settle()

    expect(events).toHaveLength(0)
  })
})

describe('a notification can never cost the reader their comment', () => {
  it('does not wait for the send — a Resend that never answers still returns a 202', async () => {
    // The whole reason the seam takes a `defer`. If the pipeline awaited this, a
    // slow or hanging Resend would hold the reader's POST open behind it.
    const run = deferrer()
    const notifier = createNotifier(
      { RESEND_API_KEY: 'test-not-a-real-key' },
      { from: 'comments@maya.build', to: 'maya@maya.build', fromName: 'Charcha' },
      { fetch: () => new Promise(() => {}), budget: sendBudget() },
    )

    const result = await runSubmission(validRoot, {
      db,
      spamCheck: allowAllSpamCheck,
      request,
      now: t0,
      notifier,
      defer: run.defer,
    })

    expect(result.outcome).toBe('pending')
    expect(run.deferred).toHaveLength(1)
  })

  it('stores and acknowledges the comment even when the notifier throws synchronously', async () => {
    // Defence in depth over the Notifier contract rather than trust in it. A
    // notifier bug must not turn a stored comment into a 500 for the reader.
    const notifier: Notifier = {
      commentCreated() {
        throw new Error('notifier is broken')
      },
    }
    const run = deferrer()

    const result = await runSubmission(validRoot, {
      db,
      spamCheck: allowAllSpamCheck,
      request,
      now: t0,
      notifier,
      defer: run.defer,
    })

    expect(result.outcome).toBe('pending')
    const stored = await db.prepare('select count(*) as n from comments').first<{ n: number }>()
    expect(stored?.n).toBe(1)
  })

  it('stores and acknowledges the comment when `defer` itself throws', async () => {
    const { notifier } = spy()

    const result = await runSubmission(validRoot, {
      db,
      spamCheck: allowAllSpamCheck,
      request,
      now: t0,
      notifier,
      defer: () => {
        throw new Error('waitUntil is unavailable')
      },
    })

    expect(result.outcome).toBe('pending')
  })
})

describe('the seam is inert until both halves are wired', () => {
  it('does nothing with a notifier but no way to defer it', async () => {
    // Deliberately not "await it instead". A notifier without a `defer` has only
    // two other options — block the reader, or drop the promise — and both are
    // worse than not notifying. Both halves, or neither.
    const { events, notifier } = spy()

    const result = await runSubmission(validRoot, {
      db,
      spamCheck: allowAllSpamCheck,
      request,
      now: t0,
      notifier,
    })

    expect(result.outcome).toBe('pending')
    expect(events).toHaveLength(0)
  })

  it('does nothing with a defer but no notifier — the current wiring', async () => {
    const run = deferrer()

    const result = await runSubmission(validRoot, {
      db,
      spamCheck: allowAllSpamCheck,
      request,
      now: t0,
      defer: run.defer,
    })

    expect(result.outcome).toBe('pending')
    expect(run.deferred).toHaveLength(0)
  })
})
