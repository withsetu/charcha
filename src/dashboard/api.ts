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
  /** Why a spam layer held this comment, or null when none did (#70). */
  spamReason: string | null
}

export interface QueuePage {
  comments: QueuedComment[]
  nextCursor: string | null
}

export interface SessionState {
  authenticated: true
  via: string
}

export interface DecisionResult {
  id: number
  status: string
  moderatedAt: number | null
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
  method: 'GET' | 'POST' | 'DELETE'
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
