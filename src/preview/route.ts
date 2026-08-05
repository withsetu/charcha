// The composer's Preview tab, server side. Designed on issue #78.
//
// The embed has no Markdown parser and never will: one is 10–40 KB against a
// 10 KB budget for the whole widget (#5), and a second implementation of the
// renderer disagrees with the first exactly when it matters, which is after the
// reader has posted. So Preview does what Post does — it asks the Worker, and the
// answer comes from the one renderer in src/render (#1, #4).
//
// **It renders and nothing else.** No thread row, no comment row, no moderation
// entry, no spam-layer call. The only database access on this path is the origin
// allowlist, and only when an `Origin` header made that policy applicable — see
// the query-count assertions in test/worker/preview/route.test.ts.
//
// **It is not a second boundary.** The size cap is src/request-body.ts, shared
// with the write, and the body rule is `commentBodySchema` from
// src/submit/schema.ts, which is the very field the write validates. A preview
// that accepted more than the write does would not be a preview; it would be a
// renderer to abuse (card rule 5).
// Enforced by test/worker/preview/route.test.ts.

import type { Context } from 'hono'
import {
  corsHeaders,
  isUnlistedBrowserOrigin,
  resolveOrigin,
  unlistedOriginResponse,
  withCors,
} from '../cors'
import { renderMarkdown } from '../render'
import { withFragmentHeaders } from '../response-headers'
import { readCappedText } from '../request-body'
import { parseCommentBody } from '../submit/schema'

/**
 * Where the preview lives, and the constant both the route table and the tests
 * take it from.
 *
 * Under `/comments` rather than at the top level, because it is an operation on
 * the comment the reader is writing and belongs beside the two halves of the same
 * public contract — leaving the Worker's top-level namespace to the surfaces that
 * are not the embed's (`/health`, and the dashboard). It is also its own path
 * rather than a query parameter on `POST /comments`, so that a deployment can
 * scope an edge rate-limiting rule to it: a Cloudflare Free-plan rate limiting
 * rule can match on Path, and on nothing more specific
 * (https://developers.cloudflare.com/waf/rate-limiting-rules/, verified 2026-07-25).
 */
export const PREVIEW_PATH = '/comments/preview'

const TEXT = 'text/plain; charset=utf-8'
const HTML = 'text/html; charset=utf-8'

/**
 * The reader's own unsaved draft, so nothing may keep a copy of it: not the
 * browser, not a proxy, not Cloudflare's cache. `no-store` rather than `no-cache`
 * — the latter permits storing and only requires revalidation.
 */
const NEVER_STORED = 'no-store'

function rejected(message: string, allowedOrigin: string | null): Response {
  return new Response(message, {
    status: 400,
    headers: { ...corsHeaders(allowedOrigin), 'content-type': TEXT, 'cache-control': NEVER_STORED },
  })
}

/**
 * Renders one Markdown draft as the HTML the published comment will carry.
 *
 * **Request.** `POST`, with the draft as the raw body. A plain string rather than
 * a JSON envelope over one field: the endpoint has exactly one input and it is
 * text, so an envelope would put `JSON.parse` on the untrusted path for nothing,
 * and a body sent as `text/plain` is a CORS-simple request that no browser
 * preflights — one billable Worker request per preview instead of two, against
 * the 100,000/day that bounds the free tier (verified 2026-07-25,
 * https://developers.cloudflare.com/workers/platform/limits/). The content type is
 * not checked, because checking it would guard nothing: an attacker picks their
 * own, which is exactly why the origin check below is on the real request.
 *
 * **Response.** The HTML `renderMarkdown` produced — precisely the string that
 * goes inside `charcha-comment-body` on the published path, and nothing wrapped
 * around it. The wrapper is the embed's, so that the class name has one emitter
 * (src/render/comments.ts) rather than two that can drift.
 *
 * **Statuses**, sharing the taxonomy the write already established so the embed
 * can branch on the status alone: 200 rendered, 400 the reader's draft (empty, or
 * past the 10,000-character cap — in the write's own words), 413 the raw body past
 * MAX_BODY_BYTES, 403 a browser origin the owner never listed.
 *
 * **The origin allowlist is enforced, not merely advertised** — the write's
 * behaviour, not the read's. The read answers everyone and only withholds the
 * header, because its HTML is public to anything that can make a request and
 * because the v1.1 server-rendering paths need it. Neither reason carries here:
 * this output is a pure function of the caller's own input, so refusing discloses
 * nothing and denies the caller nothing they had, and the v1.1 paths call
 * `renderMarkdown` as a function rather than over HTTP. A caller with no `Origin`
 * at all is still answered — refusing it would stop no attack, since anything that
 * can omit the header was never subject to CORS, and would break the owner driving
 * their own deployment with curl.
 */
export async function handlePreview(c: Context<{ Bindings: Env }>): Promise<Response> {
  // One wrap point rather than a spread at each return (#98). POST-only is not the
  // same as unnavigable — a cross-site `<form enctype="text/plain">` navigates a
  // victim's browser here with a body of the attacker's choosing — so the headers
  // that keep this from becoming a document cover every exit, including the 413 the
  // shared size cap builds in src/request-body.ts.
  // Enforced by test/worker/response-headers.test.ts.
  return withFragmentHeaders(await previewAnswer(c))
}

async function previewAnswer(c: Context<{ Bindings: Env }>): Promise<Response> {
  const decision = await resolveOrigin(c.env.DB, c.req.raw, readDeclaredOrigins)
  if (isUnlistedBrowserOrigin(decision)) return unlistedOriginResponse()

  const read = await readCappedText(c.req.raw)
  if (!read.ok) return withCors(read.response, decision.allowedOrigin)

  const draft = parseCommentBody(read.text)
  if (!draft.ok) return rejected(draft.message, decision.allowedOrigin)

  return new Response(renderMarkdown(draft.value), {
    status: 200,
    headers: {
      ...corsHeaders(decision.allowedOrigin),
      'content-type': HTML,
      'cache-control': NEVER_STORED,
    },
  })
}
