// Layer 4 — rate limiting, per IP and per thread. The first layer that reads the
// database, so it runs after the three that do not.
//
// Two counts, never a scan, and both bounded by an index: `comments_by_ip` is
// (ip_hash, created_at) and `comments_by_thread` starts at thread_id. The cost is
// two queries whatever the page holds, which is the rule the 50-query invocation
// budget produces (CLAUDE.md).
// Enforced by test/worker/spam/rate-limit.test.ts.
//
// **The per-IP half runs wherever it can, and announces itself when it cannot.**
// It counts rows by `comments.ip_hash`, which `src/submit/pipeline.ts` writes
// (#65, shipped in #77), so it needs two things from the deployment: an
// `IP_HASH_SECRET`, which a one-click deploy does not set until the owner runs
// `wrangler secret put`, and a `CF-Connecting-IP` from the edge. Missing either,
// it abstains rather than guessing — an unkeyed hash of an address is reversible
// — and says so once per isolate, because a guard that is off is only useful
// knowledge if the owner can find out. The per-thread half below depends on
// neither and runs everywhere.
// Enforced by test/worker/spam/rate-limit-announcements.test.ts.

import { countRecentCommentsByIpHash, countRecentCommentsOnPage } from '../db'
import type { SpamCheckContext } from '../submit/spam'
import type { LayerOutcome, SpamLayer } from './layer'
import { announceOnce } from './log'
import { clientIp, hashIp, usableIpSecret } from './ip'

/**
 * How many comments one address may post inside the window.
 *
 * A person answering a post and then replying to two people is three; five leaves
 * room for a conversation and still caps a flooder at five rows a window. **A
 * default, not a law — flagged on #8 for the owner to confirm**, and #66 moves it
 * to the `settings` table so changing it is not a redeploy.
 */
export const DEFAULT_MAX_PER_IP = 5

/**
 * How many comments one page may take inside the window, from everybody.
 *
 * This is a circuit breaker rather than a filter: it is the only thing that
 * bounds a flood arriving from many addresses at once, which the per-IP limit by
 * construction cannot see. Set high enough that a genuinely busy thread — a post
 * on the front page of somewhere — does not trip it, because the failure mode is
 * turning comments off on the one day they matter.
 */
export const DEFAULT_MAX_PER_PAGE = 30

/** The window both limits count over, in seconds. Ten minutes. */
export const DEFAULT_WINDOW_SECONDS = 600

/**
 * Both halves read a count and then the pipeline writes, with no transaction
 * between them. N submissions arriving at once from one key can all read
 * `count = max - 1` and all be admitted, so the limit is a bound on sustained
 * rate rather than an exact quota. D1 offers no way to close that without a
 * Durable Object, and the layer's job — making a flood cost something — survives
 * the slack.
 */
export interface RateLimitConfig {
  /** Absent means the per-IP half cannot run; the per-thread half still does. */
  ipSecret?: string
  maxPerIp?: number
  maxPerPage?: number
  windowSeconds?: number
}

export function rateLimitLayer(config: RateLimitConfig): SpamLayer {
  const secret = usableIpSecret(config.ipSecret) ?? undefined
  const maxPerIp = config.maxPerIp ?? DEFAULT_MAX_PER_IP
  const maxPerPage = config.maxPerPage ?? DEFAULT_MAX_PER_PAGE
  const windowSeconds = config.windowSeconds ?? DEFAULT_WINDOW_SECONDS

  return {
    name: 'rate-limit',
    async run(context: SpamCheckContext): Promise<LayerOutcome> {
      const since = context.now - windowSeconds

      // Per IP first: it is the more specific signal and the one with the fewest
      // false positives, so catching here saves the per-page read as well.
      const ip = clientIp(context.request)
      const unkeyed = secret === undefined || secret === ''
      if (unkeyed || ip === null) {
        // Abstain rather than guess. An unkeyed hash of an address is reversible
        // (see hashIp), so there is no fallback that is better than not running.
        announceOnce(unkeyed ? 'rate-limit-no-secret' : 'rate-limit-no-ip', {
          event: 'spam_config',
          layer: 'rate-limit',
          half: 'per-ip',
          enabled: false,
          reason: unkeyed ? 'no IP_HASH_SECRET' : 'no CF-Connecting-IP',
        })
      } else {
        // Configured and enforcing, so nothing is announced here. An announcement
        // on this branch would be the #99 bug: it runs immediately before the code
        // that hashes the address and counts the rows, so a line here tells the one
        // audience that can act on it that a working guard is off.
        // Enforced by test/worker/spam/rate-limit-announcements.test.ts.
        const ipHash = await hashIp(ip, secret)
        const recent = await countRecentCommentsByIpHash(context.db, ipHash, since)
        // Reject, not review: a review still writes a row, and the whole point of
        // this layer is to stop one address from spending the deployment's write
        // budget. The reason carries no address and no hash — a log line is not
        // covered by #19's retention sweep.
        if (recent >= maxPerIp) return { action: 'reject', reason: 'per-ip' }
      }

      // Review, not reject — unlike the per-IP half above. A commenter who trips
      // this has done nothing wrong: the *page* is busy, and they arrived after
      // thirty other people. Rejecting discards a real person's writing on the day
      // a post finally found an audience, with no queue entry and no recourse,
      // which is the failure this limit exists to avoid rather than to cause.
      //
      // Raising the threshold would only move the trigger point; holding for review
      // changes the failure mode. The write-budget argument that justifies rejecting
      // per IP does not carry here either — one page pinned at this cap is 4,320
      // rows/day, about 4% of the 100k daily write budget, so admitting the burst to
      // the queue costs little and a moderator sees the flood in one place.
      // Enforced by test/worker/spam/rate-limit.test.ts.
      const onPage = await countRecentCommentsOnPage(context.db, context.pageKey, since)
      if (onPage >= maxPerPage) return { action: 'review', reason: 'per-page' }

      return null
    },
  }
}
