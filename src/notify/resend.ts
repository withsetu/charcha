// The one outbound call email notifications make.
//
// A `fetch` to the documented REST endpoint, not the `resend` npm package. The
// package would add a runtime dependency to a project whose supply chain is gated
// on licence and audit (#23), for a single POST with four fields — and this Worker
// already owns the failure handling the SDK would wrap. Nothing here is from
// memory (card rule 7); every fact below was checked on 2026-07-25:
//
// - endpoint, auth header, payload fields, success shape:
//   https://resend.com/docs/api-reference/emails/send-email
// - rate limit (10 requests/second per team, 429 on excess):
//   https://resend.com/docs/api-reference/rate-limit
// - error names and statuses (`rate_limit_exceeded` 429, `validation_error`
//   400/403, `missing_api_key` 401, `restricted_api_key` 401, `not_found` 404):
//   https://resend.com/docs/api-reference/errors
// - free plan: 3,000 emails/month, 100/day, 1 domain, 30-day data retention:
//   https://resend.com/pricing
//
// Enforced by test/worker/notify/resend.test.ts.

/** "POST https://api.resend.com/emails" */
export const RESEND_SEND_URL = 'https://api.resend.com/emails'

/**
 * How long to wait for Resend before giving up.
 *
 * Longer than the Turnstile timeout, because nobody is waiting on this: the send
 * runs after the reader's response has already gone out. Shorter than the 30
 * seconds Cloudflare allows a `waitUntil` promise after the invocation ends, so a
 * hung connection is abandoned by this code rather than cancelled by the runtime —
 * a cancellation logs nothing, and an unreported failure is the bug CLAUDE.md names.
 * https://developers.cloudflare.com/workers/runtime-apis/context/
 */
export const SEND_TIMEOUT_MS = 10_000

/** "Idempotency-Key … maximum length of 256 characters". */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256

export interface EmailMessage {
  /** "Sender email address. To include a friendly name, pass as `Name <email@example.com>`". */
  from: string
  to: string
  subject: string
  /**
   * The whole message. There is deliberately no `html` counterpart — see
   * src/notify/message.ts for the argument, and the payload test that pins it.
   */
  text: string
  /**
   * Optional `Idempotency-Key` header. Cheap insurance against the one real
   * double-send: a retried or duplicated invocation notifying twice about the same
   * comment. Truncated rather than rejected — a key past the documented cap is a
   * bug in the caller, and dropping the notification over it would be a worse
   * answer than sending it unprotected.
   */
  idempotencyKey?: string
}

export interface ResendConfig {
  apiKey: string
  /** Injectable so tests never reach the network; defaults to the Worker's `fetch`. */
  fetch?: typeof fetch
  timeoutMs?: number
}

/**
 * What one send attempt did. **Never a thrown error** — the caller runs inside
 * `ctx.waitUntil`, where a rejection is discarded silently.
 */
export type SendOutcome = { ok: true; id: string | null } | { ok: false; reason: string }

interface SendResponse {
  id?: unknown
}

/**
 * Sends one email, once.
 *
 * **No retry, deliberately.** The failure this is most likely to meet is a 429 or
 * a quota rejection, and both mean "you are sending too much" — retrying makes a
 * flood worse at the site owner's expense, on their own domain's reputation. A
 * dropped notification costs the owner a prompt; the comment is already stored and
 * still in the moderation queue, so nothing is lost that the dashboard does not
 * still show.
 *
 * The response body is treated as opaque. Resend's errors page classifies failures
 * by name and status but does not publish the response schema, so branching on a
 * field name here would be a guess about someone else's API — the status code is
 * the documented part, and it is the part this reports.
 * Enforced by test/worker/notify/resend.test.ts.
 */
export async function sendEmail(message: EmailMessage, config: ResendConfig): Promise<SendOutcome> {
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? SEND_TIMEOUT_MS

  const headers: Record<string, string> = {
    authorization: `Bearer ${config.apiKey}`,
    'content-type': 'application/json',
  }
  if (message.idempotencyKey !== undefined) {
    headers['idempotency-key'] = message.idempotencyKey.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH)
  }

  // Exactly four fields. Every other documented field is omitted on purpose:
  // `html` because the body is unmoderated commenter text (src/notify/message.ts),
  // and `reply_to`, `cc`, `bcc`, `headers` and `tags` because a value in any of
  // them would be something about the reader travelling to a third party — the
  // disclosure that makes spam layer 8 opt-in. Built as a literal rather than
  // spread from `message` so an added field cannot arrive here by accident.
  // Enforced by test/worker/notify/resend.test.ts.
  const payload = {
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
  }

  try {
    const response = await doFetch(RESEND_SEND_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, reason: `http-${response.status}` }

    // A 2xx means Resend accepted the message, which is the whole question this
    // function answers. Reporting a delivery failure because the id did not parse
    // would be reporting something that did not happen.
    const body = await response.json<SendResponse>().catch(() => null)
    return { ok: true, id: typeof body?.id === 'string' ? body.id : null }
  } catch {
    // A DNS failure, a TLS failure and the abort all mean the same thing here: no
    // answer. Caught rather than inspected, as src/spam/turnstile.ts does.
    return { ok: false, reason: 'unreachable' }
  }
}
