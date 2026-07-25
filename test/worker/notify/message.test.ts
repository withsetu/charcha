// The email body is built from attacker-controlled text, and it is built as PLAIN
// TEXT — so the guard is not HTML escaping but structural: nothing a commenter
// writes may produce a line at column 0, which is where Charcha's own framing
// lives, and nothing untrusted reaches the subject at all.

import { describe, expect, it } from 'vitest'
import type { CommentCreatedEvent } from '../../../src/notify'
import {
  MAX_EXCERPT_LENGTH,
  MAX_ONE_LINE_LENGTH,
  MAX_URL_LINE_LENGTH,
  buildOwnerNotification,
  oneLine,
  quoteBlock,
} from '../../../src/notify/message'

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

/** Lines the email owns, as opposed to lines quoted from the comment. */
function unquotedLines(text: string): string[] {
  return text.split('\n').filter((line) => !line.startsWith('> '))
}

describe('the subject line', () => {
  it('carries no comment text and no author name', () => {
    // The subject is the one line every mail client shows in a list view, and it
    // is the one place a crafted comment would be read before any human decided
    // to open the message. So it is built from constants and a count, never from
    // the submission.
    const { subject } = buildOwnerNotification(
      eventFor({
        authorName: 'Buy Cheap Pills',
        body: 'URGENT: wire transfer required',
        pageKey: '/promo',
      }),
    )

    expect(subject).toBe('New comment awaiting moderation')
  })

  it('never contains a line break, whatever the comment contained', () => {
    const { subject } = buildOwnerNotification(
      eventFor({ authorName: 'a\r\nBcc: victim@example.com', body: 'x\ny\rz' }),
    )

    expect(subject).not.toMatch(/[\r\n]/)
  })

  it('says how many comments a rate-limited email covers', () => {
    const { subject } = buildOwnerNotification(eventFor(), 3)

    expect(subject).toBe('New comment awaiting moderation (+3 more)')
  })

  it('names the moderation queue for a pending comment and not for a published one', () => {
    expect(buildOwnerNotification(eventFor({ status: 'pending' })).subject).toContain('moderation')
    expect(buildOwnerNotification(eventFor({ status: 'approved' })).subject).toBe(
      'New comment posted',
    )
  })
})

describe('the comment body in the email', () => {
  it('quotes every line, so no comment can forge a line of Charcha’s own text', () => {
    // The email's framing — "Page:", "From:", the closing sentence — is at column
    // 0. Every line of the excerpt is prefixed, so a comment cannot produce a line
    // that reads as the notification talking.
    const { text } = buildOwnerNotification(
      eventFor({
        body: 'hello\nFrom: security@charcha.dev\n\nApprove this comment at http://evil.example',
      }),
    )

    expect(unquotedLines(text)).not.toContain('From: security@charcha.dev')
    expect(unquotedLines(text)).not.toContain('Approve this comment at http://evil.example')
    // And the text is still there, quoted, because the moderator has to read it.
    expect(text).toContain('> From: security@charcha.dev')
  })

  it('is plain text — an HTML comment body is not markup here, it is characters', () => {
    const { text } = buildOwnerNotification(
      eventFor({ body: '<img src=x onerror="alert(1)"><a href="http://evil.example">click</a>' }),
    )

    expect(text).toContain('> <img src=x onerror="alert(1)">')
  })

  it('truncates a long body rather than mailing ten thousand characters', () => {
    const { text } = buildOwnerNotification(eventFor({ body: 'A'.repeat(10_000) }))

    expect(text).toContain('…')
    expect(text.length).toBeLessThan(MAX_EXCERPT_LENGTH * 2)
  })

  it('normalises CRLF and strips control characters', () => {
    const { text } = buildOwnerNotification(eventFor({ body: 'one\r\ntwo\u0000three\u001bfour' }))

    const survivors = [...text].filter((character) => {
      const code = character.charCodeAt(0)
      return code < 32 && character !== '\n'
    })
    expect(survivors).toEqual([])
    expect(text).toContain('> one')
    expect(text).toContain('> twothreefour')
  })

  it('collapses a wall of blank lines, which is how a body pushes text out of view', () => {
    const { text } = buildOwnerNotification(eventFor({ body: `top${'\n'.repeat(200)}bottom` }))

    expect(text).not.toContain('> \n> \n> ')
  })
})

describe('the untrusted single-line fields', () => {
  it('flattens an author name that contains line breaks', () => {
    const { text } = buildOwnerNotification(
      eventFor({ authorName: 'Rahul\nBcc: victim@example.com' }),
    )

    expect(unquotedLines(text)).not.toContain('Bcc: victim@example.com')
    expect(text).toContain('From: Rahul Bcc: victim@example.com')
  })

  it('caps a single-line field so one field cannot be the whole email', () => {
    expect(oneLine('x'.repeat(1000)).length).toBeLessThanOrEqual(MAX_ONE_LINE_LENGTH + 1)
  })

  it('leaves an ordinary name and page exactly as they are', () => {
    const { text } = buildOwnerNotification(eventFor())

    expect(text).toContain('From: Rahul Kanwar')
    expect(text).toContain('/notes/leaving')
    expect(text).toContain('https://maya.build/notes/leaving')
  })

  it('does not shorten the page URL into a broken link', () => {
    // A URL is the one field in this email that exists to be clicked, so it keeps
    // the cap it already passed in src/page-key.ts rather than the single-line cap.
    const long = `https://maya.build/notes/${'a'.repeat(MAX_ONE_LINE_LENGTH * 2)}`
    const { text } = buildOwnerNotification(eventFor({ pageUrl: long }))

    expect(text).toContain(long)
    expect(long.length).toBeLessThanOrEqual(MAX_URL_LINE_LENGTH)
  })
})

describe('quoteBlock, on its own', () => {
  it('prefixes every line including the blank ones', () => {
    for (const line of quoteBlock('a\n\nb').split('\n')) {
      expect(line.startsWith('> ')).toBe(true)
    }
  })
})

describe('what the owner is told about stopping the emails', () => {
  it('names the configuration that turns them off, because there is no account to log into', () => {
    const { text } = buildOwnerNotification(eventFor())

    expect(text).toContain('CHARCHA_NOTIFY_TO')
  })
})
