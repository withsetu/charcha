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
 * Links at which a comment is refused outright. At ten the body is a link list,
 * not a comment, and no reading of it is charitable.
 */
export const LINKS_REJECT_AT = 10

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
 * Only a scheme or a `www.` prefix counts as a link.
 *
 * Deliberately not bare dotted words: `src/render/markdown.ts` makes an anchor
 * only out of `[text](https://url)` and never autolinks, so `node.js`,
 * `index.ts` and `README.md` are prose — and a counter that thought otherwise
 * would hold half of every programming blog for review.
 */
const LINK = /(?:https?:\/\/|www\.)[^\s<>()[\]]+/gi

/**
 * BBCode link markup. It is not Markdown, this renderer will never turn it into a
 * link, and no person writing a comment produces it — it is forum-spam boilerplate
 * fired at every form on the internet. Reject rather than review.
 *
 * Only the `[url=…` and `[/url]` forms, never a bare `[url]`: `[url](https://x)`
 * and `[link](https://x)` are ordinary Markdown links that a real person writes,
 * and matching those would reject them.
 */
const BBCODE_LINK = /\[(?:url|link)\s*=|\[\/(?:url|link)\]/i

/** Exported so the counting rule is testable on its own, not only through a verdict. */
export function countLinks(body: string): number {
  return body.match(LINK)?.length ?? 0
}

export interface ContentConfig {
  linksReviewAt?: number
  linksRejectAt?: number
  duplicateMinLength?: number
}

export function contentLayer(config: ContentConfig = {}): SpamLayer {
  const reviewAt = config.linksReviewAt ?? LINKS_REVIEW_AT
  const rejectAt = config.linksRejectAt ?? LINKS_REJECT_AT
  const duplicateMinLength = config.duplicateMinLength ?? DUPLICATE_MIN_LENGTH

  return {
    name: 'content',
    async run(context: SpamCheckContext): Promise<LayerOutcome> {
      const body = context.comment.body

      if (BBCODE_LINK.test(body)) return { action: 'reject', reason: 'bbcode-link' }

      const links = countLinks(body)
      if (links >= rejectAt) return { action: 'reject', reason: 'link-flood' }
      const held: LayerOutcome =
        links >= reviewAt ? { action: 'review', reason: 'many-links' } : null

      // The duplicate read still happens when a review is already held, because a
      // duplicate is a reject and a reject outranks it — short-circuiting on the
      // weaker answer would let a spammer downgrade their own verdict by adding a
      // third link to a body they had already posted.
      if (body.length >= duplicateMinLength) {
        const bodyHash = await computeBodyHash(body)
        // Same thread only: `comments_by_body` is (thread_id, body_hash), so this
        // is one indexed seek. Asking across every thread would be a table scan
        // on the busiest write path in the Worker.
        if (await hasDuplicateBodyOnPage(context.db, context.pageKey, bodyHash)) {
          // Reject is safe here in a way it is not elsewhere: the identical body
          // is already stored on this page, so nothing anybody wrote is lost. It
          // also makes a double-clicked submit button a no-op rather than a
          // double post.
          return { action: 'reject', reason: 'duplicate-body' }
        }
      }

      return held
    },
  }
}
