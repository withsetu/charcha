// The data layer. Every query lives here, so the query budget is countable in one
// place: D1's free tier allows 50 queries per Worker invocation, which makes a
// per-comment query a ceiling rather than a slowdown. Rendering a page is
// getOrCreateThread + listThreadComments, and nothing in this file loops.
//
// Times are unix seconds and always passed in, never read from the clock here —
// the caller owns "now" so tests can own it too.

// RenderableComment is the renderer's type and is imported rather than declared
// here (#94). The dependency runs this way round because the renderer is the
// general half — D1 is one source of rows and the v1.1 build-time path is another
// — and because a shape owned here would drag Cloudflare's ambient types into
// every program that renders, which is what kept the embed's DOM tests from
// building their fixtures out of the real renderer.
//
// Deliberately not re-exported: one type, one import path, or the next reader
// declares a second one here and the two drift.
import type { RenderableComment } from '../render'
// The set of statuses the cascade applies to, shared with the dashboard rather than
// written out here — see src/cascade.ts for why a second copy is the bug it prevents.
import { CASCADING_STATUSES_SQL } from '../cascade'
// The policy vocabulary, shared with the dashboard the same way (#173).
import { parseModerationPolicy } from '../moderation/policy'
import type { ModerationPolicy } from '../moderation/policy'

export type CommentStatus = 'pending' | 'approved' | 'spam' | 'deleted'

export interface Thread {
  id: number
  pageKey: string
  pageUrl: string | null
  title: string | null
  createdAt: number
  updatedAt: number
}

export interface StoredComment extends RenderableComment {
  threadId: number
  status: CommentStatus
  moderatedAt: number | null
}

export interface QueuedComment extends StoredComment {
  pageKey: string
  pageTitle: string | null
  /**
   * Why a spam layer held this comment, or null when none did (#70).
   *
   * On QueuedComment and not on RenderableComment, deliberately: it is triage
   * metadata for the moderator, and the page read does not select the column, so
   * no template mistake downstream can put a layer's internal reason token in
   * front of a reader.
   * Enforced by test/worker/db/spam-reason.test.ts.
   */
  spamReason: string | null
}

export interface NewComment {
  threadId: number
  parentId?: number | null
  authorName: string
  authorEmail?: string | null
  body: string
  bodyHash: string
  ipHash?: string | null
  /**
   * Set only for comments written from the moderation dashboard by the signed-in
   * owner, which are published without passing through the queue.
   *
   * There is deliberately no `status` here. A public submission handler that can
   * be handed a status is a public submission handler that can be made to
   * self-approve — so status is derived from this flag and `autoApprove` below,
   * and from nothing else.
   * Enforced by test/worker/db/comments.test.ts.
   */
  byOwner?: boolean
  /**
   * The moderation policy said to publish this one without review (#173).
   *
   * **A second boolean rather than a `status` field, and the difference is the whole
   * guard.** A status parameter would let any caller name any of the four values,
   * including `approved`, from anything they could get into the request; this is a
   * flag with one meaning, which `runSubmission` computes from two database reads and
   * assembles into the insert by hand. Nothing on the wire is spread into this object,
   * which is the guard — and src/submit/schema.ts stripping every field it does not
   * know is the second layer under it, not the first.
   *
   * **It is not `byOwner`, and must never be conflated with it.** `by_owner` is
   * rendered as a badge on the page, is what the composer's own replies set, and is
   * excluded from the trust lookup so that owner comments cannot confer standing.
   * A trusted commenter is a stranger the owner has approved before, not the owner.
   *
   * `moderated_at` stays null, which is deliberate: nobody moderated this comment.
   * That null is also what tells an auto-approved comment apart from an approved one
   * in the dashboard — approved, not by the owner, never moderated.
   * Enforced by test/worker/db/comments.test.ts and test/worker/submit/trust.test.ts.
   */
  autoApprove?: boolean
  /**
   * Why a spam layer held this comment, when one did (#70) — `runLayers` has
   * already prefixed it with the layer's name. Absent, empty or blank stores
   * null, because an empty string in this column reads as "held for a reason
   * nobody recorded" and there is no such state.
   *
   * Truncated to MAX_SPAM_REASON_LENGTH before it is bound. See that constant
   * for why a reason is untrusted input despite never coming from a commenter.
   * Enforced by test/worker/db/spam-reason.test.ts.
   */
  spamReason?: string | null
  now: number
}

interface ThreadRow {
  id: number
  page_key: string
  page_url: string | null
  title: string | null
  created_at: number
  updated_at: number
}

interface CommentRow {
  id: number
  thread_id: number
  parent_id: number | null
  depth: number
  author_name: string
  body: string
  by_owner: number
  status: string
  created_at: number
  moderated_at: number | null
}

interface QueuedCommentRow extends CommentRow {
  page_key: string
  page_title: string | null
  spam_reason: string | null
}

const RENDERABLE_COLUMNS = 'id, parent_id, depth, author_name, body, by_owner, created_at'

/**
 * The most comments one page read will ever return, and the only cap on the only
 * unauthenticated read in this project (#27).
 *
 * It is a memory bound first. `body` is `CHECK (length(body) BETWEEN 1 AND 10000)`,
 * so an uncapped page of 10,000 approved comments is a ~100 MB result set assembled
 * inside a 128 MB isolate, and the renderer then builds an HTML string from it. The
 * failure is an OOM on the read path, which takes the page down for every reader
 * rather than for the one who asked. At 500 the worst case is ~5 MB of rows and
 * roughly twice that with the rendered string — a long way inside the isolate even
 * if every body is at its own maximum.
 *
 * It is a row-read bound second: 501 rows is the most any single page load can spend
 * of the 5M rows/day the free tier allows across the whole account.
 *
 * And it is a product number third. A page carrying more than 500 approved comments
 * is past the size of essentially any blog conversation, so the cap is a safety net
 * rather than something a reader meets — which is what makes an honest notice
 * affordable where pagination would not be.
 * Enforced by test/worker/db/page-limit.test.ts.
 */
export const MAX_PAGE_COMMENTS = 500

/**
 * The page read, as a constant so that the query plan can be asserted against the
 * statement this project actually sends rather than against a copy of it in a test.
 *
 * `?2` is bound by listPageComments and by nothing else — see the note there for
 * why this cap, unlike the moderation queue's, takes nothing from its caller.
 * Enforced by test/worker/db/query-plan.test.ts and test/worker/db/page-limit.test.ts.
 */
export const PAGE_COMMENTS_SQL = `select ${RENDERABLE_COLUMNS.split(', ')
  .map((column) => `c.${column}`)
  .join(', ')}
     from comments c
     join threads t on t.id = c.thread_id
    where t.page_key = ?1
      and c.status = 'approved'
      and (
        c.parent_id is null
        or exists (select 1 from comments p where p.id = c.parent_id and p.status = 'approved')
      )
    order by c.created_at, c.id
    limit ?2`

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    pageKey: row.page_key,
    pageUrl: row.page_url,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRenderable(row: Omit<CommentRow, 'thread_id' | 'status' | 'moderated_at'>) {
  return {
    id: row.id,
    parentId: row.parent_id,
    depth: row.depth,
    authorName: row.author_name,
    body: row.body,
    byOwner: row.by_owner === 1,
    createdAt: row.created_at,
  }
}

function toStored(row: CommentRow): StoredComment {
  return {
    ...toRenderable(row),
    threadId: row.thread_id,
    status: row.status as CommentStatus,
    moderatedAt: row.moderated_at,
  }
}

/**
 * Resolves a page to its thread, creating it on first sight. One statement: the
 * upsert is what keeps two submissions arriving at once from racing into two rows.
 *
 * This writes, so it belongs to the submission path only — never to rendering.
 * See listPageComments.
 */
export async function getOrCreateThread(
  db: D1Database,
  input: { pageKey: string; pageUrl?: string | null; title?: string | null; now: number },
): Promise<Thread> {
  const row = await db
    .prepare(
      `insert into threads (page_key, page_url, title, created_at, updated_at)
       values (?1, ?2, ?3, ?4, ?4)
       on conflict (page_key) do update set
         page_url   = coalesce(excluded.page_url, threads.page_url),
         title      = coalesce(excluded.title, threads.title),
         updated_at = excluded.updated_at
       returning *`,
    )
    .bind(input.pageKey, input.pageUrl ?? null, input.title ?? null, input.now)
    .first<ThreadRow>()

  if (row === null) throw new Error(`could not open a thread for page ${input.pageKey}`)
  return toThread(row)
}

/**
 * The longest `spam_reason` this will store, matching the CHECK in
 * migrations/0002_spam_reason.sql.
 *
 * A reason looks like `turnstile: invalid-input-response`, so 200 characters is
 * far past anything a layer produces — and that generosity is exactly why the cap
 * has to exist rather than be assumed. One reason is built by joining siteverify's
 * `error-codes`, which is a JSON array in a response from outside this Worker: a
 * third party, or anything that can impersonate one, chooses its length. Card rule
 * 5 does not stop at the commenter.
 * Enforced by test/worker/db/spam-reason.test.ts.
 */
export const MAX_SPAM_REASON_LENGTH = 200

/**
 * The reason as the column will hold it: null when there is none, stripped of
 * anything that is not text, and cut to the cap.
 *
 * Truncated rather than rejected, and that direction is the design. The reason is
 * diagnostic; the comment is the reader's. Failing the insert would mean a
 * third-party response longer than expected costs a real person their comment,
 * which is a far worse outcome than a triage badge that ends mid-word.
 *
 * Three things happen before the cut, and each is about the same fact — this string
 * can come from siteverify's `error-codes`, so a third party chooses its bytes:
 *
 * - **Control characters go**, NUL first. A NUL makes SQLite's `length()` stop
 *   counting there, which is why the CHECK measures a BLOB cast; the rest of the set
 *   is what would turn a triage badge into a forged log line or a bidi override in
 *   the moderator's own UI.
 * - **A lone surrogate goes.** The cut counts UTF-16 units, so a character outside
 *   the BMP landing on the boundary would leave half of itself bound as TEXT.
 * - **Then it is cut**, to the same 200 bytes the CHECK enforces.
 * Enforced by test/worker/db/spam-reason.test.ts.
 */
// C0, DEL and C1, plus the bidi marks and embedding controls. Naming them by escape
// is the whole point of the guard, so the rule that objects to that is turned off for
// this one line rather than the pattern rewritten into something less legible.
// eslint-disable-next-line no-control-regex
const NOT_TEXT = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E]/gu

function storableSpamReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null

  const trimmed = reason.replace(NOT_TEXT, '').trim()
  if (trimmed === '') return null

  const cut = trimmed.slice(0, MAX_SPAM_REASON_LENGTH)
  // A high surrogate at the very end has lost its pair to the cut.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

/**
 * The one place a stored comment's status is decided, and the only two inputs it has.
 *
 * Written out as a function rather than inline in the bind list so that both flags are
 * visible together: the rule is that a comment is published on arrival if the owner
 * wrote it or if the moderation policy trusted its author, and is otherwise `pending`.
 * There is no third way in, and no caller-supplied status anywhere.
 * Enforced by test/worker/db/comments.test.ts.
 */
function statusFor(input: NewComment): CommentStatus {
  return input.byOwner === true || input.autoApprove === true ? 'approved' : 'pending'
}

/**
 * Stores a comment. `depth` is derived in SQL from whether there is a parent, and
 * the comments_depth_guard trigger rejects a reply to a reply — so the two-level
 * rule holds even for a caller that never checked.
 */
export async function insertComment(db: D1Database, input: NewComment): Promise<StoredComment> {
  const row = await db
    .prepare(
      `insert into comments (
         thread_id, parent_id, depth, author_name, author_email, body, body_hash,
         status, by_owner, ip_hash, spam_reason, created_at
       )
       values (?1, ?2, case when ?2 is null then 0 else 1 end, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       returning id, thread_id, parent_id, depth, author_name, body, by_owner, status,
                 created_at, moderated_at`,
    )
    .bind(
      input.threadId,
      input.parentId ?? null,
      input.authorName,
      input.authorEmail ?? null,
      input.body,
      input.bodyHash,
      statusFor(input),
      // `by_owner` follows `byOwner` alone. An auto-approved comment is a stranger's
      // comment that skipped the queue, not the owner's — badging it as the owner's
      // would be a lie on the page, and counting it in the trust lookup would let a
      // trusted commenter confer trust on the next arrival.
      input.byOwner === true ? 1 : 0,
      input.ipHash ?? null,
      storableSpamReason(input.spamReason),
      input.now,
    )
    .first<CommentRow>()

  if (row === null) throw new Error('comment was not stored')
  return toStored(row)
}

/**
 * A page's conversation, and whether it is the whole of it.
 *
 * `truncated` is part of the result rather than something the caller infers from
 * `comments.length`, because a page holding exactly MAX_PAGE_COMMENTS comments and
 * a page holding more are different pages, and only this read can tell them apart.
 * A caller left to compare lengths would put "showing the first 500" on a complete
 * conversation.
 * Enforced by test/worker/db/page-limit.test.ts.
 */
export interface PageComments {
  /** At most MAX_PAGE_COMMENTS, oldest first, roots and replies interleaved. */
  comments: RenderableComment[]
  /** True when the page has approved comments this read did not return. */
  truncated: boolean
}

/**
 * The page read: one statement, no writes, for the whole conversation — roots and
 * replies together, ordered so the caller can assemble the tree without sorting.
 *
 * It takes the page key rather than a thread id specifically so that rendering
 * never has to call getOrCreateThread, which writes. Reading a page must not cost
 * a row write: the write budget is 100k/day against 5M reads, so a write on the
 * read path means traffic exhausts the daily writes and nobody can comment for the
 * rest of the day. A page nobody has commented on has no thread row at all, and
 * reads as empty.
 *
 * **It takes no page size, and that is the contrast with listModerationQueue.**
 * That one accepts a limit and clamps it silently, because its caller is the
 * signed-in owner paginating their own queue and an error there empties the screen
 * of the one person doing the moderating. This is the public, unauthenticated read:
 * there is no legitimate caller who needs a larger page, so the safest parameter is
 * the one that does not exist. A cap that cannot be passed cannot be forgotten, and
 * it holds for the v1.1 server-rendering paths without their having to know it is
 * there.
 *
 * It asks for one row past the cap so that "exactly full" and "there is more" are
 * different answers, and returns at most the cap either way.
 * Enforced by test/worker/db/comments.test.ts and test/worker/db/page-limit.test.ts.
 */
export async function listPageComments(db: D1Database, pageKey: string): Promise<PageComments> {
  const { results } = await db
    .prepare(PAGE_COMMENTS_SQL)
    .bind(pageKey, MAX_PAGE_COMMENTS + 1)
    .all<Omit<CommentRow, 'thread_id' | 'status' | 'moderated_at'>>()

  return {
    comments: results.slice(0, MAX_PAGE_COMMENTS).map(toRenderable),
    truncated: results.length > MAX_PAGE_COMMENTS,
  }
}

/**
 * The parent-eligibility read, as a constant so the query plan can be asserted
 * against the statement this project actually sends rather than a copy of it in a
 * test.
 *
 * `id = ?1` is the INTEGER PRIMARY KEY, so this is one row seek however large the
 * table is. The remaining predicates are all on that row.
 * Enforced by test/worker/db/query-plan.test.ts and test/worker/db/reply-target.test.ts.
 */
export const REPLY_TARGET_SQL = `select 1 as eligible
     from comments
    where id = ?1
      and thread_id = ?2
      and status = 'approved'
      and depth = 0`

/**
 * Whether `parentId` names a comment this thread may be replied to (#48).
 *
 * The triggers `comments_depth_guard` and `comments_parent_thread_guard` already
 * refuse an ineligible parent, correctly — but they `RAISE(ABORT)`, so insertComment
 * throws and the submission path returns 500 for what is the reader's mistake. This
 * read exists to make that a 400. It does not replace the triggers: they stay as the
 * backstop that holds for a caller who never checked, including the importer.
 *
 * Four conditions, one row: the comment exists, it is on this thread, it is
 * `approved`, and it is at depth 0. `approved` is part of eligibility rather than
 * merely a nicety — a reader cannot see a pending or spam comment, so cannot have
 * clicked reply on one, and an id that names one was guessed. The caller must give
 * every failure the same answer, or this becomes an oracle over the moderation
 * queue.
 *
 * The id is checked before the database is asked, because a public endpoint should
 * not spend a query proving that `-1` is not a comment.
 * Enforced by test/worker/db/reply-target.test.ts.
 */
export async function isReplyTarget(
  db: D1Database,
  threadId: number,
  parentId: number,
): Promise<boolean> {
  if (!Number.isInteger(parentId) || parentId < 1) return false

  const row = await db.prepare(REPLY_TARGET_SQL).bind(parentId, threadId).first<{
    eligible: number
  }>()
  return row !== null
}

/**
 * There is no comment with that id to moderate.
 *
 * A named class rather than a bare Error, because the HTTP boundary has to turn
 * exactly this into a 404 and everything else into a 500. A handler that decided by
 * catching whatever setCommentStatus threw would report a D1 outage as "no such
 * comment", which is the report that stops anyone investigating.
 * Enforced by test/worker/admin/queue.test.ts.
 */
export class NoSuchCommentError extends Error {
  constructor(readonly commentId: number) {
    super(`no comment ${commentId} to moderate`)
    this.name = 'NoSuchCommentError'
  }
}

/** What a moderation decision returns: the outcome, and nothing it did not need. */
export interface ModerationDecision {
  id: number
  threadId: number
  parentId: number | null
  status: CommentStatus
  moderatedAt: number | null
  /**
   * How many replies the decision took down with it. Zero for an approval.
   *
   * Rows that *moved*, not rows the statement matched: a reply already in the target
   * status is excluded by MODERATE_SQL, so this is a number the recomputed tab counts
   * agree with. It is shown to the moderator (#133), and a count that disagreed with
   * the badges beside it would be the same self-contradiction that issue is about.
   * Enforced by test/worker/db/comments.test.ts.
   */
  cascaded: number
}

interface ModerationDecisionRow {
  id: number
  thread_id: number
  parent_id: number | null
  status: string
  moderated_at: number | null
}

/**
 * The moderation write, as a constant so the query plan can be asserted against the
 * statement this project actually sends rather than a copy of it in a test.
 *
 * **It deliberately does not `returning` the body or the author name.** The
 * `or (parent_id = ?1 ...)` clause makes this statement's result set as large as the
 * number of replies under the comment, and nothing caps replies per parent — the
 * depth guard caps nesting, not fan-out. Selecting `body` would pull up to 10,000
 * characters per reply into a 128 MB isolate on the way to discarding all but one
 * row, so hiding one popular comment would be an unbounded read on a path a spammer
 * can inflate by replying to their own comment. What comes back is the decision: the
 * ids, the status, and the count. Bounding the *write* is #122.
 *
 * **The statuses it cascades on come from src/cascade.ts, not from a list written out
 * here.** The dashboard takes the same replies off the screen the moment a decision
 * starts (#133), and a second copy of the set in a different TypeScript project is a
 * copy nothing can check: a third cascading status would leave the queue showing rows
 * the server had already hidden, with every test in both projects still green.
 *
 * **`status <> ?2` on the cascade branch, and it is on the branch rather than on the
 * whole statement.** A reply already in the target status is not moved by this
 * decision, so writing it would spend a row write to change nothing, overwrite the
 * `moderated_at` of the decision that really did move it, and — since #133 puts the
 * cascade count in front of the moderator — inflate a number the recomputed tab
 * counts then contradict. The root is deliberately *not* filtered the same way: it
 * must come back whatever its own status, or setting a comment to the status it is
 * already in would raise NoSuchCommentError and the endpoint would answer 404 for a
 * comment that plainly exists.
 * Enforced by test/worker/db/query-plan.test.ts and test/worker/db/comments.test.ts.
 */
export const MODERATE_SQL = `update comments set status = ?2, moderated_at = ?3
        where id = ?1
           or (parent_id = ?1 and ?2 in (${CASCADING_STATUSES_SQL}) and status <> ?2)
       returning id, thread_id, parent_id, status, moderated_at`

/**
 * Records a moderation decision, and refuses to pretend it moderated nothing.
 *
 * Hiding a comment hides the replies underneath it. Otherwise removing a spam
 * comment leaves the replies to it on the page, answering something no reader can
 * see — the moderator believes they took down a conversation and took down half of
 * it. Approving does *not* cascade: each reply is still judged on its own.
 * Enforced by test/worker/db/comments.test.ts.
 */
export async function setCommentStatus(
  db: D1Database,
  commentId: number,
  status: CommentStatus,
  now: number,
): Promise<ModerationDecision> {
  const { results } = await db
    .prepare(MODERATE_SQL)
    .bind(commentId, status, now)
    .all<ModerationDecisionRow>()

  const row = results.find((candidate) => candidate.id === commentId)
  if (row === undefined) throw new NoSuchCommentError(commentId)
  return {
    id: row.id,
    threadId: row.thread_id,
    parentId: row.parent_id,
    status: row.status as CommentStatus,
    moderatedAt: row.moderated_at,
    cascaded: results.length - 1,
  }
}

/**
 * The queue page size when the caller does not choose one — a screenful of triage,
 * not an inbox.
 */
export const DEFAULT_QUEUE_LIMIT = 50

/**
 * The largest page the queue will ever return, whatever it is asked for.
 *
 * Rows read are the free tier's budget: 5M/day across the whole account. A page of
 * 200 costs at most 200 of them, so it takes 25,000 page loads to matter — where an
 * unclamped `limit` of 100,000 spends 2% of the day in one click. It is a memory
 * bound as much as a billing one: a row here carries a body of up to 10,000
 * characters and a Worker isolate has 128 MB.
 * Enforced by test/worker/db/queue-limit.test.ts.
 */
export const MAX_QUEUE_LIMIT = 200

/**
 * Turns whatever the caller had into a page size that is safe to send to D1.
 *
 * Silent, not loud. This value reaches the data layer from the dashboard's own
 * query string, so the caller is the site owner rather than an attacker, and a
 * paginating UI that asks one row past the cap should get a full page rather than
 * an error where its queue used to be. Rejecting is the right answer on a public
 * endpoint, where an out-of-range value is evidence of probing and there is nobody
 * to inconvenience; it is the wrong answer here, where failing loudly empties the
 * screen of the one person doing the moderating. Either way the read is bounded,
 * which is the property that costs money — so the clamp is the guard and an error
 * would only be noise.
 *
 * `unknown`, because the value arrives from a query string where nothing TypeScript
 * believes survives: strings, `undefined`, `NaN` and `Infinity` all reach here in
 * practice. A page size that is not a finite whole number of at least one is not a
 * page size, and becomes the default.
 * Enforced by test/worker/db/queue-limit.test.ts.
 */
function clampQueueLimit(limit: unknown): number {
  const parsed = typeof limit === 'string' ? Number(limit) : limit
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return DEFAULT_QUEUE_LIMIT

  // Truncates rather than rounds, so no fractional value can widen the read.
  const whole = Math.floor(parsed)
  if (whole < 1) return DEFAULT_QUEUE_LIMIT
  return Math.min(whole, MAX_QUEUE_LIMIT)
}

/** A position in one status's ordering: the row the next page starts after. */
export interface QueueCursor {
  createdAt: number
  id: number
}

/**
 * The largest `created_at` a cursor may name, and the largest `id`.
 *
 * Ten digits of unix seconds runs to the year 2286, and fifteen digits of id is
 * past anything D1 will hold — so both bounds are generous. They exist because
 * the alternative to a bound is `Number()` on a caller-supplied string, and
 * `Number('1e400')` is `Infinity`, which binds as a value SQLite compares in ways
 * nobody reasoned about. A cursor arrives on a query string like any other
 * parameter (card rule 5).
 * Enforced by test/worker/db/queue-cursor.test.ts.
 */
const CURSOR_PATTERN = /^\d{1,10}\.\d{1,15}$/

/**
 * The wire form of a cursor: `<created_at>.<id>`.
 *
 * Not base64 and not signed, because it is not a capability and encoding it as
 * one would say otherwise. It names a position in an ordering the caller is
 * already authorised to read — `status` is a separate argument, so a cursor
 * copied from one queue reads nothing extra in another.
 * Enforced by test/worker/db/queue-cursor.test.ts.
 */
export function encodeQueueCursor(cursor: QueueCursor): string {
  return `${cursor.createdAt}.${cursor.id}`
}

/**
 * A cursor, or null when the value is not one.
 *
 * **Null must not be treated as "no cursor" by a caller who was given a value.**
 * This is the one place the queue's read parameters reject rather than clamp, and
 * that asymmetry with clampQueueLimit is deliberate: a page size out of range has
 * a safe nearest value, and a cursor does not. Silently dropping one makes every
 * "next page" request return page one, so a paging UI loops over the first page
 * forever while the oldest comments — the ones this exists to reach — stay
 * unreachable, with nothing anywhere reporting a fault. The HTTP boundary turns
 * this null into a 400.
 * Enforced by test/worker/db/queue-cursor.test.ts and test/worker/admin/queue.test.ts.
 */
export function parseQueueCursor(value: unknown): QueueCursor | null {
  if (typeof value !== 'string' || !CURSOR_PATTERN.test(value)) return null

  const [createdAt, id] = value.split('.').map(Number) as [number, number]
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(id)) return null
  if (id < 1) return null
  return { createdAt, id }
}

const QUEUE_COLUMNS = `c.id, c.thread_id, c.parent_id, c.depth, c.author_name, c.body, c.by_owner,
              c.status, c.created_at, c.moderated_at, c.spam_reason,
              t.page_key, t.title as page_title
         from comments c
         join threads t on t.id = c.thread_id`

const QUEUE_ORDER = `order by c.created_at desc, c.id desc
        limit ?2`

/**
 * The first page of the triage queue, as a constant so that the query plan can be
 * asserted against the statement this project actually sends rather than against
 * a copy of it in a test.
 * Enforced by test/worker/db/query-plan.test.ts.
 */
export const MODERATION_QUEUE_SQL = `select ${QUEUE_COLUMNS}
        where c.status = ?1
        ${QUEUE_ORDER}`

/**
 * Every page after the first (#33).
 *
 * **A second constant rather than one statement with an `and (?3 is null or …)`
 * disjunct, and that is the point of writing it twice.** A null-guarded predicate
 * is opaque to the planner: it cannot know at prepare time whether the range
 * applies, so it plans for the general case and `comments_by_status` stops being
 * seeked — the whole status is read and the cursor becomes a filter rather than a
 * seek, which is the cost keyset paging exists to avoid. Two statements also mean
 * two plans, and test/worker/db/query-plan.test.ts asserts both; one statement
 * would leave the paging plan — the one a long queue actually spends its rows on
 * — untested whichever way the binding went.
 *
 * The comparison is a row value, `(created_at, id) < (?3, ?4)`, not
 * `created_at < ?3`: unix seconds collide, and a bulk import (#15) lands hundreds
 * of comments on one of them. A cursor on the timestamp alone would skip every
 * row sharing the boundary second or repeat them forever.
 * Enforced by test/worker/db/query-plan.test.ts and test/worker/db/queue-cursor.test.ts.
 */
export const MODERATION_QUEUE_PAGE_SQL = `select ${QUEUE_COLUMNS}
        where c.status = ?1
          and (c.created_at, c.id) < (?3, ?4)
        ${QUEUE_ORDER}`

/** One bounded page of the triage queue, and where the next one starts. */
export interface QueuePage {
  comments: QueuedComment[]
  /**
   * The cursor to pass back for the next page, or null when this is the last.
   *
   * Part of the result rather than something the caller derives from the last
   * row, for the same reason PageComments carries `truncated`: only this read can
   * tell a page that is exactly full from a page with more behind it, and a
   * caller left to guess puts a dead "next" button on the end of the queue.
   * Enforced by test/worker/db/queue-cursor.test.ts.
   */
  nextCursor: string | null
}

export interface QueueOptions {
  /** Clamped, never rejected — see clampQueueLimit. */
  limit?: unknown
  /** Rejected, never clamped — see parseQueueCursor. */
  cursor?: QueueCursor | null
}

/**
 * The triage queue: one status across every thread, newest first, one bounded page.
 *
 * The page size is clamped here rather than in the handler that happens to be in
 * front of it, so the bound holds for every caller — the dashboard, the importer,
 * and whatever calls this next — instead of for whichever one remembered. It is
 * one statement whether or not there is a cursor, so the queue costs the same
 * against the 50-query invocation budget on page one and on page forty.
 *
 * It asks for one row past the page so that "exactly full" and "there is more"
 * are different answers, and returns at most the page either way — the same shape
 * listPageComments uses for `truncated`.
 * Enforced by test/worker/db/queue-limit.test.ts and test/worker/db/queue-cursor.test.ts.
 */
export async function listModerationQueue(
  db: D1Database,
  status: CommentStatus,
  options: QueueOptions = {},
): Promise<QueuePage> {
  const limit = clampQueueLimit(options.limit)
  const cursor = options.cursor ?? null

  const statement =
    cursor === null
      ? db.prepare(MODERATION_QUEUE_SQL).bind(status, limit + 1)
      : db.prepare(MODERATION_QUEUE_PAGE_SQL).bind(status, limit + 1, cursor.createdAt, cursor.id)

  const { results } = await statement.all<QueuedCommentRow>()
  const page = results.slice(0, limit)
  const last = page.at(-1)

  return {
    comments: page.map((row) => ({
      ...toStored(row),
      pageKey: row.page_key,
      pageTitle: row.page_title,
      spamReason: row.spam_reason,
    })),
    nextCursor:
      results.length > limit && last !== undefined
        ? encodeQueueCursor({ createdAt: last.created_at, id: last.id })
        : null,
  }
}

/** How many comments sit in each status. Every status is present, zero included. */
export type StatusCounts = Record<CommentStatus, number>

/**
 * The per-status counts, as one grouped statement (#135).
 *
 * **One statement for every status rather than one per status, and that is the whole
 * design of it.** The dashboard's tab strip needs three numbers and the query count has
 * to stay independent of how many it needs — CLAUDE.md's rule is a constant query
 * count, not a low one, because the 50-query invocation budget is a ceiling that throws
 * rather than a slope that slows down.
 *
 * A constant so the plan can be asserted against the statement this project actually
 * sends rather than a copy of it in a test. The plan it is allowed to have is narrower
 * than "does not scan": an exact count of a status cannot seek, because every row of
 * that status is part of the answer. What `comments_by_status` buys is that the scan
 * reads *index entries and never the table*, which is what keeps a count off the rows
 * carrying up to 10,000 characters of body each.
 * Enforced by test/worker/db/query-plan.test.ts and test/worker/db/status-counts.test.ts.
 */
export const STATUS_COUNTS_SQL = `select status, count(*) as n
       from comments
      group by status`

/**
 * How many comments are in each status, right now.
 *
 * Zero-filled for all four, because `group by` returns no row for a status nothing is
 * in — and a caller handed an object missing a key renders `undefined` where it meant
 * to render a number. An empty queue is a state worth showing, so it needs a value.
 *
 * It is a read of the whole table, and that is inherent rather than an oversight: an
 * exact count has to visit every row of the status it counts. The bound is that it
 * visits index entries rather than rows — see STATUS_COUNTS_SQL. #136 records the size
 * at which even that stops being affordable, and what would replace it.
 * Enforced by test/worker/db/status-counts.test.ts.
 */
export async function countCommentsByStatus(db: D1Database): Promise<StatusCounts> {
  const { results } = await db.prepare(STATUS_COUNTS_SQL).all<{ status: string; n: number }>()

  // **Read out by literal key rather than assigned in by the row's own.** The four keys
  // are then the only keys this can produce, whatever came back — where a loop writing
  // `counts[row.status]` would take its key from the database and needs a membership
  // test to be safe, and the obvious `row.status in counts` is not one: `in` walks the
  // prototype chain, so a row whose status were `constructor` or `toString` would pass
  // it. The column's CHECK constraint (migrations/0001_initial.sql) means neither can
  // occur — this is card rule 5's habit rather than a live hole — but the shape that
  // cannot go wrong costs nothing over the shape that merely does not.
  const byStatus = new Map(results.map((row) => [row.status, row.n]))
  return {
    pending: byStatus.get('pending') ?? 0,
    approved: byStatus.get('approved') ?? 0,
    spam: byStatus.get('spam') ?? 0,
    deleted: byStatus.get('deleted') ?? 0,
  }
}

/**
 * One `settings` row's value, or null when the owner has set none.
 *
 * A primary-key lookup, so it is one row seek whatever else is in the table. It exists
 * as a function rather than as three copies of the same `select` because the statement
 * was written out three times — here, in `getIpHashRetentionDays`, and in src/cors.ts —
 * and the third one was added by someone who did not know about the first two.
 *
 * It returns the raw string and validates nothing: every setting has its own idea of
 * what a usable value is, and the callers above disagree about what to do with an
 * unusable one. Both treat it as untrusted input regardless of who wrote it.
 */
export async function readSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('select value from settings where key = ?1')
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? null
}

/**
 * Sets one `settings` row, creating it on first write.
 *
 * One statement, so two dashboard tabs saving at once cannot interleave into a row
 * that is neither of their values. `updated_at` is passed in like every other clock in
 * this file.
 *
 * **Nothing on a public path may reach this.** The only caller is the authenticated
 * dashboard (src/admin/settings.ts): the write budget is 100k rows/day against 5M
 * reads, so a settings write reachable from the read or submit path would let traffic
 * spend the day's comments — which is the trade #20 fixed and the reason #57's
 * same-origin default is derived per request rather than seeded into this table.
 * Enforced by test/worker/admin/settings.test.ts and test/worker/first-deploy.test.ts.
 */
export async function writeSetting(
  db: D1Database,
  key: string,
  value: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `insert into settings (key, value, updated_at)
       values (?1, ?2, ?3)
       on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now)
    .run()
}

/** The `settings` key holding the moderation policy (#173). */
export const MODERATION_POLICY_SETTING = 'moderation_policy'

/**
 * The moderation policy the owner configured, or `hold-all` when they have not.
 *
 * The same shape as `getIpHashRetentionDays` above, and for the same reason: the value
 * arrives from a free-text `settings` row, so it is validated like a query string rather
 * than trusted because the dashboard wrote it. `parseModerationPolicy` has exactly one
 * failure answer and it is the default — see src/moderation/policy.ts for why a null
 * this caller had to interpret would be the worse contract.
 *
 * **This is a read on the public submission path, so where it is called from matters as
 * much as what it returns.** It is one primary-key seek, and `runSubmission` reaches it
 * only for a comment no layer objected to whose commenter is identifiable at all — so a
 * held comment, a rejected one, and a comment with no email each cost nothing here.
 * Enforced by test/worker/moderation/policy.test.ts and test/worker/submit/trust.test.ts.
 */
export async function getModerationPolicy(db: D1Database): Promise<ModerationPolicy> {
  return parseModerationPolicy(await readSetting(db, MODERATION_POLICY_SETTING))
}

/**
 * The retention window for `ip_hash`, in days, when the owner has set none.
 *
 * `ip_hash` is an HMAC of the commenter's IP kept only for rate limiting (#8
 * layer 4) and short-term abuse detection; neither needs it beyond a short window,
 * and keeping it forever makes a per-deployment secret the only thing between the
 * table and a map of who commented from where. 30 days preserves that utility
 * while bounding the retention — but it is a privacy policy, not a constant, so it
 * is overridable via the `ip_hash_retention_days` setting without a redeploy.
 * The #17 disclosure text and this value have to agree.
 */
export const DEFAULT_IP_HASH_RETENTION_DAYS = 30

/** The `settings` key that overrides DEFAULT_IP_HASH_RETENTION_DAYS. */
export const IP_HASH_RETENTION_SETTING = 'ip_hash_retention_days'

const SECONDS_PER_DAY = 86_400

/**
 * The retention window the owner configured, or the default when unset or invalid.
 *
 * The value arrives from a free-text `settings` row, so it is validated the way a
 * query string is: a window that is not a positive whole number of days is not a
 * window, and becomes the default rather than a silent zero that would purge every
 * ip_hash on the next run. Falling back is the fail-closed choice here — the guard
 * is "PII does not live forever", and the default still enforces it.
 * Enforced by test/worker/db/ip-hash-purge.test.ts.
 */
export async function getIpHashRetentionDays(db: D1Database): Promise<number> {
  const value = await readSetting(db, IP_HASH_RETENTION_SETTING)
  if (value === null) return DEFAULT_IP_HASH_RETENTION_DAYS

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_IP_HASH_RETENTION_DAYS
  return parsed
}

/**
 * The retention sweep, as a constant so the query plan can be asserted against the
 * statement this project actually sends rather than a copy of it in a test.
 *
 * It nulls only `ip_hash`, only on rows past the cutoff, and only where one is still
 * set — the `ip_hash is not null` predicate matches the partial index
 * `comments_by_ip`, so the sweep seeks that index and never re-reads a row it has
 * already purged. That is what keeps the cost bounded by the retention window rather
 * than by the whole table.
 * Enforced by test/worker/db/query-plan.test.ts and test/worker/db/ip-hash-purge.test.ts.
 */
export const PURGE_IP_HASH_SQL = `update comments
     set ip_hash = null
   where ip_hash is not null
     and created_at < ?1`

export interface IpHashPurgeResult {
  purged: number
  cutoff: number
  retentionDays: number
}

/**
 * Nulls `ip_hash` on comments older than `retentionDays`, so the IP-derived
 * identifier does not live in the database past its rate-limiting usefulness (#19).
 *
 * `now` is passed in, never read from the clock here, so the window boundary is the
 * caller's to own and a test's to pin. Returns the number of rows purged so the
 * scheduled caller can log evidence it ran — a purge that silently no-ops leaves
 * PII in the table invisibly, which is the failure mode this whole feature exists
 * to prevent.
 * Enforced by test/worker/db/ip-hash-purge.test.ts.
 */
export async function purgeExpiredIpHashes(
  db: D1Database,
  now: number,
  retentionDays: number,
): Promise<IpHashPurgeResult> {
  const cutoff = now - retentionDays * SECONDS_PER_DAY
  const { meta } = await db.prepare(PURGE_IP_HASH_SQL).bind(cutoff).run()
  return { purged: meta.changes, cutoff, retentionDays }
}

/** What a health check can find, as three distinguishable answers rather than two. */
export type DatabaseStatus = 'ready' | 'unmigrated' | 'unreachable'

/**
 * Whether this deployment's D1 binding points at a database with Charcha's schema in
 * it, as one statement (#140).
 *
 * **`GET /health` calls it, and it is intended to stay the only caller.** It was written
 * for the status readout on `/`, #145 removed that readout — a public, unauthenticated
 * address must not tell a stranger that a deployment is half-broken — and #141 then gave
 * it to `/health`, which was answering `ok` on precisely the database this function
 * exists to distinguish.
 *
 * `/health` is public and unauthenticated too, so that was a decision rather than a
 * consequence of reusing the helper, and it was taken on #141: the argument for making
 * it and the shape of the response it produces are written out at the route in
 * src/index.ts, which is where a reader weighing a second caller should start. Nothing
 * here licenses one, and no test enforces the count — this paragraph is intent.
 *
 * **It asks `sqlite_master` for a table rather than running `select 1`, and that is
 * the whole point of it.** `select 1` proves the binding resolves and nothing else: a
 * Worker published against the database Cloudflare created and never migrated answers
 * it perfectly, and then fails on the first real query. That is not a hypothetical —
 * the deploy button creates the database and leaves migrating it to the repository's
 * own `deploy` script, and `wrangler d1 migrations apply` exits non-zero with no
 * useful output when its token lacks D1 (workers-sdk#5077). "Migrated" and "reachable"
 * are therefore different questions, and a check that could only answer the second
 * would report a green light on the exact failure it exists to catch.
 *
 * `comments` is the table it looks for because it is the one this project cannot
 * function without and the one migration 0001 creates. The query reads a row of
 * SQLite's own schema table and no application data at all — which bounds what a
 * caller can leak to the reading of one word, and leaves the decision about whether
 * even that word is public to whoever calls it.
 * Enforced by test/worker/db/database-status.test.ts.
 */
export const DATABASE_STATUS_SQL = `select 1 as present
     from sqlite_master
    where type = 'table'
      and name = 'comments'`

export async function databaseStatus(db: D1Database): Promise<DatabaseStatus> {
  try {
    const row = await db.prepare(DATABASE_STATUS_SQL).first<{ present: number }>()
    return row === null ? 'unmigrated' : 'ready'
  } catch (error) {
    // Logged rather than swallowed: the caller turns this into one word on a page, and
    // the reason D1 refused is the part only the owner's log can carry.
    console.error('database status: D1 query failed', error)
    return 'unreachable'
  }
}

/**
 * The three reads the spam layers make (#8). They are here rather than in
 * src/spam/ for the reason the file header gives: every query lives in one place,
 * so the 50-per-invocation budget is countable without reading the whole Worker.
 *
 * All three are counts or an existence check, and none of them scans a table:
 * the submission path issues the same three statements on a page with three
 * comments and on a page with three thousand.
 *
 * The row-read cost is bounded the same way, and by the rate-limit window rather
 * than by the page: all three constrain every one of their predicates on an
 * index. `RECENT_ON_PAGE_SQL` did not until #69 added `comments_by_thread_time
 * (thread_id, created_at)` — having no `status` predicate, it could not reach the
 * `created_at` column of `comments_by_thread (thread_id, status, created_at,
 * id)`, and filtered one index entry per comment on the page instead. That cost
 * was paid on every submission, including the ones about to be rejected.
 * Enforced by test/worker/spam/query-plan.test.ts, which asserts the constrained
 * columns of each plan rather than only the absence of the word SCAN.
 */

/**
 * Matches `comments_by_ip`, which is `(ip_hash, created_at) WHERE ip_hash IS NOT
 * NULL` — so a row whose hash #19's sweep already nulled is not in the index and
 * costs nothing to skip. That is also why an expired hash cannot rate-limit
 * anybody: it is gone, by design.
 */
export const RECENT_BY_IP_SQL = `select count(*) as n
     from comments
    where ip_hash = ?1
      and created_at >= ?2`

export async function countRecentCommentsByIpHash(
  db: D1Database,
  ipHash: string,
  since: number,
): Promise<number> {
  const row = await db.prepare(RECENT_BY_IP_SQL).bind(ipHash, since).first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Takes the page key rather than a thread id, because the submission path runs
 * the spam layers *before* getOrCreateThread — resolving the thread first would
 * let a rejected spammer spend a row write. A page with no thread row counts zero.
 */
export const RECENT_ON_PAGE_SQL = `select count(*) as n
     from comments c
     join threads t on t.id = c.thread_id
    where t.page_key = ?1
      and c.created_at >= ?2`

export async function countRecentCommentsOnPage(
  db: D1Database,
  pageKey: string,
  since: number,
): Promise<number> {
  const row = await db.prepare(RECENT_ON_PAGE_SQL).bind(pageKey, since).first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Where this exact body has already been posted since `since` — on this page, and on
 * how many others (#184).
 *
 * Two facts and not one, because layer 5 answers them differently: a second copy on
 * the page the reader is looking at adds nothing to that page and is refused, while a
 * copy on *other* pages is the blast pattern and is judged on how many pages it
 * reached. See src/spam/content.ts.
 */
export interface BodyDuplicates {
  /** The body is already on this page inside the window. */
  samePage: boolean
  /** How many *other* pages carry it inside the window. Never counts this one. */
  otherPages: number
}

/**
 * Every page carrying this body inside the window, reduced to two numbers (#184).
 *
 * **One statement for both questions, and one row out however many copies exist.** The
 * page-scoped version this replaces could not see the archetypal spam shape at all —
 * one payload fired at fifty URLs was fifty first-time comments — because
 * `comments_by_body` led with `thread_id` and a prefix of that answers nothing when the
 * thread is unknown. `comments_by_body_hash` is (body_hash, created_at, thread_id), so
 * this is one seek constrained on the hash *and* the window, covering, and it costs the
 * same on a deployment with one comment as on one with a million.
 * Enforced by test/worker/spam/query-plan.test.ts.
 *
 * **What it reads grows with the copies of one body inside one window, and that is
 * self-limiting rather than merely small.** Layer 5 holds the second page's copy and
 * refuses the third, so a body cannot reach a third stored copy inside the window to be
 * counted. The `threads` seek is a rowid lookup per copy found, which on the ordinary
 * submission — no copies — happens zero times.
 *
 * **`count(distinct)` over page keys and not over rows.** The question the thresholds
 * ask is how many *pages* the text reached; counting rows would let two copies on one
 * other page read as a two-page blast.
 *
 * Status is deliberately not filtered — a body already marked spam is the one most
 * worth refusing a second time. `since` is what keeps that from becoming a permanent,
 * invisible ban on a piece of text: see DUPLICATE_WINDOW_SECONDS.
 */
export const DUPLICATE_BODY_SQL = `select
        max(case when t.page_key =  ?1 then 1 else 0 end) as same_page,
        count(distinct case when t.page_key <> ?1 then t.page_key end) as other_pages
     from comments c
     join threads t on t.id = c.thread_id
    where c.body_hash = ?2
      and c.created_at >= ?3`

export async function readBodyDuplicates(
  db: D1Database,
  pageKey: string,
  bodyHash: string,
  since: number,
): Promise<BodyDuplicates> {
  const row = await db
    .prepare(DUPLICATE_BODY_SQL)
    .bind(pageKey, bodyHash, since)
    .first<{ same_page: number | null; other_pages: number | null }>()
  // `max()` over no rows is null, not 0 — a body nobody has posted anywhere.
  return { samePage: row?.same_page === 1, otherPages: row?.other_pages ?? 0 }
}

/**
 * What the owner's past *spam* decisions say about the address a comment arrived from
 * (#184). The mirror of `CommenterTrust` above, and deliberately a different shape.
 *
 * Two booleans, because the two are judged differently: `seen` is the loose match and
 * earns a review, `sameCommenter` is #173's strict identity and earns a refusal. A
 * lookup returning only the loose answer would make the strict tier a second query.
 */
export interface SpamHistory {
  /** Some comment the owner marked spam came from this address. */
  seen: boolean
  /** One of them also carried this email address — #173's identity, both halves. */
  sameCommenter: boolean
}

/**
 * The repeat-offender lookup, as a constant so the query plan can be asserted against
 * the statement this project actually sends rather than a copy of it in a test.
 *
 * **One row out, whatever the address's history**, the same shape and for the same
 * reason as COMMENTER_TRUST_SQL: this runs on the public write endpoint, so an
 * attacker must not be able to inflate the read by commenting. The aggregate is over
 * `comments_by_spam_origin` entries — (ip_hash, author_email) partial on
 * `status = 'spam'` — so no comment row is touched and the entries walked are only the
 * ones the owner explicitly condemned from this one address.
 *
 * **`max(...)` over no rows is null, and that is the third answer.** Null means this
 * address has never been marked spam at all; 0 means it has, but not under this email;
 * 1 means both halves match. Three states out of one aggregate is what keeps the two
 * tiers to a single statement.
 *
 * **`by_owner = 0` and the partial index's predicate are the same three terms**, so the
 * seek stays covering. The owner cannot mark their own comment spam from the dashboard,
 * but a row that could never match should not cost an index entry either.
 * Enforced by test/worker/spam/query-plan.test.ts and test/worker/db/spam-history.test.ts.
 */
export const SPAM_HISTORY_SQL = `select
        max(case when author_email = ?2 then 1 else 0 end) as same_email
     from comments
    where ip_hash = ?1
      and by_owner = 0
      and status = 'spam'`

/**
 * Whether the owner has already marked something spam from this address, and whether
 * the comment they marked was from this same commenter.
 *
 * **The loose half is `ip_hash` alone, and that is the deliberate difference from
 * `readCommenterTrust`.** #173 requires both halves of the identity because being wrong
 * there *publishes* a stranger's comment. Here being wrong holds one for review, which
 * is what `hold-all` — the default on every deployment — does to every comment anyway.
 * That asymmetry is what buys the looser match, and it is the whole of what buys it:
 * the price is that an address behind a NAT, or one an ISP has since reassigned, holds
 * innocent strangers who inherited a spammer's address. They are held, never refused,
 * and #19's retention sweep nulls `ip_hash` on a window, so the effect expires by
 * itself rather than needing anyone to notice it.
 *
 * **The strict half is exactly #173's identity — this email *and* this address on the
 * same judged row — and only it earns a refusal.** Forging it needs the victim's email
 * address and the network they commented from, which is the property migration 0004
 * exists for; inheriting it by accident means two people behind one NAT who also type
 * the same email address.
 *
 * `authorEmail` may be null, and then `author_email = ?2` is null for every row and the
 * strict tier can never fire — a comment with no email cannot be more than an address.
 * Enforced by test/worker/db/spam-history.test.ts.
 */
export async function readSpamHistory(
  db: D1Database,
  ipHash: string,
  authorEmail: string | null,
): Promise<SpamHistory> {
  const row = await db
    .prepare(SPAM_HISTORY_SQL)
    .bind(ipHash, authorEmail)
    .first<{ same_email: number | null }>()
  const sameEmail = row?.same_email ?? null
  return { seen: sameEmail !== null, sameCommenter: sameEmail === 1 }
}

/**
 * What the owner's own past decisions say about a commenter (#173).
 *
 * Two booleans and not one, because they are different facts and the caller combines
 * them: `approved` is the standing, `spammed` is the revocation, and a lookup returning
 * only "trusted" would leave the second one somewhere else to be forgotten.
 */
export interface CommenterTrust {
  /** The owner has approved a comment from this identity. */
  approved: boolean
  /** The owner has marked a comment from this identity as spam. */
  spammed: boolean
}

/**
 * The trust lookup, as a constant so the query plan can be asserted against the
 * statement this project actually sends rather than a copy of it in a test.
 *
 * **One row out, whatever the commenter's history.** Two aggregates over the index
 * entries rather than a list of their comments: a regular with four hundred approved
 * comments has to cost the same as one with a single comment, because this runs on the
 * public write endpoint and the alternative is a read an attacker can inflate by
 * commenting.
 *
 * **`by_owner = 0`.** Owner-written comments are `approved` the moment they are stored
 * and never pass a moderation decision, so counting them would let the dashboard's own
 * replies confer trust on whoever next arrives with that email and that address. It is
 * also the partial index's predicate, so the term is what keeps the seek covering.
 *
 * **`status in ('approved', 'spam')` and not four statuses.** `pending` says the owner
 * has not decided; `deleted` says they took a comment down without calling it spam,
 * which is a different judgement and not one this should replay in either direction.
 * The two named here are the only two that are the owner *judging the commenter*.
 * Enforced by test/worker/db/query-plan.test.ts and test/worker/db/commenter-trust.test.ts.
 */
export const COMMENTER_TRUST_SQL = `select
        max(case when status = 'approved' then 1 else 0 end) as approved,
        max(case when status = 'spam'     then 1 else 0 end) as spammed
     from comments
    where author_email = ?1
      and ip_hash = ?2
      and by_owner = 0
      and status in ('approved', 'spam')`

/**
 * Whether the owner has already judged this commenter, and which way.
 *
 * **The identity is `author_email` *and* `ip_hash`, matched against the same comment,
 * and both halves are the design (#173).** `author_email` is optional and unverified —
 * anyone can type an address they do not control — so on its own it would let an
 * attacker who knows one approved commenter's address inherit their standing forever.
 * `ip_hash` is an HMAC of the address under a per-deployment secret, shared by everyone
 * behind a NAT and purged on the #19 retention window, so on its own it would hand a
 * regular's standing to every other customer of their ISP. Requiring both, on one row,
 * means forging trust needs the victim's email address *and* the network they commented
 * from at the time they were approved. Neither alone buys anything.
 *
 * **Compared exactly, never folded or trimmed.** A commenter who capitalises their
 * address differently this time is not recognised and their comment is held — which is
 * what would have happened anyway, and is the direction of error this whole feature is
 * allowed to make. Loosening the comparison would widen who can claim an address for no
 * security gain, since the attacker types whatever spelling matches.
 *
 * **Trust decays, and that is a feature.** #19's sweep nulls `ip_hash` past the
 * retention window, taking the row out of `comments_by_commenter` with it. So an
 * approval older than the window stops conferring anything, and a deployment that has
 * never set `IP_HASH_SECRET` stores no hash at all and therefore trusts nobody. Both are
 * the fail-closed direction: an identity the deployment can no longer recognise must not
 * be inheritable by whoever holds that address now.
 * Enforced by test/worker/db/commenter-trust.test.ts.
 */
export async function readCommenterTrust(
  db: D1Database,
  authorEmail: string,
  ipHash: string,
): Promise<CommenterTrust> {
  const row = await db
    .prepare(COMMENTER_TRUST_SQL)
    .bind(authorEmail, ipHash)
    .first<{ approved: number | null; spammed: number | null }>()
  // `max()` over no rows is null, not 0 — a commenter with no judged history at all.
  return { approved: row?.approved === 1, spammed: row?.spammed === 1 }
}

/**
 * The classifier's five statements (#10, layer 6). Here rather than in src/spam/ for
 * the reason the file header gives, and the count matters more for these than for
 * most: one of them is on the public submission path.
 *
 * **Exactly one — READ_SPAM_MODEL_SQL — runs on a submission**, and it is a rowid
 * seek on a table the schema forbids a second row in. The other four run only on the
 * authenticated moderation decision, which is one owner clicking one button.
 *
 * None of them is per-comment, and none grows with the site's moderation history.
 * That is the rule CLAUDE.md states — a constant query count, not a low one — and it
 * is what the classifier's whole shape exists to satisfy: a nearest-neighbour model
 * would read one row per stored vector on every submission.
 * Enforced by test/worker/spam/query-plan.test.ts and test/worker/spam/order.test.ts.
 */

/**
 * The weights, on the submission path.
 *
 * `id = 1` is the INTEGER PRIMARY KEY and `spam_model` is `CHECK (id = 1)`, so this
 * is one rowid seek against a table of one row, forever.
 */
export const READ_SPAM_MODEL_SQL = `select model, dims, weights, bias, ham_count, spam_count
     from spam_model
    where id = 1`

/**
 * A fitted classifier as it is stored, with the weights still in the shape D1 gave
 * them back.
 *
 * The BLOB is `unknown` deliberately: D1 converts it to a JavaScript `Array` of byte
 * values ("ArrayBuffer and ArrayBuffer views are converted using `Array.from`",
 * https://developers.cloudflare.com/d1/worker-api/, checked 2026-07-29), and this
 * layer does not decode it — src/spam/model.ts owns the float encoding, and typing
 * it here as `number[]` would be this file asserting a conversion it did not perform.
 */
export interface StoredSpamModel {
  model: string
  dims: number
  weights: unknown
  bias: number
  hamCount: number
  spamCount: number
}

interface SpamModelRow {
  model: string
  dims: number
  weights: unknown
  bias: number
  ham_count: number
  spam_count: number
}

/** The stored classifier, or null on a deployment that has trained none yet. */
export async function readSpamModel(db: D1Database): Promise<StoredSpamModel | null> {
  const row = await db.prepare(READ_SPAM_MODEL_SQL).first<SpamModelRow>()
  if (row === null) return null

  return {
    model: row.model,
    dims: row.dims,
    weights: row.weights,
    bias: row.bias,
    hamCount: row.ham_count,
    spamCount: row.spam_count,
  }
}

/** One statement, so two decisions moderated at once cannot interleave into half a model. */
export const WRITE_SPAM_MODEL_SQL = `insert into spam_model
         (id, model, dims, weights, bias, ham_count, spam_count, updated_at)
       values (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
       on conflict (id) do update set
         model      = excluded.model,
         dims       = excluded.dims,
         weights    = excluded.weights,
         bias       = excluded.bias,
         ham_count  = excluded.ham_count,
         spam_count = excluded.spam_count,
         updated_at = excluded.updated_at`

/**
 * Stores the fitted classifier.
 *
 * **Nothing on a public path may reach this**, for the same reason `writeSetting`
 * says so: the write budget is 100k rows/day against 5M reads, and a model write
 * reachable from the submission path would let traffic spend the day's comments. The
 * only caller is the authenticated moderation decision (src/spam/train.ts).
 * Enforced by test/worker/spam/train.test.ts.
 */
export async function writeSpamModel(
  db: D1Database,
  model: { model: string; dims: number; weights: ArrayBuffer; bias: number },
  counts: { hamCount: number; spamCount: number },
  now: number,
): Promise<void> {
  await db
    .prepare(WRITE_SPAM_MODEL_SQL)
    .bind(
      model.model,
      model.dims,
      model.weights,
      model.bias,
      counts.hamCount,
      counts.spamCount,
      now,
    )
    .run()
}

/**
 * What the trainer needs about one comment, in one statement.
 *
 * **It takes a single id and returns a single row, and that is the load-bearing
 * property rather than an optimisation.** The moderation decision cascades to
 * replies (MODERATE_SQL above), and those replies are marked spam without a
 * moderator ever reading them — #28. This read is what the trainer is given, so a
 * cascaded reply's id is not merely filtered out downstream: it is never in the
 * trainer's hands at all. `setCommentStatus` returns the cascade as a *count*, not
 * as ids, so there is nothing for a future caller to pass here by mistake.
 *
 * `prior_label` comes back on the same seek so that re-deciding a comment can be
 * told from deciding it, without a second query. `comment_id` is the primary key of
 * `comment_vectors`, so the join is a seek.
 * Enforced by test/worker/spam/train.test.ts and test/worker/db/query-plan.test.ts.
 */
export const TRAINING_SUBJECT_SQL = `select c.body, v.label as prior_label
     from comments c
     left join comment_vectors v on v.comment_id = c.id
    where c.id = ?1`

export interface TrainingSubject {
  body: string
  /** The label already stored for this comment, or null when it has never been labelled. */
  priorLabel: 'ham' | 'spam' | null
}

/** The one comment a human just judged, or null when there is no such comment. */
export async function readTrainingSubject(
  db: D1Database,
  commentId: number,
): Promise<TrainingSubject | null> {
  const row = await db
    .prepare(TRAINING_SUBJECT_SQL)
    .bind(commentId)
    .first<{ body: string; prior_label: string | null }>()
  if (row === null) return null

  return {
    body: row.body,
    priorLabel: row.prior_label === 'ham' || row.prior_label === 'spam' ? row.prior_label : null,
  }
}

/**
 * One labelled training example.
 *
 * An upsert, because a moderator may change their mind: `comment_id` is the primary
 * key, so a second decision on the same comment replaces the first rather than
 * storing two contradictory examples of the same text.
 */
export const WRITE_COMMENT_VECTOR_SQL = `insert into comment_vectors
         (comment_id, label, model, vector, created_at)
       values (?1, ?2, ?3, ?4, ?5)
       on conflict (comment_id) do update set
         label      = excluded.label,
         model      = excluded.model,
         vector     = excluded.vector,
         created_at = excluded.created_at`

/**
 * Records that a human labelled this comment, with the vector that was scored.
 *
 * **The one writer of `comment_vectors` in this project, and it is called from one
 * place** — the moderation decision handler, with the id from the request path. That
 * is the whole of #28's answer: the cascade, the spam layers and the classifier's own
 * verdict all write `comments.status` and none of them can reach this function, so a
 * row here means a person judged *this* comment. `status` answers "should this appear
 * on the page"; this table answers "did somebody decide". One column could not carry
 * both, which is what #28 diagnosed.
 * Enforced by test/worker/spam/train.test.ts.
 */
export async function writeCommentVector(
  db: D1Database,
  input: {
    commentId: number
    label: 'ham' | 'spam'
    model: string
    vector: ArrayBuffer
    now: number
  },
): Promise<void> {
  await db
    .prepare(WRITE_COMMENT_VECTOR_SQL)
    .bind(input.commentId, input.label, input.model, input.vector, input.now)
    .run()
}

/**
 * Drops all but the newest `keep` vectors of one label.
 *
 * `limit -1 offset ?2` is SQLite's "everything after the first N" — the newest `keep`
 * rows are the ones the subquery keeps, and the delete takes the rest.
 * `comment_vectors_by_label` is `(label, created_at)`, so the subquery walks that
 * label's index entries in order rather than sorting the table.
 *
 * Newest-first rather than a random sample, and that is a real trade: recency loses
 * old spam campaigns that may recur. It is chosen because the alternative needs a
 * sampling scheme nobody has evaluated, and because these rows are a *record* — the
 * fitted weights already carry every decision ever made, including the pruned ones.
 * Enforced by test/worker/spam/train.test.ts.
 */
export const PRUNE_COMMENT_VECTORS_SQL = `delete from comment_vectors
      where comment_id in (
        select comment_id from comment_vectors
         where label = ?1
         order by created_at desc, comment_id desc
         limit -1 offset ?2
      )`

export async function pruneCommentVectors(
  db: D1Database,
  label: 'ham' | 'spam',
  keep: number,
): Promise<number> {
  const { meta } = await db.prepare(PRUNE_COMMENT_VECTORS_SQL).bind(label, keep).run()
  return meta.changes
}
