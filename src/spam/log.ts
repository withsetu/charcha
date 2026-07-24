// Observability for the spam pipeline, which CLAUDE.md requires by name: a layer
// that mis-classifies quietly is invisible, and "the filter got stricter" is not
// something anyone can debug from a 403.
//
// The counter-requirement is that the record must not become the leak. A log line
// is not covered by the `ip_hash` retention sweep (#19) and is not deletable from
// the moderation dashboard, so it carries **no comment body, no author name, no
// email, no IP and no IP-derived hash** — only the layer, the reason token, and
// the page, which is a path and already public.
// Enforced by test/worker/spam/log.test.ts.

import type { SpamCheckContext } from '../submit/spam'

export interface VerdictRecord {
  action: 'review' | 'reject'
  layer: string
  reason: string
  context: SpamCheckContext
}

/**
 * One structured line per comment that was rejected or held.
 *
 * Nothing is written for an allowed comment. One line per stopped comment is a
 * signal; one line per comment is an invoice, and the allowed case is the common
 * one on a healthy site.
 */
export function logVerdict(record: VerdictRecord): void {
  console.log(
    JSON.stringify({
      event: 'spam_verdict',
      action: record.action,
      layer: record.layer,
      reason: record.reason,
      pageKey: record.context.pageKey,
    }),
  )
}

const announced = new Set<string>()

/**
 * Writes `record` once per isolate for a given `key`, and never again.
 *
 * This is for facts about the deployment rather than about a comment — "Turnstile
 * is not configured here" is worth knowing exactly once, and worth nothing at all
 * repeated on every submission. A site owner who put the secret in the wrong place
 * has no other way to find out that layer 3 is not running.
 * Enforced by test/worker/spam/log.test.ts.
 */
export function announceOnce(key: string, record: Record<string, unknown>): void {
  if (announced.has(key)) return
  announced.add(key)
  console.log(JSON.stringify(record))
}
