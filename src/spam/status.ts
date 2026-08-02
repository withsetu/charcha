// What layer 7 is doing, in the four words a dashboard is allowed to say about it (#177).
//
// **Read-only, and that is a constraint on the feature rather than on this file.** The
// `spam_model` row is written by exactly one thing — a human moderation decision, through
// src/spam/train.ts — and that is the whole of #28's answer to "what counts as a label".
// A dashboard that could reset or seed the model would be a second writer, and the
// history the cold-start gate reads would stop being a history of decisions anyone made.
// So this module takes a row it did not fetch and returns a description; nothing here
// writes, and nothing here should be given the ability to.
//
// **It exists because three states are indistinguishable from the outside.** A
// deployment with no `AI` binding, one that is still short of MIN_LABELS_PER_CLASS, and
// one that is trained and simply seeing no spam all present identically: the layer
// abstains and nothing is marked. They need different things from the owner — a binding,
// more moderating, and nothing at all — so the difference has to be carried somewhere,
// and until #177 it was carried in one `announceOnce` line per isolate.
//
// **Nothing here is a score.** SPAM_PROBABILITY_THRESHOLD is provisional and uncalibrated
// (#175), so there is no accuracy, confidence or hit-rate to report and none is invented.
// Counts, a threshold, and when the model last learned are what the data honestly
// supports.
// Enforced by test/worker/spam/status.test.ts.

import type { StoredSpamModelStatus } from '../db'
import { EMBEDDING_MODEL, MIN_LABELS_PER_CLASS, isTrained } from './model'

/**
 * Where layer 7 stands, as one of four mutually exclusive answers.
 *
 * A discriminant computed here rather than four booleans left for the dashboard to
 * combine: the rules are the classifier's, they live beside the constants they read, and
 * a client re-deriving them is a second implementation that can disagree with the layer
 * it is describing.
 *
 * - `no-binding` — no `AI` binding, so the layer never runs and no decision trains it.
 * - `model-changed` — weights fitted in an embedding space this deployment no longer
 *   uses. The layer abstains outright, however long the history behind them is.
 * - `learning` — short of MIN_LABELS_PER_CLASS in at least one class. Abstains, correctly.
 * - `trained` — the gate is met and the layer is speaking.
 */
export type ClassifierState = 'no-binding' | 'model-changed' | 'learning' | 'trained'

export interface ClassifierStatus {
  state: ClassifierState
  /** Comments the owner approved, as the model counted them. */
  hamCount: number
  /** Comments the owner marked as spam, as the model counted them. */
  spamCount: number
  /**
   * MIN_LABELS_PER_CLASS, sent rather than restated on the screen.
   *
   * The #120 duplication, not repeated: `MIN_DASHBOARD_PASSWORD_LENGTH` had to be written
   * out a second time in the dashboard and pinned by a node test reading both files,
   * because the dashboard is a separate TypeScript project that cannot import from here.
   * A number that travels in the payload has no second copy to drift from.
   */
  minPerClass: number
  /** When a decision last changed the model, or null on a deployment that has none. */
  updatedAt: number | null
}

/**
 * The four states, in the order a reader needs them rather than the order the layer
 * checks them.
 *
 * **`model-changed` is tested before the counts, and src/spam/classifier.ts tests it
 * after.** That is a deliberate divergence and not a drift: the ordering there is a CPU
 * decision — the count gate is free and sits above the decode and the embedding, so an
 * untrained deployment reaches Workers AI never. Nothing is being spent here, and for an
 * owner the more actionable truth is the one that says the history they have is about to
 * be discarded (src/spam/train.ts resets the model, counts and all, on the next
 * decision).
 *
 * `no-binding` outranks both because it is the only one that means *nothing runs*: no
 * comment is classified and, unlike the others, no moderation decision trains anything
 * either — so the counts stand still forever with no other symptom.
 * Enforced by test/worker/spam/status.test.ts.
 */
export function classifierStatus(
  stored: StoredSpamModelStatus | null,
  hasBinding: boolean,
): ClassifierStatus {
  const counts = {
    hamCount: stored?.hamCount ?? 0,
    spamCount: stored?.spamCount ?? 0,
    minPerClass: MIN_LABELS_PER_CLASS,
    updatedAt: stored?.updatedAt ?? null,
  }

  if (!hasBinding) return { state: 'no-binding', ...counts }
  if (stored === null) return { state: 'learning', ...counts }
  if (stored.model !== EMBEDDING_MODEL) return { state: 'model-changed', ...counts }

  // Through the shared predicate rather than by comparing the counts again, so this
  // cannot drift from the gate the submission path applies. It is the same condition.
  return { state: isTrained(stored) ? 'trained' : 'learning', ...counts }
}
