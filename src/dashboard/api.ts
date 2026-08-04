// The dashboard's only way to reach the Worker: a typed client over the
// authenticated endpoints #12 shipped, in src/admin/route.ts.
//
// **Nothing in here throws, and that is the contract rather than a courtesy.**
// CLAUDE.md's rule is that unawaited async owes the user a specific message, and a
// client that rejects moves that obligation to every call site — where the one that
// forgets shows a skeleton that never resolves. So every failure comes back as a
// value: a code the UI can branch on and a sentence it can show. `fetch` rejecting,
// a body that is not JSON, and a 401 are three different failures and each has its
// own code.
// Enforced by test/dashboard/api.test.ts.

// The moderation policy union, shared with the Worker rather than restated here (#173).
// It imports nothing, so both TypeScript projects can have it — the same arrangement
// src/cascade.ts has, and for the same reason: a second copy would let this screen offer
// a value the Worker does not recognise, with every test in both projects still green.
import { MODERATION_POLICIES } from '../moderation/policy'
import type { ModerationPolicy } from '../moderation/policy'

export { MODERATION_POLICIES }
export type { ModerationPolicy }

/**
 * Every request is same-origin and relative, and neither is incidental.
 *
 * The session cookie is scoped `Path=/admin` (src/admin/session.ts), so a request
 * to any other path would not carry it at all. The state-changing endpoints also
 * refuse a request whose `Origin` is not this Worker's own (src/admin/csrf.ts) —
 * and `Origin` is a forbidden header name, so it is the browser that sets it from
 * the page. A relative URL is therefore the whole of what makes these requests
 * pass the CSRF check: an absolute URL to another origin would be refused by the
 * server, and there is deliberately no `OPTIONS` route to preflight it.
 * Enforced by test/dashboard/api.test.ts.
 */
const API_ROOT = '/admin/api'

/** The statuses the queue can be viewed as. `deleted` is reachable, but not a view. */
export type ViewStatus = 'pending' | 'spam' | 'approved'

/**
 * The three decisions the queue offers, which are the three keys `A`, `S` and `D`.
 *
 * Narrower than what the endpoint accepts, deliberately: `pending` is a status a
 * comment can be *put back* to by an undo, and is not a decision anybody makes.
 */
export type DecisionStatus = 'approved' | 'spam' | 'deleted'

/** Every status `POST /admin/api/comments/:id/status` will accept. */
export type SettableStatus = 'pending' | DecisionStatus

export const VIEW_STATUSES: readonly ViewStatus[] = ['pending', 'spam', 'approved']

/**
 * The error codes src/admin/api.ts documents as stable, plus the two failures that
 * never reach the server and so have no code of its making.
 *
 * `NETWORK` and `MALFORMED` are in the same union rather than a second one because
 * the UI's question is always "what do I tell the owner, and can they retry" — and
 * a client that had to check two shapes is a client that checks one.
 */
export type FailureCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'TOO_MANY_REQUESTS'
  | 'UNAVAILABLE'
  | 'NETWORK'
  | 'MALFORMED'

export interface ApiFailure {
  code: FailureCode
  /** Shown to the owner. Always a whole sentence, never an empty string. */
  message: string
  /** The HTTP status, or null when the request never got one. */
  status: number | null
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure }

/** One comment as the queue endpoint sends it — `QueuedComment` over the wire. */
export interface QueuedComment {
  id: number
  threadId: number
  parentId: number | null
  depth: number
  authorName: string
  /**
   * The comment as the commenter typed it: Markdown, untrusted, unrendered.
   *
   * It is rendered for display by src/render's `renderMarkdown` and by nothing
   * else. See src/dashboard/components/comment-body.tsx.
   */
  body: string
  byOwner: boolean
  status: string
  createdAt: number
  moderatedAt: number | null
  pageKey: string
  pageTitle: string | null
  /**
   * The page this comment was left on, or null when there is none to give (#203).
   *
   * **Built by the Worker from the owner's own `site_url` setting and the derived key,
   * and this side may not build one.** `pageKey` is a path with no origin and the URL a
   * comment reported is attacker-chosen, so the only trustworthy base is the one the
   * owner configured — see `permalinkFor` in src/page-key.ts and handleQueue in
   * src/admin/route.ts. Null for a `data-thread` key, which names no page, and for a
   * deployment with no site address saved, which is most of them.
   * Enforced by test/worker/admin/queue.test.ts and test/dashboard/triage.test.tsx.
   */
  permalink: string | null
  /** Why a spam layer held this comment, or null when none did (#70). */
  spamReason: string | null
}

/**
 * How many comments are in each view, whatever page is loaded (#135).
 *
 * Keyed by `ViewStatus` rather than declared as an interface, so a view without a count
 * does not typecheck: the tab strip maps over `VIEW_STATUSES`, and this is what makes
 * `counts[view]` a number at every one of them instead of possibly `undefined`.
 *
 * `deleted` is deliberately absent. The endpoint counts it — it is one `group by` — and
 * does not send it, because there is no deleted view and it would be a number with no
 * reader. See viewCounts in src/admin/route.ts.
 */
export type QueueCounts = Record<ViewStatus, number>

export interface QueuePage {
  comments: QueuedComment[]
  nextCursor: string | null
  /**
   * The whole queue's size per view, which is not `comments.length`.
   *
   * It rides along with the page rather than coming from an endpoint of its own: the
   * counts change on exactly the events the queue does, and a second request would be a
   * second thing to fail after the first had already rendered.
   */
  counts: QueueCounts
}

export interface SessionState {
  authenticated: true
  via: string
}

export interface DecisionResult {
  id: number
  status: string
  moderatedAt: number | null
  /**
   * The counts as they are *after* this decision (#135).
   *
   * Recomputed by the server rather than adjusted here by one, because the decision
   * cascades to the replies under the comment — so the change is not always one, and a
   * tally kept in the client would be wrong by however many replies there were.
   * Enforced by test/worker/admin/queue.test.ts.
   */
  counts: QueueCounts
  /**
   * How many replies the decision took with it (#133).
   *
   * Zero for an approval, which does not cascade, and zero for a comment with no
   * replies. Counted from the rows that actually moved, so it agrees with `counts`
   * above rather than contradicting the badges beside it — see MODERATE_SQL in src/db.
   *
   * Cast rather than validated, like everything else here except `readSetup`: a value
   * that is not a number is reduced to zero by the reducer, which under-claims instead
   * of announcing "and undefined replies". See countOfReplies in src/dashboard/queue.ts.
   * Enforced by test/worker/admin/queue.test.ts and test/dashboard/queue.test.ts.
   */
  cascaded: number
}

/** A whole sentence for each failure that never reached a handler. */
const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.'
const MALFORMED_MESSAGE = 'The server sent a reply this dashboard could not read.'

const CODES: ReadonlySet<string> = new Set<FailureCode>([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'TOO_LARGE',
  'TOO_MANY_REQUESTS',
  'UNAVAILABLE',
])

/**
 * The `{error:{code,message}}` body src/admin/api.ts guarantees, read defensively.
 *
 * Defensively because "the server always answers in one shape" is a property of the
 * server, and this runs in a browser that may be talking to a proxy, a captive
 * portal or a Worker mid-deploy. An unrecognised body becomes `MALFORMED` with the
 * status kept, rather than a `code` the UI would branch on having invented it.
 * Enforced by test/dashboard/api.test.ts.
 */
function readFailure(status: number, body: unknown): ApiFailure {
  const error = (body as { error?: unknown } | null)?.error
  if (error !== null && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown }
    if (
      typeof code === 'string' &&
      CODES.has(code) &&
      typeof message === 'string' &&
      message !== ''
    )
      return { code: code as FailureCode, message, status }
  }
  return { code: 'MALFORMED', message: MALFORMED_MESSAGE, status }
}

interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
  /** 204 answers carry no body; `undefined` is then the success value. */
  empty?: boolean
}

/**
 * One request, and the single place a `fetch` rejection is turned into a value.
 *
 * `credentials: 'same-origin'` is stated rather than left to the default so that
 * the cookie the whole surface depends on is not a property of whichever fetch
 * default the browser ships. `cache: 'no-store'` matches the `no-store` every admin
 * response already carries; a moderation queue read from a cache is a queue showing
 * comments the owner has already dealt with.
 */
async function request<T>(spec: RequestSpec): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(`${API_ROOT}${spec.path}`, {
      method: spec.method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers:
        spec.body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    })
  } catch {
    // The offline case, a DNS failure, a cancelled navigation. Nothing was read, so
    // nothing can be said about the request's effect — which is why the message
    // tells the owner to retry rather than reporting what did or did not happen.
    return { ok: false, failure: { code: 'NETWORK', message: NETWORK_MESSAGE, status: null } }
  }

  if (spec.empty === true && response.status === 204) {
    return { ok: true, value: undefined as T }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    // A body that is not JSON is `MALFORMED` whatever the status, and the status is
    // kept: a 502 from a proxy in front of this Worker is an HTML error page, and
    // "502" is the only part of it worth showing anyone.
    return {
      ok: false,
      failure: { code: 'MALFORMED', message: MALFORMED_MESSAGE, status: response.status },
    }
  }

  if (!response.ok) return { ok: false, failure: readFailure(response.status, body) }
  return { ok: true, value: body as T }
}

/** `GET /admin/api/session` — is this browser signed in. A 401 is the answer "no". */
export function readSession(): Promise<ApiResult<SessionState>> {
  return request<SessionState>({ method: 'GET', path: '/session' })
}

/** `POST /admin/api/session` — sign in. */
export function signIn(password: string): Promise<ApiResult<SessionState>> {
  return request<SessionState>({ method: 'POST', path: '/session', body: { password } })
}

/** `DELETE /admin/api/session` — sign out. Answers 204, so there is no value. */
export function signOut(): Promise<ApiResult<undefined>> {
  return request<undefined>({ method: 'DELETE', path: '/session', empty: true })
}

/**
 * `GET /admin/api/queue` — one bounded page.
 *
 * The cursor is passed straight back as the server sent it and is never
 * constructed here. src/db's `parseQueueCursor` rejects rather than clamps, so a
 * cursor this client had assembled from a row would 400 the moment the encoding
 * changed — where an opaque round-trip cannot.
 */
export function readQueue(
  status: ViewStatus,
  cursor?: string | null,
): Promise<ApiResult<QueuePage>> {
  const query = new URLSearchParams({ status })
  if (cursor !== undefined && cursor !== null) query.set('cursor', cursor)
  return request<QueuePage>({ method: 'GET', path: `/queue?${query.toString()}` })
}

/**
 * `POST /admin/api/comments/:id/status` — one moderation decision.
 *
 * One comment per call, and there is deliberately no bulk variant: `setCommentStatus`
 * is one statement per comment, so a loop here would pass at three comments and throw
 * at fifty where the query-per-invocation budget ends. The set-based statement that
 * makes bulk possible is #109.
 */
export function decide(id: number, status: SettableStatus): Promise<ApiResult<DecisionResult>> {
  return request<DecisionResult>({
    method: 'POST',
    path: `/comments/${String(id)}/status`,
    body: { status },
  })
}

/** The owner's settings as the server holds them (#57, #173). */
export interface Settings {
  /** The cross-origin allowlist, canonicalised — what the public check compares. */
  allowedOrigins: string[]
  /**
   * What happens to a comment no spam layer objected to (#173).
   *
   * Typed as `ModerationPolicy` rather than `string` — the union is imported from
   * src/moderation/policy.ts, which imports nothing and so reaches both TypeScript
   * projects, the same arrangement `cascades` has. A second copy of the list here would
   * let this screen offer a value the Worker parses back to the default, silently.
   *
   * It is what `getModerationPolicy` returns, so a stored row holding something
   * unrecognisable arrives as `hold-all` — the policy that will actually be applied,
   * rather than the string that happens to be in the table.
   */
  moderationPolicy: ModerationPolicy
  /**
   * This deployment's own address, which is allowed whether or not it is listed.
   *
   * Sent so the dashboard can say the true thing. An owner shown only the list would
   * reasonably read it as the whole rule, add this address to it by hand, and never
   * learn that a fresh deployment already accepts its own origin — see resolveOrigin
   * in src/cors.ts.
   */
  selfOrigin: string
  /**
   * The site this deployment takes comments for (#207) — `''` when the owner has set none.
   *
   * The **row**, never the deprecated `CHARCHA_SITE_URL` secret's value: a field prefilled
   * with something the owner never typed into it is a value they would save without
   * deciding to, and #158's rule is that this surface renders no secret's value at all.
   * `fromDeprecatedSecrets` is how the tab says where the value is actually coming from.
   */
  siteUrl: string
  /** The address notifications are sent from (#207), or `''`. Same rule as `siteUrl`. */
  notifyFrom: string
  /** The inbox notifications go to (#207), or `''`. Same rule as `siteUrl`. */
  notifyTo: string
  /** The sender's display name (#208), or `''` for a bare address. Never had a secret. */
  notifyFromName: string
  /**
   * Which of these settings are still being served by the secret #207 deprecated.
   *
   * Setting *keys* — `site_url`, `notify_from`, `notify_to` — rather than secret names,
   * because what the owner acts on is the field. Empty on a deployment that never set
   * those secrets, which is every new one.
   */
  fromDeprecatedSecrets: string[]
}

/**
 * `GET /admin/api/settings` — the origin policy and the moderation policy.
 *
 * **`moderationPolicy` is validated rather than cast**, which is the second call in this
 * file to do so and for `readSetup`'s reason (#173). Every other malformed field here
 * shows itself: an allowlist that did not arrive renders as an empty allowlist, which an
 * owner can see is wrong. A missing policy would render as *hold-all is selected* — the
 * answer a fresh deployment gives, indistinguishable from the truth, telling an owner
 * their comments are being held when the field simply never came. So a settings body
 * without a policy this dashboard knows is a failure rather than a setting.
 * Enforced by test/dashboard/api.test.ts.
 */
export function readSettings(): Promise<ApiResult<Settings>> {
  return settingsRequest({ method: 'GET', path: '/settings' })
}

/**
 * One request to the settings endpoint, with its answer checked.
 *
 * Shared by the read and both writes, because a write's answer is rendered exactly like
 * a read's — the Setup tab takes the saved policy from it rather than from what it sent,
 * so that what the screen shows is what the server stored.
 */
async function settingsRequest(spec: RequestSpec): Promise<ApiResult<Settings>> {
  const result = await request<Settings>(spec)
  if (!result.ok) return result

  if (!MODERATION_POLICIES.includes(result.value.moderationPolicy)) {
    return { ok: false, failure: { code: 'MALFORMED', message: MALFORMED_MESSAGE, status: 200 } }
  }
  // **The four settings strings are checked for the same reason the policy is (#207).** A
  // missing one arrives as `undefined`, which renders as an empty field — *not set*, which
  // is indistinguishable from the truth and would have an owner retype configuration they
  // saved months ago, or worse, save an emptiness over a working address. The allowlist
  // above is the case that does not need this, because an allowlist that failed to arrive
  // renders as an empty list an owner can see is wrong.
  for (const field of ['siteUrl', 'notifyFrom', 'notifyTo', 'notifyFromName'] as const) {
    if (typeof result.value[field] !== 'string') {
      return { ok: false, failure: { code: 'MALFORMED', message: MALFORMED_MESSAGE, status: 200 } }
    }
  }
  if (!Array.isArray(result.value.fromDeprecatedSecrets)) {
    return { ok: false, failure: { code: 'MALFORMED', message: MALFORMED_MESSAGE, status: 200 } }
  }
  return result
}

/**
 * `PUT /admin/api/settings` — replace the allowlist.
 *
 * The whole list every time, because an owner has to be able to remove an origin and
 * an endpoint that only added could not de-list a staging domain. A rejected entry
 * comes back as a `BAD_REQUEST` naming which one it was, so the UI can show it rather
 * than asking the owner to check twenty addresses.
 */
export function writeAllowedOrigins(allowedOrigins: string[]): Promise<ApiResult<Settings>> {
  return settingsRequest({ method: 'PUT', path: '/settings', body: { allowedOrigins } })
}

/**
 * `PUT /admin/api/settings` — the moderation policy, and nothing else (#173).
 *
 * **The body carries only this field on purpose.** The endpoint leaves an absent field
 * alone, so the Setup tab's policy control cannot overwrite an allowlist edited in
 * another tab — and `writeAllowedOrigins` above cannot overwrite the policy for the same
 * reason. Sending the whole settings document from either surface would make whichever
 * one saved last quietly undo the other.
 *
 * An unknown value comes back as a `BAD_REQUEST` naming it rather than as a 200 that
 * stored the default, so a drift between this union and the Worker's is visible instead
 * of being a policy nobody chose.
 */
export function writeModerationPolicy(
  moderationPolicy: ModerationPolicy,
): Promise<ApiResult<Settings>> {
  return settingsRequest({ method: 'PUT', path: '/settings', body: { moderationPolicy } })
}

/**
 * `PUT /admin/api/settings` — the site's own address, and nothing else (#207).
 *
 * One field per writer, for the reason `writeModerationPolicy` gives: the endpoint leaves
 * an absent field alone, so a section saving its own control cannot overwrite one edited
 * in another tab. An empty string clears the row rather than being ignored — which on this
 * deployment is how an owner turns layer 8's permalink back off.
 */
export function writeSiteUrl(siteUrl: string): Promise<ApiResult<Settings>> {
  return settingsRequest({ method: 'PUT', path: '/settings', body: { siteUrl } })
}

/**
 * The settings whose value is still coming from the secret they replaced, as a set.
 *
 * A helper rather than a `.includes` at each call site, because the *reason* is the same
 * every time and is worth one place to state it: the dashboard renders no secret's value,
 * so a field for one of these is empty for a reason that has nothing to do with the owner
 * having cleared it (#158, #207).
 */
export function servedBySecret(settings: Settings, key: string): boolean {
  return settings.fromDeprecatedSecrets.includes(key)
}

/**
 * The three notification settings, saved together because one form holds them (#207, #208).
 *
 * **Every field is optional, and omitting one is not the same as sending it empty.** The
 * endpoint leaves an absent field alone and *clears* the row for an empty one — and
 * clearing is what stops a deployment still on the deprecated secrets from falling back to
 * them. So a field the owner never typed into has to be left out rather than sent blank.
 * See `NotifyFields` in src/dashboard/components/setup.tsx, which is where that decision is
 * made and where getting it wrong turned somebody's notifications off.
 */
export interface NotifySettingsInput {
  notifyFrom?: string
  notifyTo?: string
  notifyFromName?: string
}

/**
 * `PUT /admin/api/settings` — the notification addresses and the sender name.
 *
 * Three fields in one request because they are one form with one Save button: the two
 * addresses are useless apart, and a display name saved without the address it decorates
 * would be a half-save the owner watched succeed. Still not the whole settings document,
 * for `writeModerationPolicy`'s reason.
 *
 * A refused value comes back as a `BAD_REQUEST` naming the value and, for the sender name,
 * the character — so the UI shows the server's own sentence rather than restating rules
 * that could drift from the ones the Worker enforces.
 */
export function writeNotifySettings(input: NotifySettingsInput): Promise<ApiResult<Settings>> {
  return settingsRequest({ method: 'PUT', path: '/settings', body: input })
}

/**
 * The secrets the Setup tab reports on (#158), in the order it reports them.
 *
 * The same names `REPORTED_SECRETS` in src/admin/setup.ts answers for. They are
 * written out again rather than imported because that module is in the Worker's
 * TypeScript project — it names `Env` and imports Hono, neither of which exists in this
 * one (src/dashboard/tsconfig.json), the same reason `QueuedComment` is redeclared above.
 *
 * A drift between the two lists is therefore possible, and `readSetup` is what makes it
 * loud: a name this file expects and the server does not send comes back as a
 * `MALFORMED` failure the tab shows, rather than as a confident "not set" for a feature
 * that is on.
 * Enforced by test/dashboard/setup.test.tsx.
 */
export const SETUP_SECRETS = [
  'RESEND_API_KEY',
  'TURNSTILE_SECRET_KEY',
  'IP_HASH_SECRET',
  'AKISMET_API_KEY',
] as const

export type SetupSecret = (typeof SETUP_SECRETS)[number]

/**
 * Where the self-training spam classifier stands (#177), in the order the Worker decides
 * them.
 *
 * The same four `ClassifierState` answers `src/spam/status.ts` computes, written out again
 * for the reason `SETUP_SECRETS` is: that module reaches `src/db` and the generated `Env`,
 * neither of which exists in this TypeScript project.
 *
 * The drift a second copy allows is what `readSetup` makes loud — a state the Worker sends
 * and this list does not hold is a `MALFORMED` failure the tab shows, rather than a
 * section that renders as a heading with nothing under it.
 * Enforced by test/dashboard/setup.test.tsx.
 */
export const CLASSIFIER_STATES = ['no-binding', 'model-changed', 'learning', 'trained'] as const

export type ClassifierState = (typeof CLASSIFIER_STATES)[number]

/**
 * What the tab may say about layer 7: counts, the gate they are counted against, and when
 * the model last learned.
 *
 * **There is deliberately no score, accuracy or confidence on this type.** The layer's
 * threshold is provisional and uncalibrated (#175), so any such number would be
 * fabricated — and a percentage on a dashboard is believed. Adding one is a change to the
 * Worker's report, not a field this client can start rendering.
 */
export interface ClassifierStatus {
  state: ClassifierState
  hamCount: number
  spamCount: number
  /**
   * How many decisions in each class the layer needs before it says anything.
   *
   * Sent by the Worker rather than restated here, unlike `MIN_DASHBOARD_PASSWORD_LENGTH`
   * — which had to be written twice and pinned by test/node/password-floor.test.ts. A
   * number that ships with the counts it bounds has no second copy to drift.
   */
  minPerClass: number
  /** Unix seconds, or null on a deployment whose model has never been written. */
  updatedAt: number | null
}

/**
 * Which optional features have what they need — booleans, and never a value.
 *
 * `Record<SetupSecret, boolean>` rather than an interface for the reason `QueueCounts`
 * gives: a secret the tab renders a section for but never asks about does not typecheck,
 * instead of merely being unlikely.
 */
export interface SetupReport {
  secrets: Record<SetupSecret, boolean>
  /**
   * Whether the dashboard password is shorter than the floor (#120).
   *
   * Outside `secrets` because it is not a feature switch: the password is always set —
   * an unconfigured dashboard answers nothing at all — and the question is whether it
   * is long enough. A boolean like everything else here, and for the same reason: there
   * is no version of this screen that needs a length, a prefix or the value.
   */
  shortPassword: boolean
  /**
   * Where the spam classifier stands (#177).
   *
   * Outside `secrets` because it is not a secret and not a switch: layer 7 needs no
   * configuration at all, and what an owner cannot see is whether it is running, how far
   * from useful it is, and whether it quietly stopped learning.
   */
  classifier: ClassifierStatus
}

/**
 * `GET /admin/api/setup` — what is configured on this deployment.
 *
 * **The answer is validated rather than cast**, which no other call in this file does.
 * Everywhere else a malformed body produces a visible failure on its own: a queue with
 * no comments in it renders as an empty queue and the owner can see that is wrong. Here
 * the natural reading of a missing field is `undefined`, which renders as *not set* —
 * an answer indistinguishable from the real one, telling an owner to go and configure
 * something they configured months ago. So a report missing any expected boolean is a
 * failure, not a report.
 * Enforced by test/dashboard/setup.test.tsx.
 */
export async function readSetup(): Promise<ApiResult<SetupReport>> {
  const result = await request<unknown>({ method: 'GET', path: '/setup' })
  if (!result.ok) return result

  const body = result.value as {
    secrets?: unknown
    shortPassword?: unknown
    classifier?: unknown
  } | null
  const secrets = body?.secrets
  if (secrets === null || typeof secrets !== 'object') {
    return { ok: false, failure: { code: 'MALFORMED', message: MALFORMED_MESSAGE, status: 200 } }
  }
  for (const name of SETUP_SECRETS) {
    if (typeof (secrets as Record<string, unknown>)[name] !== 'boolean') {
      return { ok: false, failure: { code: 'MALFORMED', message: MALFORMED_MESSAGE, status: 200 } }
    }
  }
  // Validated like the rest, and it is the field that most needs it: a missing
  // `shortPassword` reads as `undefined`, which is falsy, which renders as *the password
  // is fine* — a reassurance nobody sent. #120.
  if (typeof body?.shortPassword !== 'boolean') {
    return { ok: false, failure: { code: 'MALFORMED', message: MALFORMED_MESSAGE, status: 200 } }
  }
  const classifier = readClassifier(body.classifier)
  if (classifier === null) {
    return { ok: false, failure: { code: 'MALFORMED', message: MALFORMED_MESSAGE, status: 200 } }
  }
  return {
    ok: true,
    value: {
      secrets: secrets as Record<SetupSecret, boolean>,
      shortPassword: body.shortPassword,
      classifier,
    },
  }
}

/**
 * The classifier report, or null when it is not one (#177).
 *
 * **Every field is checked, and a state this dashboard does not know is a refusal rather
 * than a fallback.** The states are written out twice — here and in src/spam/status.ts,
 * because the two TypeScript projects share nothing — so the drift is possible, and the
 * failure it would otherwise produce is silent: an unrecognised state renders as a
 * section heading with no words underneath it, which reads as a feature that has nothing
 * to report. `undefined` is worse still, because it renders as zeroes, which is a
 * confident "you have made no decisions" that nobody sent.
 * Enforced by test/dashboard/setup.test.tsx.
 */
function readClassifier(value: unknown): ClassifierStatus | null {
  if (value === null || typeof value !== 'object') return null

  const { state, hamCount, spamCount, minPerClass, updatedAt } = value as Record<string, unknown>
  if (!isClassifierState(state)) return null
  if (!isCount(hamCount) || !isCount(spamCount) || !isCount(minPerClass)) return null
  // **Checked as hard as the counts beside it, and the reason is a crash rather than a
  // wrong word.** This value reaches `isoInstant`, where `new Date(1e300).toISOString()`
  // throws a `RangeError` — and there is no error boundary anywhere in this dashboard, so
  // that would unmount the whole tree, on the screen an owner opened to find out what was
  // wrong. A unix instant is always a safe integer.
  if (updatedAt !== null && !isInstant(updatedAt)) return null

  return { state, hamCount, spamCount, minPerClass, updatedAt }
}

function isClassifierState(value: unknown): value is ClassifierState {
  return CLASSIFIER_STATES.includes(value as ClassifierState)
}

/**
 * A number this screen can put in a sentence: a whole count, never negative.
 *
 * Stricter than the column it comes from needs to be, and deliberately so — `spam_model`
 * is `CHECK (ham_count >= 0)` and integer, so anything else did not come from the model.
 * The cost of being loose is copy that reads "-4 more comments you approve" or "NaN", on
 * the one screen an owner opened to find out what is happening.
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** A unix instant this screen can hand to `new Date`, which is always a safe integer. */
function isInstant(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
