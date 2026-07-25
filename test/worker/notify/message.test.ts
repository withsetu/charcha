// The email body is built from attacker-controlled text, and it is built as PLAIN
// TEXT — so the guard is not HTML escaping but structural: nothing a commenter
// writes may produce a line at column 0, which is where Charcha's own framing
// lives, and nothing untrusted reaches the subject at all.

import { describe, expect, it } from 'vitest'
import type { CommentCreatedEvent } from '../../../src/notify'
import {
  MAX_EXCERPT_LENGTH,
  MAX_ONE_LINE_LENGTH,
  buildOwnerNotification,
  oneLine,
  quoteBlock,
} from '../../../src/notify/message'

/**
 * One codepoint per class the sanitiser names: bell, ESC, DEL, NEL (C1, and NOT
 * matched by JavaScript's \s, so only the character filter removes it), both Unicode
 * line separators, a bidi override, a bidi isolate, and a zero-width space.
 */
const FORBIDDEN = [
  '\u0007',
  '\u001b',
  '\u007f',
  '\u0085',
  '\u2028',
  '\u2029',
  '\u202e',
  '\u2066',
  '\u200b',
]

/** Whichever of FORBIDDEN survived into the email. */
function survivors(text: string): string[] {
  return [...text].filter((character) => FORBIDDEN.includes(character))
}

function eventFor(overrides: Partial<CommentCreatedEvent> = {}): CommentCreatedEvent {
  return {
    commentId: 412,
    authorName: 'Rahul Kanwar',
    body: 'The part people underestimate is the export.',
    pageKey: '/notes/leaving',
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

  it('normalises CRLF and strips every class of invisible character', () => {
    const { text } = buildOwnerNotification(
      eventFor({ body: `one\r\ntwo${FORBIDDEN.join('')}three` }),
    )

    expect(survivors(text)).toEqual([])
    expect(text).toContain('> one')
    expect(text).toContain('> twothree')
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
    expect(text).toContain('Page: /notes/leaving')
  })

  it('strips invisible characters from a single-line field too', () => {
    // Not only from the quoted body. Without this an author name carrying an ANSI
    // escape reaches an owner reading mail in a terminal client, and a bidi override
    // makes the `From:` line render as something other than what is stored.
    expect(oneLine(`a${FORBIDDEN.join('')}b`)).toBe('ab')

    const { text } = buildOwnerNotification(
      eventFor({ authorName: `Rahul${FORBIDDEN.join('')}Kanwar` }),
    )
    expect(survivors(text)).toEqual([])
    expect(text).toContain('From: RahulKanwar')
  })

  it('does not leave a double space where an invisible character was removed', () => {
    expect(oneLine('A \u0000 B')).toBe('A B')
  })

  it('carries no absolute URL at all, because the origin in one is attacker-chosen', () => {
    // `derivePageKey` drops the origin from a thread key — "the origin is not
    // identity", src/page-key.ts — so a submission reporting a foreign origin lands
    // on the real thread. Printing it as the page to click would have the owner’s
    // own sending domain sign a phishing link. The event has no field for it.
    const { text } = buildOwnerNotification(eventFor())

    expect(text).not.toMatch(/https?:/)
    expect(text).toContain('Page: /notes/leaving')
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
