// The one outbound call. Everything asserted here is from Resend's API reference,
// checked 2026-07-25 — see the citations in src/notify/resend.ts.
//
// Nothing in this file reaches api.resend.com, and there is no real API key
// anywhere in it. `fetch` is injected, exactly as src/spam/turnstile.ts injects
// siteverify.

import { describe, expect, it } from 'vitest'
import { RESEND_SEND_URL, sendEmail } from '../../../src/notify/resend'
import type { EmailMessage } from '../../../src/notify/resend'

const API_KEY = 'test-not-a-real-key'

const message: EmailMessage = {
  fromAddress: 'comments@maya.build',
  fromName: 'Charcha',
  to: 'maya@maya.build',
  subject: 'New comment awaiting moderation',
  text: 'A new comment is waiting.',
}

interface Call {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

function resend(body: unknown, init: ResponseInit = {}) {
  const calls: Call[] = []
  const fetchImpl: typeof fetch = (input, request) => {
    const sent = typeof request?.body === 'string' ? request.body : '{}'
    calls.push({
      url: urlOf(input),
      headers: new Headers(request?.headers),
      body: JSON.parse(sent) as Record<string, unknown>,
    })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        ...init,
      }),
    )
  }
  return { calls, fetchImpl }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('sendEmail — the documented request', () => {
  it('posts to the documented endpoint with a Bearer key', async () => {
    const { calls, fetchImpl } = resend({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' })

    await sendEmail(message, { apiKey: API_KEY, fetch: fetchImpl })

    expect(calls[0]?.url).toBe(RESEND_SEND_URL)
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
    expect(calls[0]?.headers.get('content-type')).toBe('application/json')
  })

  it('sends exactly from, to, subject and text — and no `html` field', async () => {
    // The absence of `html` is the guard, not an omission. A pending comment's body
    // is unmoderated, attacker-controlled text; an HTML email would put it through
    // a mail client's parser, which is laxer and more varied than a browser's. A
    // payload with no HTML part cannot carry an escaping bug.
    const { calls, fetchImpl } = resend({ id: 'x' })

    await sendEmail(message, { apiKey: API_KEY, fetch: fetchImpl })

    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(['from', 'subject', 'text', 'to'])
    expect(calls[0]?.body).toEqual({
      // Composed here from the two fields the message carries separately (#208) — the
      // one shape Resend documents, `Name <email@example.com>`.
      from: 'Charcha <comments@maya.build>',
      to: message.to,
      subject: message.subject,
      text: message.text,
    })
  })

  it('sends no reply_to, cc, bcc, headers or tags — nothing about the commenter travels', async () => {
    const { calls, fetchImpl } = resend({ id: 'x' })

    await sendEmail(message, { apiKey: API_KEY, fetch: fetchImpl })

    for (const key of ['reply_to', 'cc', 'bcc', 'headers', 'tags', 'attachments', 'html']) {
      expect(calls[0]?.body).not.toHaveProperty(key)
    }
  })

  it('sends an Idempotency-Key when given one, so a repeated invocation cannot double-mail', async () => {
    const { calls, fetchImpl } = resend({ id: 'x' })

    await sendEmail(
      { ...message, idempotencyKey: 'charcha-comment-412' },
      {
        apiKey: API_KEY,
        fetch: fetchImpl,
      },
    )

    expect(calls[0]?.headers.get('idempotency-key')).toBe('charcha-comment-412')
  })

  it('returns the id Resend answers with', async () => {
    const { fetchImpl } = resend({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' })

    const outcome = await sendEmail(message, { apiKey: API_KEY, fetch: fetchImpl })

    expect(outcome).toEqual({ ok: true, id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' })
  })
})

describe('sendEmail — failure, which must never become an exception', () => {
  it('reports a 429 rather than throwing, and does not retry', async () => {
    // "The default maximum rate limit is 10 requests per second per team", and a
    // 429 is what exceeding it returns. Retrying a 429 makes a flood worse, so
    // there is no retry: the send is dropped and the failure is reported.
    const { calls, fetchImpl } = resend({ name: 'rate_limit_exceeded' }, { status: 429 })

    const outcome = await sendEmail(message, { apiKey: API_KEY, fetch: fetchImpl })

    expect(outcome).toEqual({ ok: false, reason: 'http-429' })
    expect(calls).toHaveLength(1)
  })

  it('reports a rejected key rather than throwing', async () => {
    const { fetchImpl } = resend({ name: 'missing_api_key' }, { status: 401 })

    expect(await sendEmail(message, { apiKey: API_KEY, fetch: fetchImpl })).toEqual({
      ok: false,
      reason: 'http-401',
    })
  })

  it('reports an unreachable API rather than throwing', async () => {
    const outcome = await sendEmail(message, {
      apiKey: API_KEY,
      fetch: () => Promise.reject(new Error('network is down')),
    })

    expect(outcome).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('gives up on a call that never answers', async () => {
    const outcome = await sendEmail(message, {
      apiKey: API_KEY,
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        }),
    })

    expect(outcome).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('treats a 2xx whose body it cannot parse as sent, because it was', async () => {
    // The errors page classifies failures by name and status but does not publish
    // the response schema, so this code reads the status and treats the body as
    // opaque. A 200 means Resend accepted the message; failing it because the id
    // did not parse would report a delivery failure that did not happen.
    const outcome = await sendEmail(message, {
      apiKey: API_KEY,
      fetch: () => Promise.resolve(new Response('not json')),
    })

    expect(outcome).toEqual({ ok: true, id: null })
  })
})

describe('the From line (#208)', () => {
  // The display name is owner configuration that ends up in a mail header, which makes it
  // the highest-risk string this project sends. `formatFrom` is the guard and
  // test/worker/notify/from.test.ts is where its rules are pinned; these two assert that
  // the payload actually goes through it, which is the part a refactor could quietly undo.
  it('composes the name and the address into the one field Resend takes', async () => {
    const { calls, fetchImpl } = resend({ id: 'x' })

    await sendEmail({ ...message, fromName: 'maya.build comments' }, { apiKey: API_KEY, fetch: fetchImpl })

    expect(calls[0]?.body.from).toBe('maya.build comments <comments@maya.build>')
  })

  it('never lets a display name change which address the mail claims to be from', async () => {
    const { calls, fetchImpl } = resend({ id: 'x' })

    for (const fromName of [
      'Charcha\r\nBcc: victim@example.com',
      'Charcha <security@bank.example>',
      'a"b',
      null,
    ]) {
      await sendEmail({ ...message, fromName }, { apiKey: API_KEY, fetch: fetchImpl })
    }

    for (const call of calls) expect(call.body.from).toBe('comments@maya.build')
  })
})
