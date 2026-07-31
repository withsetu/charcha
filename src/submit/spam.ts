// The spam seam. This is where the submission pipeline (#7) stops and the layered
// spam defence (#8) begins.
//
// #8 owns the layers — honeypot, time-to-submit, Turnstile, rate limiting, content
// heuristics — and the ORDER in which they run is itself the design (see #1 and
// CLAUDE.md). So #7 does not implement any layer. It defines this one interface,
// calls it at the single point the architecture wants (after validation and key
// derivation, before any write), and ships a default that abstains. #8 replaces the
// default without touching the pipeline.
//
// Enforced by test/worker/submit/pipeline.test.ts.

import type { ValidatedComment } from './schema'

/**
 * What the whole pipeline decides about one comment.
 *
 * Four outcomes, and the two in the middle are the ones worth being careful about:
 *
 *   - `reject` — stops the write. The comment is never stored, so neither the owner
 *     nor the commenter ever sees it again. The only outcome that costs a comment.
 *   - `review` — stored as `pending`, in the moderation queue, with the reason that
 *     held it (#70). The human gate, layer 9.
 *   - `allow` — **nothing objected**, which is not the same as "this is genuine".
 *     Six of the layers measure the absence of badness, and on a deployment that
 *     configured nothing most of them did not run at all. This is why `allow` alone
 *     has never been enough to publish a stranger's comment.
 *   - `vouch` — a layer that asks a real classifier for a real verdict got a clean
 *     one, and nothing else objected (#189). The distinction `allow` could not
 *     express, and the only spam-pipeline outcome the owner may configure into an
 *     auto-approval. See src/moderation/policy.ts.
 *
 * `allow` and `vouch` both persist as `pending` unless the owner's moderation policy
 * says otherwise; `insertComment` derives status from `byOwner` and that policy, and
 * this endpoint never sets either directly.
 */
export type SpamVerdict =
  | { action: 'allow' }
  | { action: 'vouch'; reason: string }
  | { action: 'review'; reason: string }
  | { action: 'reject'; reason: string }

/**
 * Everything a spam layer needs, and nothing it has to re-derive.
 *
 * `form` is the raw parsed JSON, not the validated comment, so #8 can read the
 * honeypot field and the form-load timestamp — which are the embed's anti-spam
 * transport, not part of the comment — under whatever names it settles on, without
 * editing the comment schema. Treat it as untrusted (it is).
 *
 * `pageKey` rather than a thread id, because the thread row is created only if the
 * comment survives this check — resolving it earlier would let a rejected spammer
 * burn the write budget. #8's per-thread rate limiting and duplicate-body checks
 * key off `pageKey` and read history through `db`.
 *
 * `db` is here because layers 4 and 6 (rate limiting per IP/thread, duplicate-body
 * detection) cannot decide without reading past comments. It is for **reads only**:
 * the pipeline is the sole writer, and it writes only after this check returns a
 * non-reject verdict, so a spam check that wrote here would both break the
 * "nothing persists for a rejected comment" guarantee and double-spend the write
 * budget. Enforced by test/worker/submit/pipeline.test.ts.
 */
export interface SpamCheckContext {
  comment: ValidatedComment
  form: Record<string, unknown>
  pageKey: string
  pageUrl: string | null
  /**
   * The inbound request, for connection metadata — the client IP
   * (`CF-Connecting-IP`), user agent, and `request.cf`. Its **body is already
   * consumed** (the boundary read and parsed it), so read the content from
   * `comment` and `form`, never from `request.body`.
   */
  request: Request
  db: D1Database
  now: number
}

export interface SpamCheck {
  check(context: SpamCheckContext): Promise<SpamVerdict>
}

/**
 * The v1 default: no local layer has an opinion yet (#8), so it allows everything.
 * "Allow" here still means the comment lands in the moderation queue as `pending` —
 * it is the human gate, not this default, that publishes a comment. Cold start
 * abstains rather than guessing, which is the classifier rule from #1 applied to
 * the whole pipeline while the layers are unbuilt.
 */
export const allowAllSpamCheck: SpamCheck = {
  // Synchronous today, but the interface is async because #8's layers call
  // Turnstile and read D1. Returning a resolved promise keeps the contract without
  // pretending to await anything.
  check(): Promise<SpamVerdict> {
    return Promise.resolve({ action: 'allow' })
  },
}
