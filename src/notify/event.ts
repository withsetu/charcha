// What the submission pipeline tells the notifier about a comment it just stored.
//
// Its own module so the dependency graph stays a DAG: src/notify/index.ts renders
// through src/notify/message.ts, and both need this type, so declaring it in either
// one makes them import each other. It is re-exported from src/notify/index.ts, which
// is the module's public face.

import type { CommentStatus } from '../db'

/**
 * Three fields are **deliberately absent**, in the same spirit as `RenderableComment`
 * in src/db/index.ts — the field does not exist, so no mistake downstream can send it:
 *
 *   - `authorEmail`, so a reader's address cannot reach a third party.
 *   - any IP-derived value, for the same reason.
 *   - `pageUrl`, because the origin in it is attacker-chosen. `derivePageKey` drops the
 *     origin from a thread's identity, so a submission reporting
 *     `https://evil.example/notes/leaving` lands on the real `/notes/leaving` thread;
 *     carrying that URL into an email the owner's own domain signed would make this a
 *     phishing relay. `pageKey` is enough to say which page. Found in review.
 *
 * Enforced by test/worker/notify/pipeline-seam.test.ts.
 */
export interface CommentCreatedEvent {
  commentId: number
  /** Untrusted. Flattened and capped before it reaches the email. */
  authorName: string
  /** Untrusted, unmoderated, and up to 10,000 characters. Quoted and capped. */
  body: string
  /** Worker-derived path and query, never an absolute URL. See src/page-key.ts. */
  pageKey: string
  status: CommentStatus
}
