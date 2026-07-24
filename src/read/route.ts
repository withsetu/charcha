// The HTTP boundary for GET /comments — the read half of the embed's contract.
// Designed on issue #46.
//
// It owns three things: turning the reported page address into a thread key at the
// trust boundary, choosing how long the answer may be reused, and mapping the
// result onto a response. The data layer owns the query and its cap (#27), the
// renderer owns the markup, and src/cors.ts owns the origin policy (#47).
//
// **HTML, not JSON.** The body is exactly what renderComments produces, which is
// what the POST returns too and what the v1.1 server-rendering paths will emit — one
// renderer, called from three places. The embed is `fetch` + `innerHTML`, and that
// is most of how the 10 KB budget is met (#1, #4).
// Enforced by test/worker/read/route.test.ts.

import type { Context } from 'hono'
import { listPageComments } from '../db'
import { derivePageKey, messageForPageKeyRejection } from '../page-key'
import { renderComments } from '../render'
import type { CommentStrings } from '../render'
import { corsHeaders, resolveOrigin } from '../cors'

const TEXT = 'text/plain; charset=utf-8'
const HTML = 'text/html; charset=utf-8'

/**
 * How long a reader's own browser may reuse a page's comments.
 *
 * This is the only cache that helps the constraint that actually binds. Cloudflare
 * bills a cache hit as a Worker request — "requests served from the Worker's cache
 * are billed at the same per-request rate as requests that invoke the Worker"
 * (https://developers.cloudflare.com/workers/platform/pricing/) — so edge caching
 * buys D1 row reads and CPU, and buys nothing at all against the free tier's
 * 100,000 requests/day. Only a request the browser never makes does that.
 *
 * A minute is chosen against the failure it causes rather than the traffic it
 * saves: the staleness window is how long after the owner approves a comment a
 * reader who reloads may still not see it, and a minute is under the span in which
 * a person retries and concludes something is broken. It needs no invalidation
 * machinery, which is the point — expiry *is* the invalidation here, because the
 * Cache API is per-datacenter and `cache.delete` "removes a stored response only in
 * the cache of the data center that the Worker handling the request is in"
 * (https://developers.cloudflare.com/workers/reference/how-the-cache-works/), so a
 * purge on approval would clear one colo of hundreds and read as correct.
 *
 * Neither `stale-while-revalidate` nor an `ETag` appears for the same reason: the
 * revalidation is itself a billable request, so both trade the one budget that
 * binds for latency this endpoint does not need.
 * Enforced by test/worker/read/route.test.ts.
 */
export const READ_CACHE_MAX_AGE_SECONDS = 60

/**
 * `private`, and never `public`, and that is a correctness requirement rather than
 * caution.
 *
 * The response carries an `Access-Control-Allow-Origin` naming one specific origin,
 * so it is only correct for the origin that asked. Cloudflare's cache does not act
 * on `Vary` by default — "vary values are respected [...] when the vary header is
 * vary: accept-encoding"
 * (https://developers.cloudflare.com/cache/concepts/vary/) — so a shared cache
 * would hand one site's allow-origin header, or a crawler's header-less answer, to
 * the next reader on a different origin and break the embed there. `Vary: Origin`
 * is still sent, for every cache that does honour it.
 */
const READ_CACHE_CONTROL = `private, max-age=${READ_CACHE_MAX_AGE_SECONDS}`

export interface ReadRouteConfig {
  /**
   * Query parameters that are page identity on this site. It must be the same list
   * the submission path uses, or a reader posts to one thread and is then shown
   * another — see src/page-key.ts. Both routes take it from the same place in
   * src/index.ts for that reason.
   */
  significantParams?: readonly string[]
  strings?: CommentStrings
}

function rejected(message: string, allowedOrigin: string | null): Response {
  return new Response(message, {
    status: 400,
    headers: {
      ...corsHeaders(allowedOrigin),
      'content-type': TEXT,
      // Never cached. A refusal is about the request, and the reader's next attempt
      // is a different one — a cached 400 would outlive the typo that caused it.
      'cache-control': 'no-store',
    },
  })
}

/**
 * Answers a page's comments as HTML.
 *
 * Page identity arrives as query parameters, `url` and `thread`, named for the same
 * fields the POST body uses. It is a query string rather than a body because a GET
 * is what a cache and a crawler understand, and the reported address has to be part
 * of the cache key to be cacheable at all. The address is the page's, not the
 * reader's — the site owner's own analytics already hold it — but it is still
 * untrusted: it is length-capped and re-parsed by derivePageKey, which is also the
 * only thing that produces a `page_key`. **A key is never accepted over the wire.**
 *
 * An unknown page renders empty, never 404: a page nobody has commented on is
 * indistinguishable from one with no comments, and a 404 would put an error on
 * every quiet page of the site. Nothing here writes — no thread row is created by
 * reading, because reads outnumber writes 50 to 1 in the free tier and traffic must
 * never be able to spend the day's comment budget.
 */
export async function handleRead(
  c: Context<{ Bindings: Env }>,
  config: ReadRouteConfig = {},
): Promise<Response> {
  // The read withholds the header from an unlisted origin but still answers, unlike
  // the write, which refuses outright. The asymmetry is the point: this has no side
  // effect and its HTML is public to anything that can make a request, so refusing
  // would break the v1.1 server-rendering paths and stop no attack. See src/cors.ts.
  const { allowedOrigin } = await resolveOrigin(c.env.DB, c.req.raw)

  // The size caps and the parsing both belong to derivePageKey, which the
  // submission path uses too — one implementation of the trust boundary, so the two
  // cannot disagree about which URLs are acceptable or which key they produce.
  const key = derivePageKey({
    url: c.req.query('url') ?? null,
    thread: c.req.query('thread') ?? null,
    significantParams: config.significantParams,
  })
  if (!key.ok) return rejected(messageForPageKeyRejection(key.reason), allowedOrigin)

  const page = await listPageComments(c.env.DB, key.pageKey)
  const html = renderComments(page.comments, config.strings, { truncated: page.truncated })

  return new Response(html, {
    status: 200,
    headers: {
      ...corsHeaders(allowedOrigin),
      'content-type': HTML,
      'cache-control': READ_CACHE_CONTROL,
    },
  })
}
