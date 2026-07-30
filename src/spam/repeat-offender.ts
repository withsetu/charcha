// Layer 5 — the commenter the owner has already marked spam. Designed on issue #184,
// and the mirror image of #173's `trust-returning`.
//
// **This is the only layer whose evidence is the owner's own explicit decision.** Every
// other local layer measures the absence of something wrong — an untouched honeypot,
// enough seconds spent typing, not too many links — and a script written against this
// form walks past all of them. This one replays a judgement a human already made, in
// this deployment's own dashboard, about this comment's origin.
//
// It still only ever holds a comment, never refuses one. See `repeatOffenderLayer` below
// for why the strength of the evidence turns out not to be the deciding question.
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
 * So the loose tier is `ip_hash` alone. **The price is real and is paid by people who
 * did nothing**: an address is shared behind a NAT and reassigned by ISPs, so a
 * spammer's neighbour, or whoever holds that address next month, is held. They are not
 * told, and #19's retention sweep nulls `ip_hash` on a window — so the effect expires on
 * its own rather than needing anybody to notice it.
 *
 * **Neither tier refuses, and that is a decision taken against the obvious argument.**
 * The obvious argument is that this is the one layer whose evidence is not probabilistic
 * — #10's classifier and #11's provider cap at `review` because they are guessing, and
 * this replays a decision a human actually took — so it is the strongest case for a
 * `reject` anywhere in the pipeline. It loses to one fact: **the owner's spam decision is
 * about a comment, and anybody can write a comment carrying anybody's email address.**
 *
 * Concretely, on any shared address — CGNAT, a campus, an office, a mobile carrier pool
 * — an attacker posts obvious spam under a victim's email, which is usually public. The
 * owner marks it spam, correctly. Were the strict tier a `reject`, every comment that
 * victim wrote from then on would be refused with a bare 403, never stored, never queued,
 * with nothing for either of them to see, until #19 purged the hash. The attacker would
 * have aimed the owner's own moderation at somebody. Note the asymmetry with #173, which
 * runs the same identity the other way: to plant *approval* you need the owner to approve
 * your spam, which they will not; to plant *condemnation* you need them to do their job.
 *
 * `review` costs almost nothing to give up, which is the other half of the decision. A
 * refusal here would have bought one row write, and layer 4 already bounds those to five
 * per address per window. What is kept is the part that was worth having: the reason, on
 * the comment and in the log, telling the moderator which of the two this is.
 * Enforced by test/worker/spam/repeat-offender.test.ts.
 *
 * **Deliberately not `reviewOnly`.** That flag means "skip me once something has already
 * held this comment", and src/spam/layer.ts states plainly that it is a declaration about
 * *cost* — it exists for the two layers that spend money to answer. This layer is one
 * local indexed read, so skipping it would save nothing worth the extra rule.
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
      // An empty string is not an email address, and it must never reach the strict
      // tier: `author_email = ''` would match every other comment stored with one, so a
      // blank would be an identity everybody shares. `src/submit/schema.ts` turns a blank
      // into an absent key today and `insertComment` stores null, so this is unreachable
      // — it is here because the consequence if that ever loosens is borne by strangers,
      // and because src/submit/pipeline.ts guards the same value on the trust path for
      // the same reason. Fails closed: a blank is treated as no email at all.
      // Enforced by test/worker/spam/repeat-offender.test.ts.
      const email = context.comment.authorEmail
      const identifying = email === undefined || email === '' ? null : email

      const history = await readSpamHistory(context.db, ipHash, identifying)
      if (!history.seen) return null

      // The reasons carry no address and no hash — a log line is not covered by #19's
      // retention sweep, and this one is written to the owner's log and stored on the
      // comment. `known-spammer` names a person the owner refused;
      // `address-refused-before` names the *address* on purpose, because that is all the
      // loose tier knows — a moderator reading "known spammer" about somebody's NAT
      // neighbour would be reading a claim this layer never made.
      return {
        action: 'review',
        reason: history.sameCommenter ? 'known-spammer' : 'address-refused-before',
      }
    },
  }
}
