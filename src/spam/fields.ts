// The transport fields — what the embed sends alongside the comment so the layers
// have something to judge. They are not part of the comment, so they are not in
// src/submit/schema.ts; they arrive in the raw `form` the spam seam passes through.
//
// These three names are a CONTRACT with the embed (#5). The embed builds its form
// to match them, so renaming one disarms a layer on every deployment still serving
// a cached embed.js — silently, and only on the attack path. Frozen by
// test/worker/spam/fields.test.ts, and posted on #8 and #5.

/**
 * The honeypot: a field no human can see and no human therefore fills.
 *
 * `subject` rather than something self-describing, and rather than `website` or
 * `homepage`, for one reason each:
 *
 * - Self-describing names (`hp`, `honeypot`, `trap`) are skipped by the spam
 *   frameworks that pattern-match field names before filling a form.
 * - `website`, `url` and `homepage` are exactly the fields a browser's autofill
 *   recognises, and an autofilled honeypot rejects a real person's comment. It is
 *   not in the HTML autofill token list, so nothing will helpfully fill it in.
 *
 * `subject` is also a name Charcha will never want for real: a comment has no
 * subject line, and the page title already arrives as `title`.
 *
 * **The hiding cannot live in the stylesheet.** `bare` mode (#6) is permission to
 * drop Charcha's CSS entirely, and a guard a setting can switch off is not a
 * guard — so the embed hides this field inline with the markup. That is a
 * constraint this file imposes on #5, recorded on both issues.
 */
export const HONEYPOT_FIELD = 'subject'

/**
 * How long the reader had the form open, in **milliseconds**, measured on the
 * client with a monotonic clock (`performance.now()`) — a duration, never a
 * timestamp.
 *
 * A wall-clock timestamp would have to be compared against the server's clock,
 * and a device three seconds fast would look like it submitted three seconds
 * before it loaded the page. Every such reader's comment would be caught by a
 * layer that exists to catch bots. A duration has no clock in it to disagree
 * with, so the whole class of skew false-positives does not exist.
 *
 * It is exactly as forgeable as a timestamp would have been — a bot sends
 * whatever number it likes. Layer 2 is for the bots that do not bother, and
 * claims nothing more.
 */
export const ELAPSED_FIELD = 't'

/**
 * The Turnstile token. This is the name Cloudflare's own widget gives the hidden
 * input it injects, so the embed can serialise its form without renaming
 * anything: "an invisible input field with the name `cf-turnstile-response` is
 * automatically created".
 * https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
 */
export const TURNSTILE_FIELD = 'cf-turnstile-response'

/** The value at `name`, if it is a string. Everything here is untrusted input. */
export function readString(form: Record<string, unknown>, name: string): string | undefined {
  const value = form[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * The value at `name` as a finite number, accepting a numeric string.
 *
 * A string is accepted because a client that posts a serialised form sends `"31000"`
 * rather than `31000`, and the reader should not lose their comment over a JSON
 * type. `NaN`, `Infinity` and `""` are not numbers for this purpose and come back
 * `undefined`, so no caller has to remember to re-check them.
 * Enforced by test/worker/spam/fields.test.ts.
 */
export function readNumber(form: Record<string, unknown>, name: string): number | undefined {
  const value = form[name]
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
