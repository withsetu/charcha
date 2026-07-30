// Layer 5 — the commenter the owner has already marked spam. Designed on issue #184,
// and the mirror image of #173's `trust-returning`.
//
// **This is the only layer whose evidence is the owner's own explicit decision.** Every
// other local layer measures the absence of something wrong — an untouched honeypot,
// enough seconds spent typing, not too many links — and a script written against this
// form walks past all of them. This one replays a judgement a human already made, in
// this deployment's own dashboard, about this comment's origin. It is not a probability
// and it is not a guess, which is why it is the one layer here that is allowed to refuse
// on identity alone.
//
// It sits after the rate limit and before the content heuristics because it costs one
// indexed database read and one HMAC, which is layer 4's price and not layer 1's — the
// ordering is cheapest-first (src/spam/index.ts) and this is priced with the reads.
// Enforced by test/worker/spam/order.test.ts and test/worker/spam/repeat-offender.test.ts.

import { readSpamHistory } from '../db'
import type { SpamCheckContext } from '../submit/spam'
import type { LayerOutcome, SpamLayer } from './layer'
import { clientIp, hashIp, usableIpSecret } from './ip'
import { announceOnce } from './log'

export interface RepeatOffenderConfig {
  /**
   * Absent means this layer cannot run at all, and says so once per isolate. Unlike
   * layer 4 there is no second half that works without it: the whole question is about
   * `comments.ip_hash`, and without a key that column is never written.
   */
  ipSecret?: string
}

/**
 * Whether the owner has already refused this commenter, and how sure we are it is them.
 *
 * **Two tiers, because the identity has two strengths and they cannot carry the same
 * verdict.** #173 settled what identifies a commenter — `author_email` *and* `ip_hash`
 * matched against the same judged row — and nothing here re-litigates it; the strict
 * tier is exactly that, reused. What #184 adds is the observation that the *distrust*
 * direction is allowed a looser match than the trust direction, because the two are not
 * symmetric in what being wrong costs:
 *
 * - Wrongly trusting publishes a stranger's spam with no human in the way.
 * - Wrongly distrusting holds a real comment for review — which is what `hold-all`, the
 *   default on every deployment, does to every comment regardless.
 *
 * So the loose tier is `ip_hash` alone and its verdict is `review`. **The price is
 * real and is paid by people who did nothing**: an address is shared behind a NAT and
 * reassigned by ISPs, so a spammer's neighbour, or whoever holds that address next
 * month, gets held. They are held, never refused, they are not told, and #19's retention
 * sweep nulls `ip_hash` on a window — so the effect expires on its own rather than
 * needing anybody to notice it.
 *
 * **Only the strict tier refuses.** `reject` returns a bare "could not be posted" with
 * no recourse, so it is spent only where the match needs the victim's email address
 * *and* the network they commented from. That is the strongest argument for a refusal
 * anywhere in this pipeline — #10's classifier and #11's provider both cap at `review`
 * precisely because they are probabilistic, and this is not — and it stays reversible in
 * the obvious direction: approving that comment leaves no `spam` row, and the standing
 * comes straight back.
 * Enforced by test/worker/spam/repeat-offender.test.ts.
 */
export function repeatOffenderLayer(config: RepeatOffenderConfig): SpamLayer {
  const secret = usableIpSecret(config.ipSecret)

  return {
    name: 'repeat-offender',
    async run(context: SpamCheckContext): Promise<LayerOutcome> {
      const ip = clientIp(context.request)
      if (secret === null || ip === null) {
        // Abstain rather than guess, and say so once — a guard that is off is only
        // useful knowledge if the owner can find out. It is a separate announcement
        // from layer 4's because it is a separate guard: #77 (refs #65) is the
        // precedent for one layer's announcement going stale while another's stayed
        // true, and sharing a key here would hide exactly that.
        // Enforced by test/worker/spam/repeat-offender-announcements.test.ts.
        announceOnce(secret === null ? 'repeat-offender-no-secret' : 'repeat-offender-no-ip', {
          event: 'spam_config',
          layer: 'repeat-offender',
          enabled: false,
          reason: secret === null ? 'no IP_HASH_SECRET' : 'no CF-Connecting-IP',
        })
        return null
      }

      const ipHash = await hashIp(ip, secret)
      const history = await readSpamHistory(context.db, ipHash, context.comment.authorEmail ?? null)
      if (!history.seen) return null

      // The reasons carry no address and no hash — a log line is not covered by #19's
      // retention sweep, and this one is written to the owner's log and stored on the
      // comment. `known-spammer` names a person the owner refused;
      // `address-refused-before` names the *address* on purpose, because that is all the
      // loose tier knows — a moderator reading "known spammer" about somebody's NAT
      // neighbour would be reading a claim this layer never made.
      return history.sameCommenter
        ? { action: 'reject', reason: 'known-spammer' }
        : { action: 'review', reason: 'address-refused-before' }
    },
  }
}
