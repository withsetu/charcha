// The email body, built from a comment nobody has moderated yet.
//
// **Plain text, and no HTML part at all.** That is the security decision in this
// module, and the argument is not aesthetic:
//
//   1. The body is attacker-controlled. Rendering it as HTML would hand it to a
//      mail client's parser, which is laxer and far more varied than a browser's —
//      the surface card rule 5 exists to keep narrow. A message with no HTML part
//      cannot carry an escaping bug, so there is no escaping to get wrong.
//   2. The transport is JSON over HTTPS, not SMTP, so `JSON.stringify` escapes CR
//      and LF and classic header injection is structurally unavailable. What a
//      commenter *can* still do in plain text is forge line structure — write a
//      line that reads as Charcha talking rather than as the comment.
//
// So the guard here is structural rather than character-level: every line of
// commenter text is quote-prefixed, and Charcha's own framing is the only thing at
// column 0. Nothing untrusted reaches the subject line at all.
// Enforced by test/worker/notify/message.test.ts.

import { MAX_URL_LENGTH } from '../page-key'
import type { CommentCreatedEvent } from './index'

/**
 * How much of a comment body the email carries.
 *
 * A body may be 10,000 characters (src/submit/schema.ts), and a notification is a
 * prompt to open the dashboard rather than a copy of the database. Truncating also
 * bounds what a spam flood can push through the owner's own sending domain, which
 * is their reputation rather than ours.
 */
export const MAX_EXCERPT_LENGTH = 500

/**
 * How much of a single-line field — an author name, a page key — the email carries.
 *
 * Above the schema's 80-character cap on `author_name`, so it never truncates a
 * name a submission could have carried; it is the backstop for a field that reached
 * here from somewhere the schema did not check.
 */
export const MAX_ONE_LINE_LENGTH = 120

/**
 * The cap on the page URL line, which is the *same* cap the URL already passed in
 * src/page-key.ts rather than a shorter one.
 *
 * Deliberately not `MAX_ONE_LINE_LENGTH`. A truncated URL is a broken link, and
 * this line exists to be clicked — shortening it would trade a long line for a
 * useless one. The URL is Worker-derived (`derivePageKey` re-serialises it through
 * `new URL()`), so it is the least attacker-shaped of the three fields; it still
 * goes through `oneLine`, because "nothing untrusted reaches the email except
 * through `oneLine` or `quoteBlock`" is only a property if it has no exceptions.
 */
export const MAX_URL_LINE_LENGTH = MAX_URL_LENGTH

const QUOTE_PREFIX = '> '

/**
 * C0 and C1 control characters, DEL, and the two Unicode line separators, minus
 * the ones a plain-text email legitimately contains. Tab and newline survive here;
 * `oneLine` has already removed both by the time it calls this.
 */
const CONTROL_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- the control characters are the point of this expression
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`
}

/**
 * Flattens untrusted text to exactly one line, capped.
 *
 * Used for every field that appears next to a label at column 0. Without it an
 * author name containing a newline writes its own line in the email — "Bcc:
 * victim@example.com" reads as a header to a human even where it is not one to a
 * mail server.
 * Enforced by test/worker/notify/message.test.ts.
 */
export function oneLine(text: string, maxLength = MAX_ONE_LINE_LENGTH): string {
  const flattened = text.replace(/\s+/g, ' ').replace(CONTROL_CHARACTERS, '').trim()
  return truncate(flattened, maxLength)
}

/**
 * Turns a comment body into a quoted block, capped.
 *
 * Every line — including the blank ones — starts with `> `, which is what makes
 * "no comment can forge a line of Charcha's own text" a property rather than a
 * hope: the notification's own lines are the only ones at column 0. Runs of blank
 * lines collapse, because a body of two hundred newlines is how a comment pushes
 * the rest of the email out of a reading pane.
 * Enforced by test/worker/notify/message.test.ts.
 */
export function quoteBlock(text: string, maxLength = MAX_EXCERPT_LENGTH): string {
  const normalised = text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARACTERS, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return truncate(normalised, maxLength)
    .split('\n')
    .map((line) => `${QUOTE_PREFIX}${line}`)
    .join('\n')
}

export interface EmailBody {
  subject: string
  text: string
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}

/**
 * Builds the site owner's new-comment notification.
 *
 * `suppressed` is how many notifications the send budget dropped since the last one
 * it allowed (src/notify/throttle.ts). It rides in this email rather than in emails
 * of its own, which is the digest #14 asks for: the owner learns the true number of
 * comments without receiving the true number of emails.
 *
 * The subject is built from constants and that count, never from the submission. It
 * is the one line a mail client shows before any human decides to open the message,
 * so it is the one place a crafted comment would be read unconditionally.
 * Enforced by test/worker/notify/message.test.ts.
 */
export function buildOwnerNotification(event: CommentCreatedEvent, suppressed = 0): EmailBody {
  const pending = event.status === 'pending'
  const headline = pending ? 'New comment awaiting moderation' : 'New comment posted'

  const lines: string[] = [
    pending
      ? 'A new comment is waiting in the Charcha moderation queue.'
      : 'A new comment was posted.',
    '',
    `Page: ${oneLine(event.pageKey)}`,
  ]
  if (event.pageUrl !== null) lines.push(oneLine(event.pageUrl, MAX_URL_LINE_LENGTH))
  lines.push(`From: ${oneLine(event.authorName)}`, '', quoteBlock(event.body), '')

  if (suppressed > 0) {
    lines.push(
      `${suppressed} further ${plural(suppressed, 'comment')} arrived while notifications ` +
        'were rate-limited. This email covers them; the dashboard has all of them.',
      '',
    )
  }

  lines.push(
    'Open the moderation queue in your Charcha dashboard to approve or reject it.',
    '',
    'You are getting this because CHARCHA_NOTIFY_TO is set on your Charcha Worker.',
    'Unset it to stop these emails.',
  )

  return {
    subject: suppressed > 0 ? `${headline} (+${suppressed} more)` : headline,
    text: lines.join('\n'),
  }
}
