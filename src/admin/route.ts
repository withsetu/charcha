// The authenticated endpoints. This is the file that finally calls
// setCommentStatus — before it, a comment could be stored and never judged, and
// Charcha was a one-way write.
//
// Every handler here is behind resolveIdentity except the login itself, which is a
// public unauthenticated endpoint and inherits card rule 5 in full: it is
// throttled, it compares in constant time, and no failure it returns distinguishes
// one cause from another.
// Enforced by test/worker/admin/route.test.ts, test/worker/admin/queue.test.ts and
// test/worker/admin/cookie-scope.test.ts.

import type { Context } from 'hono'
import { z } from 'zod'
import {
  NoSuchCommentError,
  countCommentsByStatus,
  listModerationQueue,
  parseQueueCursor,
  setCommentStatus,
} from '../db'
import type { CommentStatus, QueueCursor, StatusCounts } from '../db'
import type { Embedder } from '../spam/embed'
import { trainOnDecisionSafely } from '../spam/train'
import {
  adminJson,
  adminNoContent,
  badRequest,
  forbidden,
  notFound,
  readAdminJson,
  tooManyRequests,
  unauthorized,
} from './api'
import { announceSecretUnset, authenticated } from './authenticate'
import { isCrossOriginRequest } from './csrf'
import type { AdminEnv } from './env'
import { passwordMatches, usableDashboardPassword } from './password'
import { clearedSessionCookie, issueSession, sessionCookie } from './session'
import { loginThrottle } from './throttle'

/**
 * Everything under here is the dashboard's API, and answers JSON in one shape —
 * including the 404 and the 500, which src/index.ts owns rather than any route.
 */
export const ADMIN_API_PREFIX = '/admin/api/'

/** The routes, as constants, so src/index.ts and the tests name the same strings. */
export const SESSION_PATH = '/admin/api/session'
export const QUEUE_PATH = '/admin/api/queue'
export const COMMENT_STATUS_PATH = '/admin/api/comments/:id/status'

type AdminContext = Context<{ Bindings: Env }>

export interface AdminRouteConfig {
  /** Injectable for tests; defaults to the wall clock in unix seconds. */
  now?: () => number
  /**
   * The classifier's embedder, in place of the `AI` binding (#10).
   *
   * Injected by tests and by nothing in production, for the reason vitest.config.ts
   * gives: Workers AI has no local simulation, so a test that reached the real
   * binding would need account credentials and would spend the owner's neurons on
   * every run.
   */
  embed?: Embedder
}

function clock(config: AdminRouteConfig): number {
  return config.now ? config.now() : Math.floor(Date.now() / 1000)
}

const loginSchema = z.object({ password: z.string() })

const statusSchema = z.object({
  status: z.enum(['pending', 'approved', 'spam', 'deleted']),
})

/**
 * The statuses the queue can be asked for. The same four the column allows — a
 * status outside them is not a narrower query, it is a caller who guessed.
 */
const queueStatusSchema = z.enum(['pending', 'approved', 'spam', 'deleted'])

/**
 * The counts the dashboard's tab strip shows (#135), which are the three statuses it
 * has views for.
 *
 * `deleted` is counted by the same statement and deliberately not sent: there is no
 * deleted view, so it would be a number with no reader. Narrowing here rather than in
 * the data layer keeps `countCommentsByStatus` the honest shape of `group by status`,
 * and it is what lets the dashboard key `QueueCounts` by `ViewStatus` — so a view
 * without a count does not typecheck instead of merely being unlikely.
 * Enforced by test/worker/admin/queue.test.ts.
 */
function viewCounts(counts: StatusCounts) {
  return { pending: counts.pending, spam: counts.spam, approved: counts.approved }
}

/**
 * `POST /admin/api/session` — sign in.
 *
 * The order of the checks is the design, and it is cheapest-and-most-protective
 * first, the same rule src/spam/index.ts follows:
 *
 *   1. the Origin check — one string comparison, no I/O, and it stops a
 *      cross-site page before anything else runs
 *   2. the throttle — the brute-force bound, and it must come before any hashing
 *      so that a guesser cannot make this Worker do SHA-256 and HMAC work per
 *      attempt
 *   3. the body — bounded, then parsed, then validated
 *   4. the configured secret — an unconfigured deployment refuses, and says so to
 *      the log rather than to the caller
 *   5. the comparison — constant time, on two digests
 *
 * **The body is validated before the secret is consulted, and the order matters for
 * a reason a fresh-context review caught rather than one anyone designed.** With the
 * secret checked first, an unconfigured deployment answered 401 to a malformed body
 * where a configured one answered 400 or 413 — so a single unauthenticated request
 * with a deliberately broken body revealed whether CHARCHA_DASHBOARD_PASSWORD was
 * set, which is to say whether anybody was watching. That is exactly the disclosure
 * the paragraph below claims not to make, and the test that claimed to cover it only
 * ever sent a *well-formed* attempt. Validating first makes the malformed-input
 * answers identical on both.
 *
 * A wrong password, an absent password field, a missing secret and a malformed
 * body are four different situations and the caller is told apart only the ones it
 * can fix without learning anything: 400 for a body that is not a login attempt,
 * 401 for a login attempt that failed. "No password is configured" is never
 * distinguishable from "that password is wrong".
 * Enforced by test/worker/admin/route.test.ts.
 */
export async function handleLogin(
  c: AdminContext,
  config: AdminRouteConfig = {},
): Promise<Response> {
  if (isCrossOriginRequest(c.req.raw)) return forbidden()

  const env: AdminEnv = c.env
  if (!(await loginThrottle(env.LOGIN_RATE_LIMITER).allow(c.req.raw))) return tooManyRequests()

  const body = await readAdminJson(c.req.raw)
  if (!body.ok) return body.response

  const parsed = loginSchema.safeParse(body.value)
  if (!parsed.success) return badRequest('A password is required.')

  const secret = usableDashboardPassword(env.CHARCHA_DASHBOARD_PASSWORD)
  if (secret === null) {
    // Announced for the owner, never answered to the caller. Someone who never set
    // the secret, or set it in the wrong place, has no other way to learn why their
    // own dashboard refuses them — and a 401 that said "not configured" would tell an
    // attacker both that guessing is pointless and that nobody is watching.
    // announceSecretUnset is shared with sessionAuthenticator so the line appears
    // whichever admin route the owner reaches first.
    announceSecretUnset()
    return unauthorized()
  }

  if (!(await passwordMatches(parsed.data.password, secret))) return unauthorized()

  const { token, expiresAt } = await issueSession(secret, clock(config))
  return adminJson({ authenticated: true, via: 'session', expiresAt }, 200, {
    'set-cookie': sessionCookie(token),
  })
}

/**
 * `DELETE /admin/api/session` — sign out.
 *
 * Deliberately not behind authentication. The commonest reason to press sign-out is
 * that the session has already expired, and an endpoint that required a valid
 * session to clear a cookie would leave a stale cookie in place exactly when it
 * matters. It changes nothing on the server — there is no session state to delete —
 * so there is nothing an unauthenticated caller gains. The Origin check still runs,
 * because a cross-site page signing the owner out is a nuisance worth refusing.
 * Enforced by test/worker/admin/route.test.ts.
 */
export function handleLogout(c: AdminContext): Response {
  if (isCrossOriginRequest(c.req.raw)) return forbidden()
  return adminNoContent({ 'set-cookie': clearedSessionCookie() })
}

/**
 * `GET /admin/api/session` — is this browser signed in, and by what.
 *
 * The dashboard's first call on load: it decides between the login form and the
 * queue, and `via` is what will let it say "signed in with Cloudflare Access" once
 * #108 exists without the client learning a second endpoint.
 * Enforced by test/worker/admin/route.test.ts.
 */
export async function handleSession(
  c: AdminContext,
  config: AdminRouteConfig = {},
): Promise<Response> {
  const auth = await authenticated(c.env, c.req.raw, clock(config))
  if (!auth.ok) return auth.response
  return adminJson({ authenticated: true, via: auth.via })
}

/**
 * `GET /admin/api/queue?status=&limit=&cursor=` — one bounded page of triage.
 *
 * `limit` is clamped and `cursor` is rejected, and that asymmetry is deliberate —
 * see clampQueueLimit and parseQueueCursor in src/db. A page size out of range has a
 * safe nearest value; a cursor does not, and silently dropping one would make every
 * "next page" return page one, so the UI would loop over the first page forever
 * while the oldest comments stayed unreachable.
 *
 * **Two D1 queries, whichever page is asked for** — the page and the per-status counts
 * (#135). Two rather than one because the tab strip claims a number for every view and
 * a request per view would make the query count grow with the UI; two rather than a
 * separate endpoint because the counts change on exactly the events the queue does, and
 * a second round trip is a second thing to fail while the first has already rendered.
 * Constant either way, which is what the 50-query invocation budget asks for.
 * Enforced by test/worker/admin/queue.test.ts.
 */
export async function handleQueue(
  c: AdminContext,
  config: AdminRouteConfig = {},
): Promise<Response> {
  const auth = await authenticated(c.env, c.req.raw, clock(config))
  if (!auth.ok) return auth.response

  const url = new URL(c.req.url)

  // Defaulted, not optional-in-the-query: `pending` is the triage queue and is what
  // a dashboard asking for no particular status means. An unrecognised value is a
  // 400 rather than a silent fall back to `pending` — a caller that asked for
  // `?status=aproved` and got the pending queue has been answered a question it did
  // not ask, and would show it as though it were the one it did.
  const statusParam = url.searchParams.get('status')
  let status: CommentStatus = 'pending'
  if (statusParam !== null) {
    const parsed = queueStatusSchema.safeParse(statusParam)
    if (!parsed.success) return badRequest('That is not a comment status.')
    status = parsed.data
  }

  const cursorParam = url.searchParams.get('cursor')
  let cursor: QueueCursor | null = null
  if (cursorParam !== null) {
    cursor = parseQueueCursor(cursorParam)
    if (cursor === null) return badRequest('That page cursor is not valid.')
  }

  const page = await listModerationQueue(c.env.DB, status, {
    limit: url.searchParams.get('limit') ?? undefined,
    cursor,
  })
  const counts = await countCommentsByStatus(c.env.DB)
  return adminJson({ ...page, counts: viewCounts(counts) })
}

/**
 * `POST /admin/api/comments/:id/status` — the moderation decision.
 *
 * The endpoint the whole of #12 exists to make possible: before it,
 * setCommentStatus had no caller anywhere in src/ and no comment could ever be
 * approved.
 *
 * POST rather than PATCH on the comment, because the thing being created is a
 * decision rather than a field edit: hiding a comment also hides the replies under
 * it (see setCommentStatus), so this is not a partial update of one row and should
 * not read as one.
 *
 * One decision per request. A bulk endpoint is #109, and it is filed rather than
 * built for a specific reason: setCommentStatus is one statement per comment, so the
 * obvious loop passes every test at three comments and throws in production at
 * fifty, where the 50-query invocation budget ends.
 * Enforced by test/worker/admin/queue.test.ts.
 */
export async function handleCommentStatus(
  c: AdminContext,
  config: AdminRouteConfig = {},
): Promise<Response> {
  if (isCrossOriginRequest(c.req.raw)) return forbidden()

  const now = clock(config)
  const auth = await authenticated(c.env, c.req.raw, now)
  if (!auth.ok) return auth.response

  // Checked before the database is asked, the same way isReplyTarget checks its id:
  // an endpoint should not spend a query proving that `-1` is not a comment.
  const idParam: string | undefined = c.req.param('id')
  const id = idParam !== undefined && /^\d{1,15}$/.test(idParam) ? Number(idParam) : Number.NaN
  if (!Number.isSafeInteger(id) || id < 1) return badRequest('That is not a comment id.')

  const body = await readAdminJson(c.req.raw)
  if (!body.ok) return body.response

  const parsed = statusSchema.safeParse(body.value)
  if (!parsed.success) return badRequest('That is not a comment status.')

  try {
    const comment = await setCommentStatus(c.env.DB, id, parsed.data.status, now)

    // The training signal (#10): this is the moment a human judged a comment, and
    // the only moment anything in this project writes a label.
    //
    // **`id` is the comment the moderator acted on, and it is the only id passed.**
    // The statement above also moved the replies underneath it — `setCommentStatus`
    // cascades a spam or deleted decision — and nobody read those. They are #28's
    // mislabelled rows, and they are disproportionately *good* comments, because
    // somebody engaged enough to reply. They are excluded here by there being
    // nothing to exclude: `comment.cascaded` is a count, not a list, so no reply id
    // exists at this call site to hand over.
    // Enforced by test/worker/spam/train.test.ts.
    //
    // **Awaited rather than deferred**, which costs this response an embedding call
    // (~100-300 ms) on a request the dashboard has already answered optimistically
    // (#133). The alternative is `waitUntil`, and it was not taken: training is the
    // half of this feature with no user-visible symptom when it silently stops, so
    // the version that reports its own outcome on the same request is worth more
    // than the milliseconds. It cannot fail the decision — that is already
    // committed, and `trainOnDecisionSafely` is total.
    const trained = await trainOnDecisionSafely(id, parsed.data.status, {
      db: c.env.DB,
      ai: c.env.AI,
      embed: config.embed,
      now,
    })
    if (trained === 'failed' || trained === 'no-such-comment') {
      console.log(JSON.stringify({ event: 'classifier_training', outcome: trained, id }))
    }

    // Recounted rather than adjusted by one (#135). A decision on a comment with
    // replies moves all of them — setCommentStatus cascades — so the change is not
    // always one, and a dashboard keeping its own tally would be wrong by however many
    // replies there were, with nothing on screen to reveal it. One more query, and the
    // count is the database's answer rather than the client's arithmetic.
    const counts = await countCommentsByStatus(c.env.DB)
    return adminJson({
      id: comment.id,
      status: comment.status,
      moderatedAt: comment.moderatedAt,
      counts: viewCounts(counts),
      // How many replies went with it (#133). Already computed by the statement above
      // and previously dropped here — so the counts moved by four while the dashboard
      // could only say one comment had been dealt with, and three replies left the site
      // with nothing anywhere naming them. Costs no extra read.
      cascaded: comment.cascaded,
    })
  } catch (error) {
    // Only this one, by class. Catching everything would report a D1 outage as "no
    // such comment", which is the report that stops anyone investigating.
    if (error instanceof NoSuchCommentError) return notFound('There is no comment with that id.')
    throw error
  }
}
