// The submission pipeline: validate -> derive the thread key -> run the spam seam
// -> persist -> render. One pass, ordered so that nothing writes until a comment
// has passed every free local check (#8 slots in at the seam). Card rule 5.
//
// This function owns the *order*; the HTTP boundary (route.ts) owns reading and
// size-capping the body, and the data layer (src/db) owns the queries. Keeping the
// order here, injectable and clock-free, is what makes every branch testable
// against a real D1 binding.
// Enforced by test/worker/submit/pipeline.test.ts.

import type { CommentStrings } from '../render'
import { renderComments } from '../render'
import { getOrCreateThread, insertComment, isReplyTarget } from '../db'
import type { StoredComment } from '../db'
import { derivePageKey, messageForPageKeyRejection } from '../page-key'
import { computeBodyHash } from './hash'
import { parseComment } from './schema'
import type { SpamCheck } from './spam'

export interface SubmitDeps {
  db: D1Database
  spamCheck: SpamCheck
  /** The inbound request, passed to the spam seam for the client IP and headers. */
  request: Request
  /** Unix seconds. Injected, never read from a clock here, so tests own time. */
  now: number
  /**
   * Query parameters that are page identity on this site. Owner configuration
   * (settings), defaulting to none — so no tracking parameter can fork a thread
   * until the owner names one. See src/page-key.ts.
   */
  significantParams?: readonly string[]
  strings?: CommentStrings
}

export type SubmitResult =
  | { outcome: 'published'; html: string }
  | { outcome: 'pending'; html: string }
  | { outcome: 'rejected'; message: string }
  | { outcome: 'invalid'; message: string }

/**
 * Deliberately generic. Telling a bot *which* layer stopped it — honeypot, timing,
 * a rate limit — is telling it how to get past next time. The reader who is not a
 * bot never sees this because a real submission is not rejected here.
 */
const SPAM_REJECTED_MESSAGE = 'This comment could not be posted.'

/**
 * One message for every ineligible parent — missing, still in the queue, marked
 * spam, on another page, or itself a reply.
 *
 * Deliberately not four messages. Telling the difference apart answers "does
 * comment 412 exist, and has the moderator approved it?" to anyone willing to send
 * a submission, which turns the reply field into an oracle over the moderation
 * queue. The reader who is not probing sees this only if the comment they clicked
 * reply on was taken down between the page load and the submission, and "not
 * available" is exactly what happened.
 * Enforced by test/worker/submit/route.test.ts.
 */
const INELIGIBLE_PARENT_MESSAGE = 'That comment is not available to reply to.'

export async function runSubmission(input: unknown, deps: SubmitDeps): Promise<SubmitResult> {
  const parsed = parseComment(input)
  if (!parsed.ok) return { outcome: 'invalid', message: parsed.message }
  const comment = parsed.value

  // The key is DERIVED from the reported URL and optional data-thread override — it
  // is never accepted over the wire. This is the trust boundary from src/page-key.ts.
  const key = derivePageKey({
    url: comment.url ?? null,
    thread: comment.thread ?? null,
    significantParams: deps.significantParams,
  })
  if (!key.ok) return { outcome: 'invalid', message: messageForPageKeyRejection(key.reason) }

  // The spam seam runs before any write, so a rejected comment costs nothing —
  // no thread row, no comment row. #8 implements the layers; the default allows.
  const verdict = await deps.spamCheck.check({
    comment,
    form: input as Record<string, unknown>,
    pageKey: key.pageKey,
    pageUrl: key.pageUrl,
    request: deps.request,
    db: deps.db,
    now: deps.now,
  })
  if (verdict.action === 'reject') return { outcome: 'rejected', message: SPAM_REJECTED_MESSAGE }

  const bodyHash = await computeBodyHash(comment.body)

  const thread = await getOrCreateThread(deps.db, {
    pageKey: key.pageKey,
    pageUrl: key.pageUrl,
    title: comment.title ?? null,
    now: deps.now,
  })

  // A reply's parent has to be one this thread can be replied to, and that is asked
  // here rather than discovered at the insert. The triggers refuse an ineligible
  // parent either way — they just do it by aborting, which is a 500 for something
  // the reader did. One statement, and only when there is a parent at all: a root
  // comment, which is nearly all of them, costs nothing extra, so the query count on
  // this path stays constant (#48).
  if (comment.parentId !== undefined) {
    if (!(await isReplyTarget(deps.db, thread.id, comment.parentId))) {
      return { outcome: 'invalid', message: INELIGIBLE_PARENT_MESSAGE }
    }
  }

  // No status is passed: insertComment derives it from byOwner, which this public
  // path never sets, so the comment is stored `pending` and enters the moderation
  // queue. A public handler that could choose the status could self-approve.
  const stored = await insertComment(deps.db, {
    threadId: thread.id,
    parentId: comment.parentId ?? null,
    authorName: comment.authorName,
    authorEmail: comment.authorEmail ?? null,
    body: comment.body,
    bodyHash,
    now: deps.now,
  })

  const html = renderSingle(stored, deps.strings)
  return stored.status === 'approved'
    ? { outcome: 'published', html }
    : { outcome: 'pending', html }
}

/**
 * Renders the one comment just stored, as the reader's confirmation, through the
 * same renderer the page uses (card rule 4 — one renderer, HTML not JSON).
 *
 * `parentId` is flattened to null for the echo: renderComments drops a reply whose
 * parent is not also in the list (it has no root to nest under), which is correct
 * for a page but would make a lone reply-confirmation vanish. Shown by itself, out
 * of any thread, the comment is rendered as a standalone item — this is the
 * reader's receipt, not the page.
 */
function renderSingle(stored: StoredComment, strings?: CommentStrings): string {
  return renderComments([{ ...stored, parentId: null }], strings)
}
