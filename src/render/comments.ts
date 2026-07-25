// The comment renderer: one pure function from rows to an HTML string.
//
// It is called from three places over this project's life — the embed endpoint,
// the HTMLRewriter injection path and the build-time API (#1) — which is why it
// takes rows and returns a string rather than being an endpoint. Nothing here
// reads the clock, the network or a global: the same rows render to the same
// string everywhere, so the output is cacheable and snapshot-testable.
//
// Its input is RenderableComment, declared below rather than imported from the
// data layer. The renderer is the general half of that pair — D1 is one source of
// rows, and the v1.1 build-time path takes them from a site generator instead — so
// the shape belongs to the consumer and src/db conforms to it. That direction is
// also what makes this module importable from a program without Cloudflare's
// ambient types, which is how test/dom/embed/mount.test.ts builds its fixtures out
// of the real renderer instead of beside it (#94).

import { escapeHtml } from './escape'
import { renderMarkdown } from './markdown'
import type { CommentStrings } from './strings'
import { ENGLISH_STRINGS } from './strings'

/**
 * A comment as the renderer receives it — the whole of what a caller supplies.
 *
 * There is no `authorEmail` and no `ipHash`, and the absence is the guard: a
 * field this type does not carry is a field no template mistake below can put on
 * a page. The data layer holds the other end, selecting neither column on the
 * read that fills this — test/worker/db/comments.test.ts is what enforces that.
 */
export interface RenderableComment {
  id: number
  parentId: number | null
  depth: number
  authorName: string
  body: string
  byOwner: boolean
  createdAt: number
}

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
  'charcha-empty',
  'charcha-truncated',
] as const

/**
 * Every element this file can emit, alongside the ones renderMarkdown produces.
 *
 * Same contract as MARKDOWN_ELEMENTS: adding an element to the markup without
 * adding it here fails test/worker/render/vocabulary.test.ts, which asserts that
 * nothing outside the two lists ever reaches the page — whatever the input.
 *
 * `p` appears in both lists on purpose. The empty state emits one from this
 * file, and the vocabulary test unions the two lists — so leaving it out here
 * would still pass while making this comment untrue, which is the worse of the
 * two failures.
 */
export const COMMENT_ELEMENTS = ['ol', 'li', 'div', 'span', 'time', 'p'] as const

/**
 * What the caller knows about the rows it is handing over that the rows themselves
 * cannot say. An options object rather than a positional flag, so the next such
 * fact is an added key rather than a fourth argument nobody can read at a call site.
 */
export interface RenderOptions {
  /**
   * The page has approved comments these rows do not include, because the read was
   * capped (src/db/index.ts, MAX_PAGE_COMMENTS). Defaults to false: a caller that
   * does not know has, by construction, not truncated anything.
   */
  truncated?: boolean
}

/**
 * Date's own range, converted to the unix seconds this project stores. Past it,
 * `toISOString` throws — and a renderer that throws on one bad row takes the
 * whole page down with it.
 */
const MAX_TIMESTAMP_SECONDS = 8_640_000_000_000

/**
 * The ordinary shape of an ISO instant, `YYYY-MM-DDTHH:mm:ss.sssZ`.
 *
 * Outside four-digit years `toISOString` returns the expanded form —
 * `+275760-09-13T00:00:00.000Z` — and reading a date and a time out of that by
 * position produces `+275760-09 3T00:`, which is not a date and does not look
 * like a bug to anyone reading the page. A shape this narrow is what makes the
 * slicing below safe to do by position at all.
 * Enforced by test/worker/render/comments.test.ts.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * The timestamp: the date and the time, from the row rather than from a clock.
 *
 * The visible text says **UTC**, out loud, because this function cannot know the
 * reader's timezone. It has no clock and no locale — that is what makes it
 * reusable from the Worker, the HTMLRewriter path and a site's build — so an
 * unlabelled "19:46" would be a number that is hours away from the reader's wall
 * clock while looking exactly like it is not. The label is part of the rendered
 * text rather than a `title` tooltip for the same reason: a reader who is not
 * already suspicious never hovers.
 *
 * The `datetime` attribute keeps full precision on purpose. It is intended to be
 * the hook a later client-side upgrade reads — the reader's own timezone, or the
 * relative time the owner has approved as an opt-in — so it stays exact even
 * though the text beside it is rounded to the minute.
 */
function renderTime(createdAt: number): string {
  if (!Number.isFinite(createdAt) || Math.abs(createdAt) > MAX_TIMESTAMP_SECONDS) return ''

  // Two guards, catching different things: the range check is what stops
  // toISOString throwing, and the shape check is what stops it returning a form
  // these slices cannot read.
  const iso = new Date(createdAt * 1000).toISOString()
  if (!ISO_INSTANT.test(iso)) return ''

  const shown = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
  return `<time class="charcha-comment-time" datetime="${iso}">${shown}</time>`
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
 * A page with nothing to show renders the invitation instead of an empty list —
 * an empty `<ol>` is markup describing a list that is not there, and a reader
 * sees nothing at all. Its words come from `strings`, which defaults to English;
 * they are the only prose this renderer produces, and they do not live at this
 * call site so that a second language is a table rather than a rewrite.
 *
 * `strings` is a parameter and not a module-level setting, because this function
 * is pure and has to stay that way: the v1.1 paths call it from a build and from
 * a streaming rewriter, and a renderer reading hidden state renders differently
 * depending on who called it last.
 *
 * `options.truncated` is told to this function rather than guessed inside it,
 * because the row count alone cannot distinguish a page that exactly fills the cap
 * from one that overflows it — only the read that asked for a row past the cap
 * knows (src/db/index.ts). A cut-short conversation says so out loud: the reader
 * would otherwise be shown a beginning presented as the whole thing.
 *
 * One pass to group, one pass to render — no work that grows faster than the
 * number of comments, which the page read caps at MAX_PAGE_COMMENTS (#27).
 * Enforced by test/worker/render/comments.test.ts.
 */
export function renderComments(
  comments: readonly RenderableComment[],
  strings: CommentStrings = ENGLISH_STRINGS,
  options: RenderOptions = {},
): string {
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

  // Empty when nothing survived grouping, not only when nothing arrived: a page
  // of orphaned replies has no conversation to show either.
  if (roots.length === 0) {
    return `<p class="charcha-empty">${escapeHtml(strings.emptyState)}</p>`
  }

  const out = ['<ol class="charcha-comments">']
  for (const root of roots) {
    out.push(renderComment(root, repliesByParent.get(root.id) ?? [], false))
  }
  out.push('</ol>')

  // Below the list rather than above it: the notice is about what the reader has
  // just reached the end of, and a banner over an otherwise ordinary page reads as
  // an error. The count is the number of comments handed to this function, not the
  // number of roots, so it matches what the caller's cap actually returned.
  if (options.truncated === true) {
    out.push(
      `<p class="charcha-truncated">${escapeHtml(strings.truncatedNotice(comments.length))}</p>`,
    )
  }

  return out.join('')
}
