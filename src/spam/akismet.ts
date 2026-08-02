// The Akismet adapter — the first, and so far only, implementation of the layer 8
// seam (#11). CleanTalk and StopForumSpam are named on that issue and deliberately
// not built: one adapter is what proves the seam, a third is speculative until
// somebody asks for it.
//
// A plain `fetch` to the documented endpoint, not an npm package, following
// src/notify/resend.ts: this is one form POST with eleven fields at most, and every
// dependency in this project is gated on licence and audit (#23). Nothing below is
// from memory (card rule 7); every fact was checked on 2026-07-29:
//
// - endpoint, method, encoding, required and optional parameters, the `true` /
//   `false` / `invalid` response bodies, `X-akismet-pro-tip: discard`, and
//   `X-akismet-debug-help`:
//   https://akismet.com/developers/comment-check/
//   https://akismet.com/developers/detailed-docs/comment-check/
// - `X-akismet-alert-code` and `X-akismet-alert-msg`, and the codes for a suspended
//   or overused subscription (10009, 10011, 10402, 10404):
//   https://akismet.com/developers/detailed-docs/errors/
// - the user-agent convention, `[Platform]/[Version] | Akismet/[Version]`:
//   https://akismet.com/developers/detailed-docs/key-verification/
// - pricing: Pro is "$9.95 per month, billed yearly" for "500 spam calls/mo, up to
//   1 site"; Business is "$49.95 per month, billed yearly" for "5000 monthly spam
//   checks"; Personal is "pay what you can" and requires the site to have no ads,
//   sell nothing and promote no business:
//   https://akismet.com/pricing/ and https://akismet.com/pricing/personal/
//
// **The 500-a-month figure is the reason for every other decision in the pipeline
// around this file.** It is why layer 8 runs last, why it is `reviewOnly`, and why
// every failure here abstains instead of retrying.
// Enforced by test/worker/spam/akismet.test.ts and
// test/worker/spam/akismet-announcements.test.ts.

import { announceOnce } from './log'
import type { ProviderSubmission, ProviderVerdict, SpamProvider } from './provider'

/** "https://rest.akismet.com/1.1/comment-check", POST, form-encoded. */
export const AKISMET_COMMENT_CHECK_URL = 'https://rest.akismet.com/1.1/comment-check'

/**
 * How long to wait for Akismet before giving up.
 *
 * Shorter than the five seconds layer 3 allows siteverify (src/spam/turnstile.ts),
 * and the two numbers add up on the same request — this is the *last* layer, so a
 * reader waiting on the button has already paid for Turnstile and four database
 * reads before it starts. It is also the layer whose answer is worth least: it can
 * only add a reason token to a comment that is stored either way, so abstaining
 * costs the moderator a hint and costs the reader nothing.
 */
export const AKISMET_TIMEOUT_MS = 3_000

/**
 * The cap on the two fields whose length a caller chooses.
 *
 * `user_agent` and `referrer` are request headers. Nothing else caps them —
 * src/submit/schema.ts validates the *comment*, and a header is not part of one —
 * so without this, one submission makes the Worker POST outbound whatever a caller
 * put in a header. That is amplification on the public write endpoint, on a layer
 * the site owner is paying per call for. 512 is past any real user-agent string.
 *
 * `comment_content` needs no cap here: `MAX_BODY_LENGTH` already bounds it at 10,000
 * characters before the pipeline reaches any layer, and truncating a body would
 * degrade the very judgement the owner is paying for.
 * Enforced by test/worker/spam/akismet.test.ts.
 */
export const MAX_CONNECTION_FIELD_LENGTH = 512

/**
 * "WordPress/4.4.1 | Akismet/3.1.7" is the shape Akismet's own example uses:
 * `[Platform]/[Version] | Akismet/[API version]`. Charcha's version is deliberately
 * not in it — this file would then be a place a release has to remember to edit,
 * and a stale version string is worse than none.
 */
export const AKISMET_USER_AGENT = 'Charcha | Akismet/1.1'

export interface AkismetConfig {
  /** The owner's Akismet API key. Absent means the provider is not built at all. */
  apiKey?: string
  /**
   * The site this deployment takes comments for — Akismet's required `blog`
   * parameter, and the identity their account matches against (error 10404 is
   * "Site not found in authorized sites list"). It cannot be derived: the Worker's
   * own origin is a `workers.dev` address rather than the blog, and the URL the
   * embed reports carries an attacker-chosen origin (src/page-key.ts).
   */
  siteUrl?: string
  /** Injectable so tests never reach Akismet; defaults to the Worker's `fetch`. */
  fetch?: typeof fetch
  timeoutMs?: number
}

/**
 * Builds the Akismet provider, or `null` if the owner has not configured one.
 *
 * **Both halves or neither**, the same rule the email notifier follows
 * (src/notify/env.ts): a key with no site has nothing to ask about, and a site with
 * no key cannot ask. Half a configuration is announced rather than ignored, because
 * it is the state #104 was about — the owner has done something, believes the
 * feature is on, and the symptom of it being off is indistinguishable from a quiet
 * week.
 * Enforced by test/worker/spam/akismet-announcements.test.ts.
 */
export function akismetProvider(config: AkismetConfig): SpamProvider | null {
  const apiKey = config.apiKey?.trim()
  const rawSiteUrl = config.siteUrl?.trim()
  const hasKey = apiKey !== undefined && apiKey !== ''
  const hasSite = rawSiteUrl !== undefined && rawSiteUrl !== ''

  // Nobody opted in. The default on every deployment, and silent by design — see
  // `providerLayer`.
  if (!hasKey && !hasSite) return null

  if (!hasSite) {
    announce(
      'akismet:no-site-url',
      false,
      'AKISMET_API_KEY is set but the site_url setting is not',
      {
        fix: 'set your site’s address under Setup in your Charcha dashboard, or unset AKISMET_API_KEY to leave layer 8 off',
      },
    )
    return null
  }
  if (!hasKey) {
    announce(
      'akismet:no-api-key',
      false,
      'the site_url setting is set but AKISMET_API_KEY is not',
      {
        fix: 'set AKISMET_API_KEY, or leave layer 8 off — every other spam layer runs without it',
      },
    )
    return null
  }

  const blog = siteHomeUrl(rawSiteUrl)
  if (blog === null) {
    // Checked once, here, rather than per submission. `blog` is required, so an
    // unusable one means every check would spend a metered call to be told
    // `invalid` — the site owner paying, per comment, for an answer that cannot
    // arrive.
    announce('akismet:bad-site-url', false, 'the site_url setting is not an http(s) URL', {
      fix: 'set your site’s address to an absolute URL, scheme included — https://example.com',
    })
    return null
  }

  // Assembled here, where the two guards above have already established that both
  // halves are present, so nothing downstream re-checks what this function decided.
  const settings: Settings = {
    apiKey,
    blog,
    doFetch: config.fetch ?? fetch,
    timeoutMs: config.timeoutMs ?? AKISMET_TIMEOUT_MS,
  }

  return {
    name: 'akismet',
    check: (submission: ProviderSubmission) => check(submission, settings),
  }
}

interface Settings {
  apiKey: string
  blog: string
  doFetch: typeof fetch
  timeoutMs: number
}

/** One comment-check call. Never throws, and never answers anything but a verdict. */
async function check(
  submission: ProviderSubmission,
  { apiKey, blog, doFetch, timeoutMs }: Settings,
): Promise<ProviderVerdict> {
  // `user_ip` is one of the three required parameters. Without one there is no
  // request worth making, and a metered check spent to be told so is a check the
  // owner paid for nothing.
  if (submission.ip === null) {
    announce('akismet:no-ip', true, 'a submission arrived with no CF-Connecting-IP header', {
      meanwhile: 'layer 8 abstains on those submissions rather than spending a check',
    })
    return 'unknown'
  }

  // **Exactly these fields, built as a literal.** Spreading the submission would
  // let a field added to `ProviderSubmission` reach Akismet without anyone
  // deciding it should — and this list is the disclosure a site owner repeats to
  // their readers (README.md). Everything Akismet documents and this does not
  // send is omitted on purpose: `comment_author_url` (Charcha collects none),
  // `user_role` (there are no accounts), `honeypot_field_name` (layer 1 already
  // rejected, so it is always empty here), `recheck_reason`, `comment_context`,
  // `blog_lang`, `blog_charset`, and every `$_SERVER` variable — which is the
  // rest of what the request could say about the reader.
  //
  // `is_test` is never sent, and that is a correctness guard rather than an
  // omission: it makes Akismet's answers non-binding, so a copy of it left in
  // would turn the whole layer into a no-op that still spent the allowance.
  // Enforced by test/worker/spam/akismet.test.ts.
  const form = new URLSearchParams({
    api_key: apiKey,
    blog,
    user_ip: submission.ip,
    comment_type: submission.kind,
    comment_author: submission.authorName,
    comment_content: submission.body,
    comment_date_gmt: new Date(submission.now * 1000).toISOString(),
  })
  if (submission.authorEmail !== undefined) {
    form.set('comment_author_email', submission.authorEmail)
  }
  if (submission.permalink !== null) form.set('permalink', submission.permalink)
  if (submission.userAgent !== null) form.set('user_agent', capped(submission.userAgent))
  if (submission.referrer !== null) form.set('referrer', capped(submission.referrer))

  let response: Response
  try {
    response = await doFetch(AKISMET_COMMENT_CHECK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': AKISMET_USER_AGENT,
      },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    // **Fail open, and further open than layer 3 does.** Turnstile answers
    // `review` when siteverify is unreachable, because a missing token is a
    // signal it lost. Here there is no signal to lose and two reasons not to
    // hold: a `review` would put Akismet's name on a comment Akismet never saw,
    // which is a false reason in the moderator's queue and in the log; and layer
    // 8 is the last layer, so unlike layer 3 there is nothing after it that an
    // attacker waiting for downtime could skip.
    //
    // No retry, for the reason src/notify/resend.ts gives about Resend and one
    // more: the likeliest failure on a metered API is exhaustion, and retrying
    // spends the owner's remaining allowance faster on the day it already ran out.
    // Enforced by test/worker/spam/akismet.test.ts.
    return 'unknown'
  }

  reportAlert(response)
  if (!response.ok) return 'unknown'

  const body = (await response.text().catch(() => '')).trim().toLowerCase()
  if (body === 'false') return 'ham'
  if (body === 'true') {
    // "Akismet has determined that the comment is blatant spam, and you can safely
    // discard it without saving it in any spam queue". Charcha does not discard on
    // it — see `providerLayer` for why acting on it would cost more than it saves —
    // but it does reach the moderator as a distinct reason token.
    return response.headers.get('x-akismet-pro-tip')?.trim().toLowerCase() === 'discard'
      ? 'blatant-spam'
      : 'spam'
  }

  // "invalid", or anything else. An expired subscription (10402), a key in use
  // elsewhere (10005), a site missing from the authorised list (10404), a
  // maintenance page — all of them mean we have no answer, and none of them is the
  // commenter's fault to pay for. The line is the only signal a site owner gets
  // that a layer they are paying for has stopped, because every branch here
  // abstains and abstaining is invisible.
  announce('akismet:invalid', true, 'Akismet did not return a verdict', {
    answer: body.slice(0, 64),
    debugHelp: capped(response.headers.get('x-akismet-debug-help') ?? ''),
    fix: 'check the key and the site at https://akismet.com/account/, or unset AKISMET_API_KEY to turn layer 8 off',
  })
  return 'unknown'
}

/** Truncates a third party's string, or a caller's, before it is sent or logged. */
function capped(value: string): string {
  return value.slice(0, MAX_CONNECTION_FIELD_LENGTH)
}

/**
 * One announcement shape for the whole adapter, so every line is findable by the
 * same filter as layer 3's (`event: 'spam_config'`).
 *
 * Every `key` passed in is a constant, deliberately: a key built from a response
 * header would let Akismet — or anything answering in its place — grow this
 * isolate's announcement set without bound, which is the reasoning
 * src/spam/turnstile.ts records. Separate keys for separate problems, for the other
 * half of that reasoning: a line an attacker can provoke must not be able to
 * suppress the one the owner needs.
 * Enforced by test/worker/spam/akismet-announcements.test.ts.
 */
function announce(
  key: string,
  enabled: boolean,
  problem: string,
  detail: Record<string, unknown>,
): void {
  announceOnce(key, {
    event: 'spam_config',
    layer: 'provider',
    provider: 'akismet',
    enabled,
    problem,
    ...detail,
  })
}

/**
 * Akismet's out-of-band warnings, which ride alongside a perfectly real verdict —
 * "Subscription suspended for overuse" (10009) and "Subscription upgrade needed
 * based on usage" (30001) are both things a site owner has to act on and neither
 * changes what the response body says.
 *
 * So the verdict is still read, and the warning is still reported. Reporting it is
 * the whole point: the alternative is a site owner discovering months later that
 * the layer they pay for has been degraded since a day nobody noticed.
 * Enforced by test/worker/spam/akismet-announcements.test.ts.
 */
function reportAlert(response: Response): void {
  const code = response.headers.get('x-akismet-alert-code')?.trim()
  if (code === undefined || code === '') return

  announce('akismet:alert', true, 'Akismet sent an alert about this account', {
    code: code.slice(0, 32),
    message: capped(response.headers.get('x-akismet-alert-msg') ?? ''),
    fix: 'see https://akismet.com/developers/detailed-docs/errors/ and your account at https://akismet.com/account/',
  })
}

/**
 * The `blog` value, or `null` if the owner's `site_url` setting cannot be one.
 *
 * Query and fragment are dropped — Akismet wants "the front page or home URL", and
 * a `?utm_source` pasted in from a browser bar would make the site unrecognisable
 * against the authorised list. A path is *kept*, because a static site living at
 * `user.github.io/blog` is exactly this project's audience and its home page is not
 * the origin. A trailing slash is dropped so two spellings of one site are one
 * string.
 *
 * **Exported since #207, and the dashboard's settings write is the second caller.** The
 * value is a `settings` row now, so the owner types it into a field and can be told it is
 * wrong — where before the only feedback was a log line nobody was tailing. Both sides go
 * through this one function, so what is stored is what layer 8 will send rather than the
 * spelling that was pasted. Reuse rather than a second URL parser: two canonicalisations
 * that disagreed would let the dashboard accept a value that then announced itself
 * unusable on the next comment, which is the #107 shape.
 * Enforced by test/worker/spam/akismet.test.ts and test/worker/admin/settings.test.ts.
 */
export function siteHomeUrl(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.hostname === '') return null

  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${path}`
}
