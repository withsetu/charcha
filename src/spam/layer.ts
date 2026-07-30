// What a layer is, and the rule for running several of them in order.
//
// The ORDER is the design (#1, CLAUDE.md): the free local checks run before
// anything that costs a network round trip or a database read, so a comment
// stopped by a string comparison never spends a Turnstile call or a D1 query.
// Enforced by test/worker/spam/order.test.ts.

import type { SpamCheckContext, SpamVerdict } from '../submit/spam'
import { logVerdict } from './log'

/**
 * A layer's answer. `null` is "no opinion", which is the common case and is not
 * the same as "this comment is fine" — only the whole run allows.
 *
 * There is deliberately no `allow` here. A layer that could allow would be a
 * layer that could veto every layer after it, and the ordering would stop being
 * a pipeline.
 *
 * **`vouch` is not that veto, and the difference is the whole of #189.** It says
 * "I checked this comment and found it clean" — a statement `null` cannot carry,
 * because `null` is also what a layer says when it did not run at all. Six of the
 * layers here measure the *absence* of badness and cannot vouch for anything; the
 * ones that can are the two that ask a real classifier for a real verdict.
 *
 * A vouch loses to any doubt, from any layer, in either direction — see `runLayers`.
 * It raises the ceiling on what the owner may choose to do with a clean run
 * (src/moderation/policy.ts); it never lowers the floor.
 * Enforced by test/worker/spam/vouch.test.ts.
 */
export type LayerOutcome = { action: 'review' | 'reject' | 'vouch'; reason: string } | null

export interface SpamLayer {
  /** Short, stable, and safe to log — it names the layer, never the comment. */
  readonly name: string
  /**
   * True for a layer whose strongest answer is `review` (#10).
   *
   * **It is a cost declaration, not a policy.** `runLayers` keeps the *first*
   * review's reason and a later review changes nothing, so once some layer has held
   * a comment, asking a review-only layer can no longer alter the verdict — its
   * answer is discarded whatever it is. For a layer that is free that is merely
   * pointless; for layer 7, which spends a metered Workers AI call on the public
   * write endpoint, it is an unauthenticated caller making a deployment spend
   * neurons on an answer nobody reads. Omitting the elapsed field is enough to
   * produce a `review` from layer 2 (src/spam/timing.ts) on every submission.
   *
   * A layer that can `reject` must never set this: its answer still matters after a
   * review, because a reject overrules one.
   * Enforced by test/worker/spam/order.test.ts.
   */
  readonly reviewOnly?: boolean
  run(context: SpamCheckContext): LayerOutcome | Promise<LayerOutcome>
}

/**
 * Runs the layers in order and reduces their answers to one verdict.
 *
 * Two rules, and both are load-bearing:
 *
 * - **`reject` stops the run.** Nothing after it is asked, so a rejected comment
 *   costs only the layers cheap enough to have already run.
 * - **`review` does not stop the run.** A review still persists a row, so the
 *   layers that bound writes — rate limiting above all — must still get their
 *   say. If review short-circuited, anything that reliably produces one (a
 *   Turnstile outage, a link-heavy body) would be a way to skip layers 4 and 6.
 *   A later `reject` therefore overrules an earlier `review`; the first review's
 *   reason is the one kept, because it names the layer that doubted the comment
 *   first.
 * - **A `reviewOnly` layer is skipped once a review is held.** That is the one
 *   exception to the rule above, and it follows from it rather than qualifying it:
 *   such a layer cannot reject and cannot replace the kept reason, so its answer is
 *   already discarded — running it can only cost. See `SpamLayer.reviewOnly`.
 * - **A `vouch` never outranks a doubt** (#189). It is collected separately from
 *   `held` and consulted only after the loop, so a review or a reject from *any*
 *   layer beats any number of vouches, whichever ran first. Ordering it this way
 *   rather than letting a vouch short-circuit is what keeps it from becoming the
 *   `allow` member this type deliberately does not have: a vouching layer still
 *   cannot stop the layers after it from being asked.
 *
 * The interaction with `reviewOnly` falls out for free and is worth stating: the one
 * layer that can vouch is also `reviewOnly`, so once something has held a comment it
 * is skipped and never vouches. That is the desired answer reached by the existing
 * rule — a held comment must not be auto-approved, and here it cannot even be
 * nominated — rather than a second rule that has to agree with the first.
 * Enforced by test/worker/spam/vouch.test.ts.
 */
export async function runLayers(
  layers: readonly SpamLayer[],
  context: SpamCheckContext,
): Promise<SpamVerdict> {
  let held: { layer: string; reason: string } | null = null
  let vouched: { layer: string; reason: string } | null = null

  for (const layer of layers) {
    if (held !== null && layer.reviewOnly === true) continue

    const outcome = await layer.run(context)
    if (outcome === null) continue

    if (outcome.action === 'reject') {
      logVerdict({ action: 'reject', layer: layer.name, reason: outcome.reason, context })
      return { action: 'reject', reason: `${layer.name}: ${outcome.reason}` }
    }

    if (outcome.action === 'vouch') {
      vouched ??= { layer: layer.name, reason: outcome.reason }
      continue
    }

    held ??= { layer: layer.name, reason: outcome.reason }
  }

  // Checked before the vouch, and that order is the safety property rather than a
  // stylistic preference: a run that both doubted and vouched is a doubted run.
  if (held !== null) {
    logVerdict({ action: 'review', layer: held.layer, reason: held.reason, context })
    return { action: 'review', reason: `${held.layer}: ${held.reason}` }
  }

  if (vouched !== null) {
    logVerdict({ action: 'vouch', layer: vouched.layer, reason: vouched.reason, context })
    return { action: 'vouch', reason: `${vouched.layer}: ${vouched.reason}` }
  }

  return { action: 'allow' }
}
