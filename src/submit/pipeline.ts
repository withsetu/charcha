// The submission pipeline: validate -> derive the thread key -> run the spam seam
// -> persist -> render. One pass, ordered so that nothing writes until a comment
// has passed every free local check (#8 slots in at the seam). Card rule 5.
//
// This function owns the *order*; the HTTP boundary (route.ts) owns reading and
// size-capping the body, and the data layer (src/db) owns the queries. Keeping the
// order here, injectable and clock-free, is what makes every branch testable
// against a real D1 binding.
// Enforced by test/worker/submit/pipeline.test.ts.

import { UNDECLARED_URL_MESSAGE, selfOrigin, submittedUrlRefusal } from '../cors'
import type { SubmittedUrlRefusal } from '../cors'
import type { CommentStrings } from '../render'
import { renderComments } from '../render'
import { getOrCreateThread, insertComment, isReplyTarget, readCommenterTrust } from '../db'
import type { StoredComment } from '../db'
import type { ModerationPolicy } from '../moderation/policy'
import type { Notifier } from '../notify'
import { derivePageKey, messageForPageKeyRejection } from '../page-key'
import { clientIp, hashIp, usableIpSecret } from '../spam/ip'
// Generic isolate-scoped observability, despite the path — see src/spam/log.ts.
import { announceOnce } from '../spam/log'
import { computeBodyHash } from './hash'
import { parseComment } from './schema'
import type { SpamCheck, SpamVerdict } from './spam'

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
  /**
   * The moderation policy (#173), read by the caller rather than here (#207).
   *
   * **It used to be a `getModerationPolicy` call inside `autoApproved`, and moving it out
   * is what makes the settings cost on this path constant.** Every settings row this
   * request needs now comes from one batched statement in the route
   * (`readSiteSettings`, src/settings.ts), so the sixth setting costs no query — where
   * a read per row would have made the policy one of six seeks.
   *
   * Absent means `hold-all`, which is both the default on every deployment and the
   * fail-closed answer: a caller who forgot to resolve the policy holds comments for
   * review rather than publishing a stranger's.
   * Enforced by test/worker/submit/trust.test.ts.
   */
  moderationPolicy?: ModerationPolicy
  /**
   * Every address the owner has declared as theirs (#224), read by the caller from the
   * same batched settings statement the policy comes from.
   *
   * **Absent means none, and none means no comment is accepted for any address but this
   * deployment's own.** That is the fail-closed direction and it is the whole point of the
   * change: a caller that forgot to resolve this refuses comments loudly rather than
   * accepting a stranger's claim about which site they are on. What makes it survivable is
   * the notice the Setup tab carries while it is true — see
   * src/dashboard/components/setup/sections/declared.tsx.
   * Enforced by test/worker/submit/declared-origin.test.ts.
   */
  declaredOrigins?: readonly string[]
  strings?: CommentStrings
  /**
   * The HMAC key for `comments.ip_hash`. Absent means no hash is stored at all,
   * because an unkeyed hash of an address is reversible by anyone willing to walk
   * the address space — there is no fallback better than storing nothing.
   *
   * Storing this is what makes the per-IP half of the rate limit real: it counts
   * rows by `ip_hash`, so without a write here it queries an always-empty column
   * and admits every address (#65). It is also what gives #19's retention janitor
   * something to purge.
   * Enforced by test/worker/submit/ip-hash.test.ts.
   */
  ipSecret?: string
  /**
   * Who to tell about a stored comment (#14). Absent means nobody, which is the
   * default and a valid state — see src/notify/index.ts.
   */
  notifier?: Notifier
  /**
   * How to run work *after* the reader's response has gone out — `ctx.waitUntil`
   * in the Worker, a collector in tests.
   *
   * Both this and `notifier` are required for a notification to happen, and the
   * missing-`defer` case does nothing rather than falling back. A notifier with no
   * way to defer has only two other options: `await` it, which puts a third party's
   * uptime in front of the reader's POST, or drop the promise, which is the
   * unreported failure CLAUDE.md names. Neither is better than not notifying.
   * Enforced by test/worker/notify/pipeline-seam.test.ts.
   */
  defer?: (work: Promise<unknown>) => void
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

  // **The address the comment claims to be from has to be one the owner declared (#224).**
  // It runs here, on the canonical URL `derivePageKey` just produced rather than on the raw
  // field, and before the spam seam — so a refused submission costs no subrequest, no
  // Turnstile verification and no third-party check, exactly as the ordering in
  // src/spam/index.ts argues for its own layers. It is not one of those layers: they judge
  // a comment, and this decides whether this deployment takes comments for that site at
  // all.
  const refusal = submittedUrlRefusal(key.pageUrl, {
    declared: deps.declaredOrigins ?? [],
    self: selfOrigin(deps.request),
  })
  if (refusal !== null) {
    logUndeclaredUrl(refusal, key.pageKey)
    return { outcome: 'rejected', message: UNDECLARED_URL_MESSAGE }
  }

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

  // Hashed here rather than at the boundary, so a comment the spam layers rejected
  // costs no HMAC and leaves no trace: the reject path returns before this line.
  // Both halves must hold for a hash to exist — a configured key and an address
  // the edge actually gave us — and the raw address is never passed on.
  const secret = usableIpSecret(deps.ipSecret)
  const ip = secret === null ? null : clientIp(deps.request)
  const ipHash = ip === null || secret === null ? null : await hashIp(ip, secret)

  // The moderation policy (#173), and the only thing on this path that can publish a
  // stranger's comment without a human seeing it. It is computed here, from a database
  // read, and never from `input` — see `autoApproved` below.
  const autoApprove = await autoApproved({
    db: deps.db,
    verdict,
    ipHash,
    authorEmail: comment.authorEmail ?? null,
    policy: deps.moderationPolicy ?? 'hold-all',
  })

  // No status is passed: insertComment derives it from byOwner — which this public
  // path never sets — and from the trust decision above. A public handler that could
  // choose the status could self-approve.
  //
  // The `review` verdict's reason is stored with it (#70). Without it a held
  // comment and a clean one are the same row — both `pending` — and the human
  // gate is asked to decide with the one thing the layers learned thrown away. It
  // is stored only for `review`: an `allow` has no reason, and a `reject` never
  // reaches this line.
  const stored = await insertComment(deps.db, {
    threadId: thread.id,
    parentId: comment.parentId ?? null,
    authorName: comment.authorName,
    authorEmail: comment.authorEmail ?? null,
    body: comment.body,
    bodyHash,
    ipHash,
    spamReason: verdict.action === 'review' ? verdict.reason : null,
    autoApprove,
    now: deps.now,
  })

  // After the write and after nothing else. A rejected comment returned above, so a
  // spam flood the layers stopped costs zero emails and zero of the owner's Resend
  // quota — the cheapest flood control there is, and it comes free from where this
  // line sits. Enforced by test/worker/notify/pipeline-seam.test.ts.
  notifyOwner(stored, key.pageKey, comment.authorName, deps)

  const html = renderSingle(stored, deps.strings)
  return stored.status === 'approved'
    ? { outcome: 'published', html }
    : { outcome: 'pending', html }
}

/**
 * What the owner sees when a submission was refused for its address (#224).
 *
 * **The reason token is the whole reason this line exists.** The response says one thing
 * for all three cases on purpose, so without a log there is no way to tell a deployment
 * nobody has configured from one being probed — which is the observability rule CLAUDE.md
 * states for the spam pipeline, applied to the check that sits in front of it. The token is
 * namespaced the way `turnstile: no-token-unverified-deployment` is.
 *
 * `pageKey` and nothing else, matching `logVerdict` in src/spam/log.ts: no body, no author,
 * no email, no address and no address hash. A log line outlives the retention sweep (#19).
 *
 * `nothing-declared` announces itself once per isolate as well, because that one is a fact
 * about the deployment rather than about a comment, and it is the state an owner most needs
 * a sentence about. The per-comment line still fires every time — a refusal is rare on a
 * configured deployment, and on an unconfigured one it is the only trace of what was lost.
 * Enforced by test/worker/submit/declared-origin.test.ts.
 */
function logUndeclaredUrl(reason: SubmittedUrlRefusal, pageKey: string): void {
  console.log(
    JSON.stringify({
      event: 'submitted_url_refused',
      check: 'declared-origin',
      reason,
      pageKey,
    }),
  )

  if (reason === 'nothing-declared') {
    announceOnce('submit-no-declared-origins', {
      event: 'settings_config',
      setting: 'site_url',
      problem:
        'this deployment has declared no addresses of its own, so every comment is being refused',
      fix: 'save your site’s address on the Setup tab of your Charcha dashboard at /admin',
    })
  }
}

/**
 * Whether the owner's moderation policy publishes this comment without review (#173).
 *
 * **Every layer of the spam pipeline terminates in the queue, and this is the only door
 * out of it.** So it is written as a run of refusals with one `true` at the very end:
 * an unreadable setting, a missing hash, a missing email and a verdict that is not
 * `allow` each land on `false`, which is today's behaviour on every deployment and costs
 * nobody anything they were not already paying. Card rule 5, in the one place on this
 * path where failing open would publish a stranger's comment.
 *
 * **A database error is deliberately not caught here, and that is closed rather than
 * open.** The remaining read throwing propagates out of `runSubmission` as it does for
 * `getOrCreateThread` and `insertComment`, so the reader gets an error and is told their
 * comment did not post — which is true, because `insertComment` is downstream of this
 * line and never ran. The same holds one step earlier, for the batched settings read the
 * policy now arrives from: it happens before the spam check, and a failure there is a 500
 * with nothing stored. A `catch` returning `false` would be the tempting shape and the
 * wrong one: it would store the comment as `pending` while reporting success, which is
 * the right *status* reached by hiding a fault the deployment needs to know about.
 * Enforced by test/worker/submit/trust.test.ts.
 *
 * **The risk is asymmetric and the order of these guards is that asymmetry.** Wrongly
 * trusting somebody publishes spam with no human in the way; wrongly not trusting
 * somebody holds a real comment for review, which is exactly what happens today. False
 * negatives are free. False positives are not. So the matching is strict, and when it
 * does not match the behaviour is simply the old one.
 *
 * **A spam verdict overrides trust, and that is the first line.** `review` means some
 * layer objected, and a regular whose comment trips the content heuristics or arrives
 * without a Turnstile token is exactly the case where the owner should get to look.
 * Trust decides what happens to an *unflagged* comment and nothing more.
 *
 * **The free checks come before the reads**, the same shape `isReplyTarget` above has
 * and the same argument src/spam/index.ts makes for the layer ordering: a comment that
 * cannot be trusted for a reason costing no I/O must not spend a query finding that
 * out. A comment with no email — most of them — costs nothing here at all. What it
 * costs at most is two primary-key/index seeks, neither of which grows with the number
 * of comments on the page or in the commenter's history.
 * Enforced by test/worker/submit/trust.test.ts.
 */
async function autoApproved(input: {
  db: D1Database
  verdict: SpamVerdict
  ipHash: string | null
  authorEmail: string | null
  /** Already read, from the one batched settings statement this request makes (#207). */
  policy: ModerationPolicy
}): Promise<boolean> {
  // A layer objected. Neither history nor a provider's good opinion overrules a live
  // signal, and this single line is what makes that true for both paths below.
  if (input.verdict.action === 'review' || input.verdict.action === 'reject') return false

  // The vouch path (#189), and it is deliberately short. A `vouch` is a real
  // classifier's verdict about *this comment*, so it asks nothing about who sent it —
  // no email, no address hash, no history. That is the difference from the path below,
  // where the whole question is whether we recognise a person.
  //
  // No read at all any more: the policy came from the request's one batched settings
  // statement (#207). Nothing else in the pipeline can produce a `vouch`, so this line is
  // unreachable on a deployment that opted into nothing.
  if (input.verdict.action === 'vouch') {
    return input.policy === 'trust-vouched'
  }

  // `allow` from here down — the returning-commenter path, unchanged from #173.
  //
  // Half an identity is not an identity. No hash means either no `IP_HASH_SECRET` or
  // no address from the edge, and either way nothing here can recognise anybody; no
  // email means the same from the other side. Both are checked before any read because
  // both are free, and an empty string is not a value — it would otherwise match every
  // other comment stored with one.
  const { ipHash, authorEmail } = input
  if (ipHash === null || ipHash === '') return false
  if (authorEmail === null || authorEmail === '') return false

  // Checked second, because the answer is the same for every commenter on a deployment
  // that has not changed it — and that is every deployment until somebody does. It costs
  // nothing now that the policy arrives with the request rather than being read here.
  //
  // `trust-vouched` is listed here as well as above because the policies are a ladder
  // rather than a menu: an owner who turned on the stronger one did not thereby ask to
  // stop trusting the regulars they had already approved.
  // Enforced by test/worker/submit/vouched.test.ts.
  if (input.policy !== 'trust-returning' && input.policy !== 'trust-vouched') return false

  const trust = await readCommenterTrust(input.db, authorEmail, ipHash)
  // Revocation is `spammed`, and it wins over any number of approvals. Marking a
  // trusted person's comment as spam is the owner saying they were wrong about them,
  // so it withdraws the standing rather than being one bad comment among good ones.
  // It is also reversible in the obvious direction: approving that comment later
  // leaves no spam row, and the standing comes back.
  return trust.approved && !trust.spammed
}

/**
 * Hands the stored comment to the notifier, without waiting for it and without
 * letting it cost the reader their comment.
 *
 * Two guards, and they are different guards. The `Notifier` contract promises never
 * to reject, which is what makes handing the promise to `ctx.waitUntil` safe; this
 * `try`/`catch` covers the other half — a *synchronous* throw from `commentCreated`
 * or from `defer` itself, which no contract on the returned promise can prevent. A
 * comment is already committed by this point, so a notifier bug turning a stored
 * comment into a 500 would tell the reader their comment was lost when it was not.
 *
 * Two things are deliberately not passed and have no field on the event type: the
 * commenter's email, and `key.pageUrl` — whose origin is attacker-chosen, because
 * `derivePageKey` drops the origin from a thread's identity. See src/notify/index.ts.
 *
 * `commentCreated` is called before `defer` receives its promise, so a throwing
 * `defer` leaves that promise unattended. That is safe only because the contract says
 * it cannot reject — the one place here that leans on the contract rather than
 * checking it — and src/notify/index.ts makes it total with its own catch.
 * Enforced by test/worker/notify/pipeline-seam.test.ts.
 */
function notifyOwner(
  stored: StoredComment,
  pageKey: string,
  authorName: string,
  deps: SubmitDeps,
): void {
  const { notifier, defer } = deps
  if (notifier === undefined || defer === undefined) return

  try {
    defer(
      notifier.commentCreated({
        commentId: stored.id,
        authorName,
        body: stored.body,
        pageKey,
        status: stored.status,
      }),
    )
  } catch (error) {
    // Reported, not swallowed: a notifier that throws on every comment is otherwise
    // invisible, because the reader's submission succeeds regardless.
    console.error('notify: dispatch failed', error)
  }
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
