// Layer 6 — content heuristics. Last of the free local layers, and the one whose
// judgements are the least certain, which is why most of them are `review`.
//
// The order inside the layer is the order of the whole pipeline in miniature: the
// checks that are string work — link counting, BBCode markup, a link in the author's
// name, and the lookalike-domain signal in ./lookalike.ts — run before the one that
// costs a database read, and a body too short for the duplicate rule to mean anything
// costs no read at all.
//
// The duplicate rule is deployment-wide rather than page-scoped since #184: one payload
// blasted at fifty URLs is the archetypal spam shape, and the page-scoped version could
// not see it at all.
// Enforced by test/worker/spam/content.test.ts.

import { readBodyDuplicates } from '../db'
import { computeBodyHash } from '../submit/hash'
import type { SpamCheckContext } from '../submit/spam'
import type { LayerOutcome, SpamLayer } from './layer'
import { lookalikeOutcome } from './lookalike'

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
 * How many *other* pages have to carry the same body before it is held for review.
 *
 * One. Two unrelated pages of a site carrying identical prose inside an hour is the
 * beginning of a blast — but it is also, occasionally, a person answering the same
 * question on two posts about the same thing, which is why it is a review and not a
 * refusal. The moderator sees `duplicate-across-pages` in the queue and can tell those
 * two cases apart in a second; no heuristic here can.
 */
export const CROSS_PAGE_REVIEW_AT = 1

/**
 * How many *other* pages make it a broadcast rather than a cross-post, and so a refusal.
 *
 * Two — a third page carrying the same body. Past two unrelated pages the "they meant
 * it both times" reading stops being available: nobody writes one paragraph and posts
 * it, unchanged, to three different articles within the hour. This is the strongest
 * form of the evidence the same-page rule already rejects on, and it is refused for the
 * same reason — a third copy buys a row write and no new writing.
 *
 * **The threshold is what differs across pages, not the verdict, and the escalation is
 * the answer to "a cross-page duplicate is stronger evidence".** It is stronger evidence
 * of *intent* and weaker evidence of *redundancy*: a second copy on one page is visibly
 * pointless to everyone including its author, while a copy on a new page is the only
 * copy that page has. So the cross-page rule refuses later than the same-page rule, and
 * refuses harder when it does.
 * Enforced by test/worker/spam/content.test.ts.
 */
export const CROSS_PAGE_REJECT_AT = 2

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

/**
 * Every link in a body, as text.
 *
 * The one definition of "a link" in this layer, so the counting rule and the
 * lookalike-domain check in ./lookalike.ts cannot drift apart about what they are
 * looking at — and so a body is scanned once rather than once per heuristic.
 */
export function extractLinks(body: string): string[] {
  return body.match(LINK) ?? []
}

/** Exported so the counting rule is testable on its own, not only through a verdict. */
export function countLinks(body: string): number {
  return extractLinks(body).length
}

/**
 * How much of the body is left once the links are taken out of it. The measure
 * behind "a link list, not a comment" — see LINK_FLOOD_MAX_PROSE.
 */
export function proseLength(body: string): number {
  return body.replace(LINK, ' ').trim().length
}

function linkOutcome(
  body: string,
  links: number,
  reviewAt: number,
  rejectAt: number,
): LayerOutcome {
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
  crossPageReviewAt?: number
  crossPageRejectAt?: number
}

export function contentLayer(config: ContentConfig = {}): SpamLayer {
  const reviewAt = config.linksReviewAt ?? LINKS_REVIEW_AT
  const rejectAt = config.linksRejectAt ?? LINKS_REJECT_AT
  const duplicateMinLength = config.duplicateMinLength ?? DUPLICATE_MIN_LENGTH
  const duplicateWindow = config.duplicateWindowSeconds ?? DUPLICATE_WINDOW_SECONDS
  const crossPageReviewAt = config.crossPageReviewAt ?? CROSS_PAGE_REVIEW_AT
  const crossPageRejectAt = config.crossPageRejectAt ?? CROSS_PAGE_REJECT_AT

  return {
    name: 'content',
    async run(context: SpamCheckContext): Promise<LayerOutcome> {
      const body = context.comment.body

      // Scanned once, and shared by both of the link heuristics below.
      const links = extractLinks(body)

      // BBCode is held, not rejected. `src/render/markdown.ts` renders fenced code
      // blocks, so a reader quoting the spam they received, or a comment on a
      // thread about migrating off phpBB, produces this markup honestly. It is
      // still a strong enough signal to be worth a human's glance.
      const counted: LayerOutcome = BBCODE_LINK.test(body)
        ? { action: 'review', reason: 'bbcode-link' }
        : linkOutcome(body, links.length, reviewAt, rejectAt)
      if (counted?.action === 'reject') return counted

      // A link in the *name* field outranks both, because it is the least ambiguous
      // thing this layer can say: a display name is not a place to put a URL, and
      // there is no rendering path that would make one into a link. It is still a
      // review rather than a refusal — someone typing `Jane (www.janeblog.com)` into
      // the only free-text field beside the comment is making a mistake, not an
      // attack, and a bare 403 gives them nothing to correct.
      // Enforced by test/worker/spam/content.test.ts.
      const named: LayerOutcome =
        countLinks(context.comment.authorName) > 0
          ? { action: 'review', reason: 'link-in-name' }
          : null

      // A lookalike domain outranks the other reviews in this layer, because it is
      // the only one that names something specific for the moderator to look at:
      // "many-links" reports a count they can see for themselves, while this says
      // *which* link reads as a domain it is not. It cannot outrank a reject —
      // that branch has already returned — so a comment cannot soften a verdict it
      // has already earned by adding a lookalike link to it.
      // Enforced by test/worker/spam/lookalike.test.ts.
      const held: LayerOutcome = named ?? lookalikeOutcome(links) ?? counted

      // The duplicate read still happens when a review is already held, because a
      // duplicate is a reject and a reject outranks it — short-circuiting on the
      // weaker answer would let a spammer downgrade their own verdict by adding a
      // third link to a body they had already posted.
      if (body.length >= duplicateMinLength) {
        const bodyHash = await computeBodyHash(body)
        // One statement for both questions, across the whole deployment rather than
        // one page (#184). `comments_by_body_hash` is (body_hash, created_at,
        // thread_id), so the hash and the window are both constraints on one covering
        // seek — the cross-page question could not be asked at all against the index
        // this replaced, because that one led with thread_id.
        // Enforced by test/worker/spam/query-plan.test.ts.
        const duplicates = await readBodyDuplicates(
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
        if (duplicates.samePage) return { action: 'reject', reason: 'duplicate-body' }

        // The same body on several *other* pages: the blast the page-scoped rule was
        // structurally unable to see. The same window bounds it, and for the same
        // reason — a moderator's takedown must not become a permanent invisible ban on
        // a piece of text, which matters more here, not less, because across pages the
        // refused copy is the only copy that page would have had.
        if (duplicates.otherPages >= crossPageRejectAt) {
          return { action: 'reject', reason: 'duplicate-broadcast' }
        }
        // Outranks every other review this layer can produce, including a link in the
        // name: it is the only one that has seen the comment somewhere else, and the
        // moderator's next question — where else did this go — is the one it answers.
        if (duplicates.otherPages >= crossPageReviewAt) {
          return { action: 'review', reason: 'duplicate-across-pages' }
        }
      }

      return held
    },
  }
}
