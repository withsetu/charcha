// Email notifications (#14). Optional, off by default, and the only thing they
// ever send is one plain-text email to one address the site owner configured.
//
// ## What v1 notifies about, and what it deliberately does not
//
// **The owner, on a new comment.** That is the whole of it, and it is what #1 lists
// in v1 scope.
//
// **Not the commenter, on a reply.** `comments.author_email` is collected for
// exactly that, and the embed's privacy line promises it — but v1 does not send it,
// on privacy grounds rather than effort:
//
//   - There is no account and no reader cookie (card rule 8), so unsubscribing needs
//     a signed link and a suppression list. A suppression list is a *new table of
//     reader email addresses, indexed for lookup* — a worse store than the one we
//     have, standing in for a consent record we never took.
//   - A reply notification is triggered by a third party's action. That makes the
//     public write endpoint an email-sending oracle: anyone who can guess a comment
//     id can cause mail to a stranger, charged to the owner's domain reputation.
//   - An email a reader cannot unsubscribe from is a worse privacy position than not
//     mailing them at all.
//
// Tracked as #127, with the unsubscribe design as the gating question rather than a
// detail. Until then the address is stored and unused, which is the conservative
// direction.
//
// **And nothing about the commenter travels to Resend.** Not their email, not their
// IP. `CommentCreatedEvent` has no field for either, and src/notify/resend.ts sends
// four keys and no more. Transmitting a reader's details to a third party is the
// disclosure that makes spam layer 7 opt-in; a notifier that did it silently would
// be worse than that layer, not better.
//
// Enforced by test/worker/notify/notifier.test.ts and
// test/worker/notify/pipeline-seam.test.ts.

import type { CommentStatus } from '../db'
// `announceOnce` lives under src/spam because that is where it was first needed, but
// it is generic isolate-scoped observability and src/admin already reuses it from
// two files. Its dedupe set is shared across callers, so the key is namespaced.
import { announceOnce } from '../spam/log'
import type { NotifyEnv } from './env'
import { buildOwnerNotification } from './message'
import { sendEmail } from './resend'
import { NOTIFY_BURST, sendBudget } from './throttle'
import type { SendBudget } from './throttle'

/**
 * What the pipeline tells the notifier about a comment it just stored.
 *
 * **Deliberately missing `authorEmail` and any IP-derived value**, in the same
 * spirit as `RenderableComment` in src/db/index.ts: the field does not exist, so no
 * mistake downstream can put a reader's address in an outbound HTTP request.
 * Enforced by test/worker/notify/pipeline-seam.test.ts.
 */
export interface CommentCreatedEvent {
  commentId: number
  /** Untrusted. Flattened and capped before it reaches the email. */
  authorName: string
  /** Untrusted, unmoderated, and up to 10,000 characters. Quoted and capped. */
  body: string
  pageKey: string
  pageUrl: string | null
  status: CommentStatus
}

export interface Notifier {
  /**
   * Reports one stored comment.
   *
   * **This never rejects and never throws.** It is called through `ctx.waitUntil`,
   * where a rejected promise is discarded with no trace — the unreported-failure bug
   * CLAUDE.md names — so every failure inside is caught here and logged here, and
   * the caller has nothing to handle.
   * Enforced by test/worker/notify/notifier.test.ts.
   */
  commentCreated(event: CommentCreatedEvent): Promise<void>
}

/**
 * The notifier for a deployment that has not configured email: it does nothing,
 * silently and correctly. Mirrors `allowAllSpamCheck` — a default that abstains.
 */
export const noopNotifier: Notifier = {
  commentCreated(): Promise<void> {
    return Promise.resolve()
  },
}

/**
 * One send budget per isolate, created once at module scope.
 *
 * Not per notifier, deliberately. `createNotifier` runs on every submission the way
 * `createSpamCheck` does, so a bucket owned by the returned object would be full on
 * every request and would bound nothing at all — the exact shape of guard this
 * project has shipped inert before (#65). See src/notify/throttle.ts.
 * Enforced by test/worker/notify/notifier.test.ts.
 */
const isolateBudget = sendBudget()

export interface NotifierOverrides {
  /** Injectable so tests never reach api.resend.com. Nothing in production passes it. */
  fetch?: typeof fetch
  timeoutMs?: number
  /** Injectable so a test owns the budget rather than sharing the isolate's. */
  budget?: SendBudget
  /** Injectable so a test owns the clock. Milliseconds. */
  now?: () => number
}

/** Which of the three required values are missing, for the one-per-isolate log line. */
function missing(env: NotifyEnv): string[] {
  const absent: string[] = []
  if ((env.RESEND_API_KEY ?? '').trim() === '') absent.push('RESEND_API_KEY')
  if ((env.CHARCHA_NOTIFY_FROM ?? '').trim() === '') absent.push('CHARCHA_NOTIFY_FROM')
  if ((env.CHARCHA_NOTIFY_TO ?? '').trim() === '') absent.push('CHARCHA_NOTIFY_TO')
  return absent
}

/**
 * Builds the notifier the submission pipeline hands stored comments to.
 *
 * All three values are required together, and a blank one counts as absent. A key
 * with no recipient is a half-configured deployment, and there is no address to fall
 * back on: Charcha has no account and no owner email anywhere in its schema, so
 * guessing one is not available. Unconfigured means off, announced once per isolate
 * so an owner who set a secret in the wrong place can find out — the same shape
 * src/spam/turnstile.ts uses for the same problem.
 * Enforced by test/worker/notify/notifier.test.ts.
 */
export function createNotifier(env: NotifyEnv, overrides: NotifierOverrides = {}): Notifier {
  const absent = missing(env)
  if (absent.length > 0) {
    return {
      commentCreated(): Promise<void> {
        announceOnce('notify-unconfigured', {
          event: 'notify_config',
          enabled: false,
          reason: `email notifications are off: no ${absent.join(', ')}`,
        })
        return Promise.resolve()
      },
    }
  }

  // Non-null after `missing` found nothing absent, and trimmed because a trailing
  // newline in a `wrangler secret put` is a real way to configure a broken header.
  const apiKey = (env.RESEND_API_KEY ?? '').trim()
  const from = (env.CHARCHA_NOTIFY_FROM ?? '').trim()
  const to = (env.CHARCHA_NOTIFY_TO ?? '').trim()

  const budget = overrides.budget ?? isolateBudget
  const now = overrides.now ?? (() => Date.now())

  return {
    async commentCreated(event: CommentCreatedEvent): Promise<void> {
      try {
        const granted = budget.take(now())
        if (granted === null) {
          // One line per dropped notification, and no email. The comment is stored
          // and in the queue either way — this says the *prompt* was dropped, which
          // is otherwise invisible.
          console.log(
            JSON.stringify({
              event: 'notify_send',
              ok: false,
              reason: 'rate-limited',
              burst: NOTIFY_BURST,
              commentId: event.commentId,
            }),
          )
          return
        }

        const { subject, text } = buildOwnerNotification(event, granted.suppressed)
        const outcome = await sendEmail(
          {
            from,
            to,
            subject,
            text,
            // Stable per comment, so a duplicated invocation cannot double-mail.
            idempotencyKey: `charcha-comment-${event.commentId}`,
          },
          { apiKey, fetch: overrides.fetch, timeoutMs: overrides.timeoutMs },
        )

        // Reported either way, and never re-thrown. #14 wants delivery failures
        // surfaced in the dashboard rather than swallowed; that needs somewhere to
        // store them, which is #128. Until then this is the record, and it carries
        // no comment body, no author name and no address — the same rule
        // src/spam/log.ts holds itself to, for the same reason: a log line is not
        // covered by the retention sweep and cannot be deleted from the dashboard.
        console[outcome.ok ? 'log' : 'error'](
          JSON.stringify({
            event: 'notify_send',
            ok: outcome.ok,
            reason: outcome.ok ? undefined : outcome.reason,
            commentId: event.commentId,
            covered: granted.suppressed,
          }),
        )
      } catch (error) {
        // The totality guarantee this interface promises. Nothing above is expected
        // to throw — `sendEmail` catches its own — so reaching here is a bug in this
        // module, and the one thing it must not do is become a rejected promise
        // inside `ctx.waitUntil`, where it would vanish.
        console.error('notify: unexpected failure', error)
      }
    },
  }
}
