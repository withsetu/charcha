// The shape of every dashboard response, in one place.
//
// JSON here, unlike the public routes, and that is not a breach of the
// HTML-not-JSON rule (#4). That rule protects the single comment *renderer* — one
// pure function, reused by the v1.1 server-rendering paths — from being written
// twice. The queue is not rendered comments: it carries moderation metadata the
// renderer does not emit and must not (status, page key, spam reason, cursor), and
// it goes to a React client rather than to `innerHTML`. Nothing here renders a
// comment for a reader.
//
// One error shape for every failure, because the client branches on `code` and a
// second shape means a client that handles one of them (api-and-interface-design).
// `cache-control: no-store` on everything, because every one of these responses is
// either about a credential or is one owner's private view of unpublished comments.
// Enforced by test/worker/admin/route.test.ts.

const JSON_TYPE = 'application/json; charset=utf-8'

/** The machine-readable half of an error. Stable — the dashboard branches on it. */
export type AdminErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'TOO_MANY_REQUESTS'
  | 'UNAVAILABLE'

/**
 * A dashboard response.
 *
 * Built here rather than with Hono's `c.json` so that the headers cannot drift per
 * endpoint: there is exactly one place `no-store` is set, and exactly one place
 * that could ever gain a CORS header — which it must never do. Admin routes emit no
 * `Access-Control-Allow-Origin` under any circumstances: there is no legitimate
 * cross-origin caller, and one would be a page in another tab reading this owner's
 * moderation queue.
 * Enforced by test/worker/admin/route.test.ts.
 */
export function adminJson(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': JSON_TYPE, 'cache-control': 'no-store', ...headers },
  })
}

/** No body at all, for the two endpoints whose answer is "done". */
export function adminNoContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', ...headers } })
}

/**
 * The one error shape.
 *
 * The message is for a human reading a network tab, and is deliberately incurious:
 * nothing here distinguishes "no dashboard password is configured" from "that
 * password is wrong", or "comment 412 is not yours" from "comment 412 does not
 * exist". The configuration case goes to a server log instead (announceOnce), which
 * the owner can read and an attacker cannot.
 * Enforced by test/worker/admin/route.test.ts.
 */
export function adminError(code: AdminErrorCode, message: string, status: number): Response {
  return adminJson({ error: { code, message } }, status)
}

export const unauthorized = () => adminError('UNAUTHORIZED', 'Sign in to use the dashboard.', 401)

export const forbidden = () =>
  adminError('FORBIDDEN', 'That request did not come from this dashboard.', 403)

export const badRequest = (message: string) => adminError('BAD_REQUEST', message, 400)

export const notFound = (message: string) => adminError('NOT_FOUND', message, 404)

/**
 * The size guard's refusal, in this surface's shape.
 *
 * src/request-body.ts answers plain text, which is right for the public routes and
 * wrong here — a dashboard that gets one JSON shape for every other failure and a
 * bare sentence for this one has to special-case exactly the response it is least
 * likely to have tested. The status stays 413, because that is the one thing the
 * client can act on.
 */
export const tooLarge = () => adminError('TOO_LARGE', 'That request was too large.', 413)

export const tooManyRequests = () =>
  adminError('TOO_MANY_REQUESTS', 'Too many attempts. Wait a minute and try again.', 429)

export const unavailable = () =>
  adminError('UNAVAILABLE', 'The dashboard is not available on this deployment.', 503)
