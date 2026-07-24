// The comment renderer: one pure function from rows to an HTML string.
//
// It is called from three places over this project's life — the embed endpoint,
// the HTMLRewriter injection path and the build-time API (#1) — which is why it
// takes rows and returns a string rather than being an endpoint. Nothing here
// reads the clock, the network or a global: the same rows render to the same
// string everywhere, so the output is cacheable and snapshot-testable.
//
// Its input is RenderableComment, which the data layer builds without ever
// selecting author_email or ip_hash. Neither is available to be leaked here.

import type { RenderableComment } from '../db'
import { escapeHtml } from './escape'
import { renderMarkdown } from './markdown'

/**
 * Every class name this renderer emits.
 *
 * Bare mode ships in v1 (#6), so these are a public API from the day this lands:
 * a site's own stylesheet targets them directly, and renaming one is a breaking
 * change for every deployment that styled it. The `charcha-` prefix is what
 * keeps them from colliding with the host page's own classes.
 * Enforced by test/worker/render/comments.test.ts.
 */
export const COMMENT_CLASS_NAMES = [
  'charcha-comments',
  'charcha-comment',
  'charcha-comment-by-owner',
  'charcha-comment-header',
  'charcha-comment-author',
  'charcha-comment-time',
  'charcha-comment-body',
  'charcha-replies',
  'charcha-reply',
] as const

/**
 * Date's own range, converted to the unix seconds this project stores. Past it,
 * `toISOString` throws — and a renderer that throws on one bad row takes the
 * whole page down with it.
 */
const MAX_TIMESTAMP_SECONDS = 8_640_000_000_000

/**
 * The timestamp, machine-readable, from the row rather than from a clock.
 *
 * The text is the UTC date rather than "2 hours ago": relative time needs a
 * "now", and a renderer that read one would produce different HTML on every
 * call and could not be cached or server-rendered. The `datetime` attribute is
 * what lets the embed rewrite it in the reader's own locale later.
 */
function renderTime(createdAt: number): string {
  if (!Number.isFinite(createdAt) || Math.abs(createdAt) > MAX_TIMESTAMP_SECONDS) return ''

  const iso = new Date(createdAt * 1000).toISOString()
  return `<time class="charcha-comment-time" datetime="${iso}">${iso.slice(0, 10)}</time>`
}

function renderComment(
  comment: RenderableComment,
  replies: readonly RenderableComment[],
  isReply: boolean,
): string {
  const classes =
    'charcha-comment' +
    (isReply ? ' charcha-reply' : '') +
    (comment.byOwner ? ' charcha-comment-by-owner' : '')

  // The id is escaped rather than trusted to be the integer its type promises.
  // The v1.1 build-time API hands this function rows from a site generator, not
  // from this project's data layer, and an attribute built from an unchecked
  // value is the same hole whichever caller opens it.
  const parts = [
    `<li class="${classes}" id="charcha-comment-${escapeHtml(String(comment.id))}">`,
    '<div class="charcha-comment-header">',
    `<span class="charcha-comment-author">${escapeHtml(comment.authorName)}</span>`,
    renderTime(comment.createdAt),
    '</div>',
    `<div class="charcha-comment-body">${renderMarkdown(comment.body)}</div>`,
  ]

  if (replies.length > 0) {
    parts.push('<ol class="charcha-replies">')
    for (const reply of replies) parts.push(renderComment(reply, [], true))
    parts.push('</ol>')
  }

  parts.push('</li>')
  return parts.join('')
}

/**
 * Renders a page's comments as an HTML string: an ordered list of roots, each
 * with its replies nested one level below it.
 *
 * The rows arrive flat and in the order the data layer returned them — oldest
 * first — and that order is preserved. Threading stops at two levels because the
 * database does (migrations/0001_initial.sql), and a reply whose parent is not a
 * root on this page is dropped rather than promoted: the page read already hides
 * a reply whose parent was not approved, so one arriving here without its parent
 * would be an answer to a comment the moderator took down, published next to a
 * comment it was never replying to.
 *
 * A page with no comments renders as an empty container. Wording an empty state
 * is a design decision that belongs to the embed and the theming contract
 * (#5, #6); making it here would make it once, in one language, for every site.
 *
 * One pass to group, one pass to render — no work that grows faster than the
 * number of comments, because the page read is not yet capped (#27).
 * Enforced by test/worker/render/comments.test.ts.
 */
export function renderComments(comments: readonly RenderableComment[]): string {
  const roots: RenderableComment[] = []
  const repliesByParent = new Map<number, RenderableComment[]>()

  for (const comment of comments) {
    // A missing parent id reads as a root, not as a reply to nothing. The data
    // layer always sends null, but the v1.1 build-time API takes rows from a
    // site generator — and there, treating an absent field as a reply would
    // silently drop the comment instead of publishing it.
    if (comment.parentId === null || comment.parentId === undefined) {
      roots.push(comment)
      continue
    }

    const siblings = repliesByParent.get(comment.parentId)
    if (siblings === undefined) repliesByParent.set(comment.parentId, [comment])
    else siblings.push(comment)
  }

  const out = ['<ol class="charcha-comments">']
  for (const root of roots) {
    out.push(renderComment(root, repliesByParent.get(root.id) ?? [], false))
  }
  out.push('</ol>')

  return out.join('')
}
