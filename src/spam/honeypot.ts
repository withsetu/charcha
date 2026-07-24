// Layer 1 — the honeypot. First because it is the cheapest thing in the pipeline:
// one property read and one comparison, no network, no database.
// Enforced by test/worker/spam/honeypot.test.ts.

import type { SpamCheckContext } from '../submit/spam'
import { HONEYPOT_FIELD } from './fields'
import type { LayerOutcome, SpamLayer } from './layer'

export function honeypotLayer(): SpamLayer {
  return {
    name: 'honeypot',
    run(context: SpamCheckContext): LayerOutcome {
      const value = context.form[HONEYPOT_FIELD]

      // Absent is not evidence. A stale cached embed, or any caller that never
      // rendered the form, sends no such field and has not tripped anything —
      // rejecting on absence would turn "did not send a field" into "is a
      // spammer", which is a far weaker claim than this layer is allowed to make.
      if (value === undefined || value === null) return null

      // A non-string is a fill: the field is a text input, and a bot posting JSON
      // with a number or an array in it did not get that value from the form.
      if (typeof value !== 'string') return { action: 'reject', reason: 'filled' }

      // Trimmed, so a stray space from a keyboard-navigating reader who somehow
      // reached the field cannot cost them their comment. The embed sends "".
      if (value.trim() === '') return null

      // Reject rather than review, and this is the one layer where that is easy
      // to defend: the field is unlabelled, out of the tab order, hidden inline
      // with the markup, and carries a name no browser autofill recognises. There
      // is no path by which a person fills it.
      return { action: 'reject', reason: 'filled' }
    },
  }
}
