// Layer 5 — content heuristics. Last of the free local layers, and the one whose
// judgements are the least certain, which is why most of them are `review`.
//
// The order inside the layer is the order of the whole pipeline in miniature: the
// two checks that are string work run before the one that costs a database read,
// and a body too short for the duplicate rule to mean anything costs no read at all.
// Enforced by test/worker/spam/content.test.ts.

import { hasDuplicateBodyOnPage } from '../db'
import { computeBodyHash } from '../submit/hash'
import type { SpamCheckContext } from '../submit/spam'
import type { LayerOutcome, SpamLayer } from './layer'

/**
 * Links at which a comment is held for the human gate.
 *
 * Three is where a comment stops looking like a person citing something. It is a
 * `review` and not a `reject` because a researcher pasting five references and a
 * low-effort spammer are genuinely indistinguishable from a link count, and the
 * moderation queue exists for exactly that.
 */
export const LINKS_REVIEW_AT = 3

/**
 * Links at which a comment is refused outright — but only together with
 * LINK_FLOOD_MAX_PROSE below.
 *
 * "At ten the body is a link list" is a claim about the *ratio*, not the count. A
 * nine-thousand-character technical answer with ten citations is a link count of
 * ten and is also the best comment the site will get that week. Rejecting on the
 * count alone would lose it to a generic 403.
 */
export const LINKS_REJECT_AT = 10

/**
 * How much text can be left, once the links are removed, for a link-heavy comment
 * still to be refused outright rather than held for review.
 *
 * This is the half of the rule that makes "a link list, not a comment" checkable:
 * ten links wrapped around two hundred characters of prose is a link dump; ten
 * links inside a long argument is a person citing their sources.
 */
export const LINK_FLOOD_MAX_PROSE = 400

/**
 * How long a body must be before an exact duplicate means anything.
 *
 * Short comments collide honestly — two readers both writing "Thanks, this
 * helped." on the same post is a coincidence, and rejecting the second one loses
 * a real comment for nothing. Past sixty characters an exact match is not a
 * coincidence.
 */
export const DUPLICATE_MIN_LENGTH = 60

/**
 * How far back the duplicate rule looks. One hour.
 *
 * Bounded rather than "ever", because "ever" is a different and much worse rule
 * than it reads as. Comments are soft-deleted, so a body a moderator removed
 * would block that text on that page forever, invisibly, for everyone including
 * the person who wrote it. An hour still catches the two cases the rule is for —
 * a double-clicked Post button, and a blast of the same body at one page.
 */
export const DUPLICATE_WINDOW_SECONDS = 3_600

/**
 * Only a scheme or a `www.` prefix counts as a link.
 *
 * Deliberately not bare dotted words: `src/render/markdown.ts` makes an anchor
 * only out of `[text](https://url)` and never autolinks, so `node.js`,
 * `index.ts` and `README.md` are prose — and a counter that thought otherwise
 * would hold half of every programming blog for review.
 */
const LINK = /(?:https?:\/\/|www\.)[^\s<>()[\]]+/gi

/**
 * BBCode link markup. It is not Markdown and this renderer will never turn it
 * into a link, so it is forum-spam boilerplate fired at every form on the
 * internet — but it is **held for review, not rejected**, because
 * `src/render/markdown.ts` renders fenced code blocks and someone quoting spam
 * or discussing phpBB writes it honestly.
 *
 * Only the `[url=…` and `[/url]` forms, never a bare `[url]`: `[url](https://x)`
 * and `[link](https://x)` are ordinary Markdown links that a real person writes,
 * and matching those would flag them.
 */
const BBCODE_LINK = /\[(?:url|link)\s*=|\[\/(?:url|link)\]/i

/** Exported so the counting rule is testable on its own, not only through a verdict. */
export function countLinks(body: string): number {
  return body.match(LINK)?.length ?? 0
}

/**
 * How much of the body is left once the links are taken out of it. The measure
 * behind "a link list, not a comment" — see LINK_FLOOD_MAX_PROSE.
 */
export function proseLength(body: string): number {
  return body.replace(LINK, ' ').trim().length
}

function linkOutcome(body: string, reviewAt: number, rejectAt: number): LayerOutcome {
  const links = countLinks(body)
  if (links < reviewAt) return null
  if (links >= rejectAt && proseLength(body) <= LINK_FLOOD_MAX_PROSE) {
    return { action: 'reject', reason: 'link-flood' }
  }
  return { action: 'review', reason: 'many-links' }
}

export interface ContentConfig {
  linksReviewAt?: number
  linksRejectAt?: number
  duplicateMinLength?: number
  duplicateWindowSeconds?: number
}

export function contentLayer(config: ContentConfig = {}): SpamLayer {
  const reviewAt = config.linksReviewAt ?? LINKS_REVIEW_AT
  const rejectAt = config.linksRejectAt ?? LINKS_REJECT_AT
  const duplicateMinLength = config.duplicateMinLength ?? DUPLICATE_MIN_LENGTH
  const duplicateWindow = config.duplicateWindowSeconds ?? DUPLICATE_WINDOW_SECONDS

  return {
    name: 'content',
    async run(context: SpamCheckContext): Promise<LayerOutcome> {
      const body = context.comment.body

      // Held, not rejected. `src/render/markdown.ts` renders fenced code blocks,
      // so a reader quoting the spam they received, or a comment on a thread
      // about migrating off phpBB, produces this markup honestly. It is still a
      // strong enough signal to be worth a human's glance.
      const held: LayerOutcome = BBCODE_LINK.test(body)
        ? { action: 'review', reason: 'bbcode-link' }
        : linkOutcome(body, reviewAt, rejectAt)
      if (held?.action === 'reject') return held

      // The duplicate read still happens when a review is already held, because a
      // duplicate is a reject and a reject outranks it — short-circuiting on the
      // weaker answer would let a spammer downgrade their own verdict by adding a
      // third link to a body they had already posted.
      if (body.length >= duplicateMinLength) {
        const bodyHash = await computeBodyHash(body)
        // Same thread and inside the window: `comments_by_body` is
        // (thread_id, body_hash), so this is one indexed seek. Asking across
        // every thread would be a table scan on the busiest write path.
        const duplicate = await hasDuplicateBodyOnPage(
          context.db,
          context.pageKey,
          bodyHash,
          context.now - duplicateWindow,
        )
        // Reject rather than review, and the honest version of why: within the
        // hour this exact body was already submitted to this page, so admitting a
        // second copy buys a row write and no new writing. It is not a claim that
        // the first copy is still visible — it may since have been marked spam or
        // deleted — so the window is what keeps a moderator's takedown from
        // silently banning that text forever.
        if (duplicate) return { action: 'reject', reason: 'duplicate-body' }
      }

      return held
    },
  }
}
