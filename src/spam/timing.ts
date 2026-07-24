// Layer 2 — time to submit. Still free: one number read, no network, no database.
// Enforced by test/worker/spam/timing.test.ts.

import type { SpamCheckContext } from '../submit/spam'
import { ELAPSED_FIELD, readNumber } from './fields'
import type { LayerOutcome, SpamLayer } from './layer'

/**
 * The floor, in milliseconds. Two seconds is the number #1 records, and it is
 * about reading rather than typing: a person has to find the form, read the
 * field labels and type a name before they can post. Nobody does that in under
 * two seconds; a script does it in forty milliseconds.
 */
export const MIN_ELAPSED_MS = 2_000

export function timingLayer(): SpamLayer {
  return {
    name: 'timing',
    run(context: SpamCheckContext): LayerOutcome {
      const elapsed = readNumber(context.form, ELAPSED_FIELD)

      // Missing, or not a number, or negative. Suspicious — a current embed always
      // sends a sane duration — but not proof, and the same thing a cached older
      // embed does. Review keeps the comment recoverable in the queue; reject
      // would lose a real person's words with nothing to point at.
      //
      // Negative is deliberately here and not treated as "zero elapsed". Reading a
      // negative duration as instant is exactly the clock-skew bug that choosing a
      // duration over a timestamp avoided, and it would be a reject.
      if (elapsed === undefined || elapsed < 0) return { action: 'review', reason: 'no-duration' }

      if (elapsed < MIN_ELAPSED_MS) return { action: 'reject', reason: 'too-fast' }

      return null
    },
  }
}
