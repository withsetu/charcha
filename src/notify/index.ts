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
// ## What reaches Resend, stated exactly
//
// Enabling this **does** transmit reader-authored content to a third party, and the
// site owner owes their readers that disclosure — so it is written here precisely
// rather than reassuringly:
//
//   - **Sent:** the commenter's display name and an excerpt of their comment body,
//     inside the email, to Resend. Unavoidable — a notification with no content is
//     one the owner must open the dashboard to understand, for every comment
//     including the obvious spam.
//   - **Not sent:** the commenter's email address, anything derived from their IP,
//     and the absolute URL they reported. `CommentCreatedEvent` has no field for any
//     of the three, and src/notify/resend.ts builds a four-key payload with no
//     `reply_to`, `cc`, `bcc`, `headers` or `tags`.
//
// That split is the point. Spam layer 7 is opt-in and off by default because it
// sends commenter IP, email *and* content; this sends the least of that set which
// still does the job, and it is off by default for the same reason.
//
// Enforced by test/worker/notify/notifier.test.ts and
// test/worker/notify/pipeline-seam.test.ts.

// `announceOnce` lives under src/spam because that is where it was first needed, but
// it is generic isolate-scoped observability and src/admin already reuses it from two
// files. Its dedupe set is shared across callers, so the keys here are namespaced.
import { announceOnce } from '../spam/log'
import type { NotifyEnv } from './env'
import type { CommentCreatedEvent } from './event'
import { buildOwnerNotification } from './message'
import { sendEmail } from './resend'
import { sendBudget } from './throttle'
import type { SendBudget } from './throttle'

export type { CommentCreatedEvent } from './event'

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

/**
 * The trimmed value, or null when the owner has not set it.
 *
 * Trimmed because a trailing newline from `wrangler secret put` is a real way to
 * configure a broken `Authorization` header, and a blank string is not a secret.
 */
function configured(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
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
  const apiKey = configured(env.RESEND_API_KEY)
  const from = configured(env.CHARCHA_NOTIFY_FROM)
  const to = configured(env.CHARCHA_NOTIFY_TO)

  if (apiKey === null || from === null || to === null) {
    const absent: string[] = []
    if (apiKey === null) absent.push('RESEND_API_KEY')
    if (from === null) absent.push('CHARCHA_NOTIFY_FROM')
    if (to === null) absent.push('CHARCHA_NOTIFY_TO')

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

        if (!outcome.ok) {
          // The digest count goes back, because this email did not carry it. Without
          // this, the suppressed comments vanish from every later email while the log
          // claims they were covered. See SendBudget.restore.
          //
          // `+ 1` for the comment this send was *for*, which is now unreported too —
          // restoring only the suppressed count would silently drop it, which is the
          // same bug one comment smaller.
          budget.restore(granted.suppressed + 1)

          // A rejected key (401) or an unverified sending domain (403) is a *config*
          // failure rather than a delivery failure: it will fail identically for every
          // comment until the owner changes something, and it is the one thing they
          // need told. Announced once per isolate on its own key, exactly as
          // src/spam/turnstile.ts splits `invalid-input-secret` out from the codes an
          // attacker can provoke — a shared key would let a transient 429 suppress the
          // announcement that matters for the life of the isolate.
          if (outcome.reason === 'http-401' || outcome.reason === 'http-403') {
            announceOnce('notify-credential-rejected', {
              event: 'notify_config',
              enabled: true,
              problem: `Resend rejected the request (${outcome.reason}): check RESEND_API_KEY, and that CHARCHA_NOTIFY_FROM is on a domain verified in that Resend account`,
            })
          }
        }

        // Reported either way, and never re-thrown. #14 wants delivery failures
        // surfaced in the dashboard rather than swallowed; that needs somewhere to
        // store them, which is #128. Until then this is the record, and it carries
        // no comment body, no author name and no address — the same rule
        // src/spam/log.ts holds itself to, for the same reason: a log line is not
        // covered by the retention sweep and cannot be deleted from the dashboard.
        // Enforced by test/worker/notify/notifier.test.ts.
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
