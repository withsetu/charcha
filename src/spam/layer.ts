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
 */
export type LayerOutcome = { action: 'review' | 'reject'; reason: string } | null

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
 *   Turnstile outage, a link-heavy body) would be a way to skip layers 4 and 5.
 *   A later `reject` therefore overrules an earlier `review`; the first review's
 *   reason is the one kept, because it names the layer that doubted the comment
 *   first.
 * - **A `reviewOnly` layer is skipped once a review is held.** That is the one
 *   exception to the rule above, and it follows from it rather than qualifying it:
 *   such a layer cannot reject and cannot replace the kept reason, so its answer is
 *   already discarded — running it can only cost. See `SpamLayer.reviewOnly`.
 */
export async function runLayers(
  layers: readonly SpamLayer[],
  context: SpamCheckContext,
): Promise<SpamVerdict> {
  let held: { layer: string; reason: string } | null = null

  for (const layer of layers) {
    if (held !== null && layer.reviewOnly === true) continue

    const outcome = await layer.run(context)
    if (outcome === null) continue

    if (outcome.action === 'reject') {
      logVerdict({ action: 'reject', layer: layer.name, reason: outcome.reason, context })
      return { action: 'reject', reason: `${layer.name}: ${outcome.reason}` }
    }

    held ??= { layer: layer.name, reason: outcome.reason }
  }

  if (held === null) return { action: 'allow' }

  logVerdict({ action: 'review', layer: held.layer, reason: held.reason, context })
  return { action: 'review', reason: `${held.layer}: ${held.reason}` }
}
