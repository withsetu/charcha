// The embed's half of the transport contract: the URL it reads from, the JSON it
// posts, and how a refusal becomes a sentence a reader can act on.

import { describe, expect, it } from 'vitest'
import {
  MAX_SERVER_MESSAGE_LENGTH,
  messageForWriteFailure,
  readUrl,
  submissionBody,
} from '../../../src/embed/api'

describe('readUrl', () => {
  it('asks for the page it is on', () => {
    const url = new URL(readUrl('https://charcha.example.com', 'https://maya.build/notes/x', null))
    expect(url.origin + url.pathname).toBe('https://charcha.example.com/comments')
    expect(url.searchParams.get('url')).toBe('https://maya.build/notes/x')
    expect(url.searchParams.has('thread')).toBe(false)
  })

  it('carries the thread override when the owner set one', () => {
    const url = new URL(readUrl('https://charcha.example.com', 'https://maya.build/x', 'leaving'))
    expect(url.searchParams.get('thread')).toBe('leaving')
  })

  it('keeps a deployment served from a subpath working', () => {
    // A Worker on a custom domain can be routed at /charcha/*, and the base is
    // derived from the script's own URL — so it is not always a bare origin.
    const url = new URL(readUrl('https://maya.build/charcha', 'https://maya.build/x', null))
    expect(url.pathname).toBe('/charcha/comments')
  })

  it('percent-encodes the page address rather than splicing it in', () => {
    const url = readUrl('https://c.example', 'https://maya.build/a?b=1&c=2#d', null)
    expect(url).toContain('%3Fb%3D1%26c%3D2')
    // One `?` in the whole URL: the page's own query cannot become ours.
    expect(url.split('?').length).toBe(2)
  })
})

describe('submissionBody', () => {
  const base = {
    body: 'Hello',
    authorName: 'Maya',
    authorEmail: '',
    parentId: null,
    pageUrl: 'https://maya.build/x',
    thread: null,
    title: 'A page',
    elapsedMs: 4210.7,
    turnstileToken: null,
  }

  it('sends the fields the schema names', () => {
    expect(submissionBody(base)).toMatchObject({
      body: 'Hello',
      authorName: 'Maya',
      url: 'https://maya.build/x',
      title: 'A page',
    })
  })

  it('always sends an empty honeypot under the agreed name', () => {
    // Renaming this disarms layer 1 on every deployment still serving a cached
    // embed.js — silently, and only on the attack path (#8).
    expect(submissionBody(base)['subject']).toBe('')
  })

  it('sends the time the form was open as a whole number of milliseconds', () => {
    // A duration, never a timestamp: a duration has no clock in it to disagree with
    // the server's, so clock skew cannot reject a real reader (#8).
    expect(submissionBody(base)['t']).toBe(4211)
  })

  it('never sends a negative duration', () => {
    expect(submissionBody({ ...base, elapsedMs: -1 })['t']).toBe(0)
  })

  it('omits an email the reader did not give, rather than sending an empty one', () => {
    expect('authorEmail' in submissionBody(base)).toBe(false)
    expect(submissionBody({ ...base, authorEmail: 'maya@example.com' })['authorEmail']).toBe(
      'maya@example.com',
    )
  })

  it('omits parentId on a root comment and sends it on a reply', () => {
    expect('parentId' in submissionBody(base)).toBe(false)
    expect(submissionBody({ ...base, parentId: 12 })['parentId']).toBe(12)
  })

  it('omits the Turnstile token when the owner has not configured Turnstile', () => {
    expect('cf-turnstile-response' in submissionBody(base)).toBe(false)
    expect(submissionBody({ ...base, turnstileToken: 'tok' })['cf-turnstile-response']).toBe('tok')
  })
})

describe('messageForWriteFailure', () => {
  it('shows the reader what the server said about their own input', () => {
    expect(messageForWriteFailure(400, 'A name is required.')).toBe('A name is required.')
    expect(messageForWriteFailure(413, 'That request was too large.')).toBe(
      'That request was too large.',
    )
  })

  it('shows the refusal for a comment the server would not take', () => {
    expect(messageForWriteFailure(403, 'This comment could not be posted.')).toBe(
      'This comment could not be posted.',
    )
  })

  it('never blames the reader for a server fault', () => {
    const message = messageForWriteFailure(500, 'Internal error')
    expect(message).not.toContain('Internal error')
    expect(message.length).toBeGreaterThan(0)
  })

  it('says something specific when the server said nothing', () => {
    expect(messageForWriteFailure(400, '   ').length).toBeGreaterThan(10)
  })

  it('caps how much of the answer it will repeat', () => {
    // The base URL is owner configuration and can point anywhere. A body that is
    // not our own 400 must not become a wall of text on a reader's page.
    const long = 'x'.repeat(MAX_SERVER_MESSAGE_LENGTH + 500)
    expect(messageForWriteFailure(400, long).length).toBeLessThanOrEqual(
      MAX_SERVER_MESSAGE_LENGTH + 1,
    )
  })

  it('strips control characters out of anything it repeats', () => {
    expect(messageForWriteFailure(400, 'A name\x07\x00 is required.')).toBe('A name is required.')
  })

  it('refuses a body that is not the plain sentence the contract promises', () => {
    // If it contains markup it is not our plain-text error. The embed only ever
    // writes this through textContent, so this is the second lock, not the first.
    const message = messageForWriteFailure(400, '<b>hi</b>')
    expect(message).not.toContain('<')
  })
})
