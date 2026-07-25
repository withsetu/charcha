// Layer 3 — Turnstile. The first layer that leaves the Worker, so it runs after
// the two that cannot: a comment the honeypot or the clock already caught must
// never cost a subrequest.
//
// Everything here is from the API reference, not from memory (card rule 7):
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
// https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
// Enforced by test/worker/spam/turnstile.test.ts and
// test/worker/spam/turnstile-announcements.test.ts.

import type { SpamCheckContext } from '../submit/spam'
import { TURNSTILE_FIELD, readString } from './fields'
import type { LayerOutcome, SpamLayer } from './layer'
import { announceOnce } from './log'

/** "POST https://challenges.cloudflare.com/turnstile/v0/siteverify" */
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * How long to wait for siteverify before giving up.
 *
 * A comment submission is a person waiting on a button. Five seconds is already
 * the outer edge of what that person will read as "working" rather than "broken",
 * and the answer on timeout is `review` rather than an error, so the cost of
 * being wrong here is a queue entry rather than a lost comment.
 */
export const SITEVERIFY_TIMEOUT_MS = 5_000

/**
 * "Maximum length: 2048 characters" — the documented cap on the `response`
 * parameter, verified 2026-07-24 on the server-side validation page.
 *
 * Enforced here rather than left to siteverify, for two reasons that are both
 * about what a longer token would cost us. `MAX_BODY_BYTES` is 64 KB, so without
 * this a caller can make the Worker POST 64 KB outbound per submission. And an
 * over-long token is a malformed request, whose documented answer is
 * `bad-request` — which this layer deliberately treats as *our* fault and answers
 * with `review`. That would hand an attacker a way to turn a hard reject into a
 * stored comment, which is the one thing the fault split must not allow.
 */
export const MAX_TOKEN_LENGTH = 2048

/** The reason a token-less submission is refused on a deployment whose widget works. */
export const NO_TOKEN_REASON = 'no-token'

/**
 * The reason a token-less submission is *held* instead, on a deployment that has
 * never once verified a token. Distinct from `NO_TOKEN_REASON` on purpose: it is
 * stored as `comments.spam_reason` and shown in the moderation queue (#70), which is
 * the owner-facing signal that does not require reading logs.
 */
export const NO_TOKEN_UNVERIFIED_REASON = 'no-token-unverified-deployment'

/**
 * What this isolate has learned about whether a Turnstile widget is actually on the
 * site's pages — the discriminator #104 turns on.
 *
 * `TURNSTILE_SECRET_KEY` is a Worker secret and `data-turnstile-sitekey` is an
 * attribute on the embed element, set in two different places by two different acts.
 * Set the first and forget the second and no page can produce a token, so *every*
 * submission arrives without one. That looks identical, request by request, to a
 * script posting straight past the widget — which is the thing layer 3 exists to
 * stop. Across requests it does not: a misconfigured deployment has never produced a
 * single valid token, and a working one produces them constantly.
 *
 * So the layer records the one observation that separates them. A `success: true`
 * from siteverify is proof that some page on this deployment carries a sitekey that
 * matches this secret, and it is proof of a kind nobody hostile can manufacture — it
 * takes a browser that solved a real challenge — or suppress, because any real
 * commenter supplies it. Nothing else is recorded: an *unverified* token is not proof,
 * or one garbage token would flip a genuinely misconfigured deployment back into
 * refusing every comment.
 * Enforced by test/worker/spam/turnstile.test.ts.
 */
export interface TurnstileObservations {
  /** Whether siteverify has accepted a token from this deployment. */
  verified(): boolean
  /** Records a `success: true`. One way only, for the life of the isolate. */
  recordVerified(): void
}

export function turnstileObservations(): TurnstileObservations {
  let seen = false
  return {
    verified: () => seen,
    recordVerified: () => {
      seen = true
    },
  }
}

/**
 * One set of observations per isolate, created once at module scope.
 *
 * Not per layer, deliberately. `createSpamCheck` runs on every submission
 * (src/index.ts), so observations owned by the returned layer would be empty on every
 * request and would discriminate nothing at all — the shape of guard this project has
 * shipped inert before (#65, #126). Same reason src/notify/index.ts owns its send
 * budget at module scope.
 *
 * The honest limitation, the same one src/notify/throttle.ts states: this is per
 * isolate, not per deployment, so a cold isolate starts unproven and answers `review`
 * to token-less submissions until a real comment proves the widget. That direction is
 * the safe one — `review` holds the comment behind the human gate and does not stop
 * the run, so layers 4 and 5 still bound how many arrive — and it is load-adaptive the
 * right way, because a busy site warms an isolate on real traffic within seconds.
 * Enforced by test/worker/spam/turnstile.test.ts.
 */
const isolateObservations = turnstileObservations()

export interface TurnstileConfig {
  /** Absent or blank means the owner has not configured Turnstile: the layer abstains. */
  secretKey?: string
  /** Injectable so tests never reach the network; defaults to the Worker's `fetch`. */
  fetch?: typeof fetch
  timeoutMs?: number
  /**
   * Injectable so a test owns the state rather than sharing the isolate's, and so no
   * assertion depends on what the test above it left behind. Nothing in production
   * passes it.
   */
  observations?: TurnstileObservations
}

/**
 * The documented error codes that are the **commenter's** fault, and only those.
 *
 * This split is the whole judgement in this layer. A commenter who produced a token
 * the challenge does not stand behind failed it, and that is a reject. A deployment
 * whose secret is wrong, or a siteverify that answered `internal-error`, has told
 * us nothing about the commenter — punishing them for our configuration would
 * empty the site of comments until somebody noticed.
 *
 * Both members here describe a token that *arrived*:
 * `invalid-input-response` is "Token is invalid, malformed, or expired" and
 * `timeout-or-duplicate` is "Token has already been validated"
 * (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/,
 * checked 2026-07-25). A token arriving at all is itself evidence that a widget
 * rendered, which is what makes blaming its bearer sound.
 *
 * `missing-input-response` — "Response parameter was not provided" — is deliberately
 * **not** here, and #104 is why. It describes the *absence* of a token, which is
 * exactly as consistent with an owner who never set `data-turnstile-sitekey` as with
 * a script skipping the widget, and treating it as the commenter's fault refused
 * every comment on a misconfigured deployment. It routes through `tokenless` instead.
 * Enforced by test/worker/spam/turnstile.test.ts.
 */
const COMMENTER_AT_FAULT = new Set(['invalid-input-response', 'timeout-or-duplicate'])

interface SiteverifyResponse {
  success?: unknown
  'error-codes'?: unknown
}

function errorCodesOf(payload: SiteverifyResponse): string[] {
  const codes = payload['error-codes']
  if (!Array.isArray(codes)) return []
  return codes.filter((code): code is string => typeof code === 'string')
}

export function turnstileLayer(config: TurnstileConfig): SpamLayer {
  const secret = config.secretKey?.trim()
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? SITEVERIFY_TIMEOUT_MS
  const observations = config.observations ?? isolateObservations

  return {
    name: 'turnstile',
    async run(context: SpamCheckContext): Promise<LayerOutcome> {
      // Optional configuration, and the abstention is deliberate. A deployment
      // with no secret still has to take comments; layers 1, 2, 4 and 5 are
      // unaffected. Announced once per isolate so an owner who set the secret in
      // the wrong place can find out that layer 3 is not running.
      if (secret === undefined || secret === '') {
        announceOnce('turnstile-unconfigured', {
          event: 'spam_config',
          layer: 'turnstile',
          enabled: false,
          reason: 'no TURNSTILE_SECRET_KEY',
        })
        return null
      }

      const token = readString(context.form, TURNSTILE_FIELD)?.trim()
      // Checked before the call, so a token-less flood costs no subrequests in
      // either state. See `tokenless` for which state answers what.
      if (token === undefined || token === '') {
        return tokenless(observations)
      }
      // Past the documented cap the token cannot be one Cloudflare issued, so
      // this is a reject and not a subrequest. See MAX_TOKEN_LENGTH.
      if (token.length > MAX_TOKEN_LENGTH) {
        return { action: 'reject', reason: 'token-too-long' }
      }

      let payload: SiteverifyResponse
      try {
        // JSON rather than form encoding: "The API accepts both
        // application/x-www-form-urlencoded and application/json requests".
        // Only the secret and the token are sent. `remoteip` is optional, and
        // layers 1-6 promise to transmit nothing about the reader — the token
        // already binds the challenge to the client that solved it, so sending
        // the IP would buy a disclosure obligation and no extra detection.
        const response = await doFetch(SITEVERIFY_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ secret, response: token }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) return held(`http-${response.status}`)
        payload = await response.json<SiteverifyResponse>()
      } catch {
        // The fail-open/fail-closed call, and the argument for `review`:
        //
        // - reject turns Cloudflare's downtime into this site's downtime, and
        //   loses every real comment posted during it, with no queue entry and no
        //   recourse for the reader.
        // - allow turns the same downtime into a complete bypass of the layer,
        //   which is a thing an attacker can wait for and, with enough traffic,
        //   arrange.
        // - review loses nothing and bypasses nothing: the comment is held for
        //   the human gate, and — because a review does not stop the run (see
        //   runLayers) — rate limiting still bounds how many arrive. The reason
        //   reaches that human: runSubmission stores it as `comments.spam_reason`
        //   and the queue read selects it (#70), so a comment held because
        //   siteverify was unreachable is distinguishable in the queue from one
        //   that arrived clean.
        //   Enforced by test/worker/submit/pipeline.test.ts.
        //
        // The deliberate error is caught rather than inspected: a DNS failure, a
        // TLS failure, an abort and a body that is not JSON all mean the same
        // thing here, which is that we did not get an answer.
        return held('unreachable')
      }

      if (payload.success === true) {
        // The one observation that tells a misconfigured deployment from an attacked
        // one, recorded at the only place it can be earned. See TurnstileObservations.
        observations.recordVerified()
        return null
      }

      const codes = errorCodesOf(payload)

      // Cloudflare reporting the token as absent means what an absent field means, so
      // it gets the same answer rather than a second, softer path around it. The
      // guard above means an empty `response` is not something this layer sends, so
      // this is not expected to be reachable; it is written for the case where it is.
      if (codes.length > 0 && codes.every((code) => code === 'missing-input-response')) {
        return tokenless(observations)
      }

      if (codes.length > 0 && codes.every((code) => COMMENTER_AT_FAULT.has(code))) {
        return { action: 'reject', reason: codes.join(',') }
      }

      // missing-input-secret, invalid-input-secret, bad-request, internal-error,
      // and anything Cloudflare adds later. Ours to fix or theirs to fix, not the
      // commenter's to pay for. Announced so a broken secret is findable.
      //
      // Two keys, not one. A wrong secret is the announcement the site owner
      // actually needs, and if it shared a key with the codes an attacker can
      // provoke, the first hostile submission in an isolate would suppress it for
      // the life of that isolate. Both keys are constants: a key built from
      // `error-codes` would let a response from outside this Worker grow the
      // announcement set without bound.
      const secretRejected = codes.some(
        (code) => code === 'invalid-input-secret' || code === 'missing-input-secret',
      )
      announceOnce(secretRejected ? 'turnstile-secret-rejected' : 'turnstile-unrecognised', {
        event: 'spam_config',
        layer: 'turnstile',
        enabled: true,
        problem: codes.length > 0 ? codes : 'unrecognised siteverify response',
      })
      return { action: 'review', reason: codes.length > 0 ? codes.join(',') : 'unrecognised' }
    },
  }
}

/**
 * Held for review because siteverify gave us no answer to act on — a network
 * failure, a non-2xx, a body that is not JSON, or the timeout. Named for the
 * outcome rather than the cause, because all four mean the same thing here.
 */
function held(reason: string): LayerOutcome {
  return { action: 'review', reason }
}

/**
 * The answer to a submission that carried no Turnstile token, which is #104's whole
 * question: is this deployment misconfigured, or is this a script?
 *
 * **Once the deployment has verified a token, it is a script, and a reject.** The
 * widget demonstrably renders here and puts a token in every form it produces, so a
 * submission without one did not come from it. This is layer 3 doing the job it
 * exists for, and it is the common case on every correctly configured site.
 *
 * **Before it ever has, the honest answer is that we do not know, and `review` is
 * what not knowing costs least.** The owner in #104 set the secret because the deploy
 * form asked for one (#139) and never set `data-turnstile-sitekey`, because the
 * sitekey is not part of deploying. Rejecting refused every comment their readers
 * ever wrote and told the owner nothing. Holding loses nothing and bypasses nothing:
 * the comment is stored `pending` behind the human gate exactly as an unmoderated
 * comment is, `review` does not stop the run so layers 4 and 5 still bound how many
 * arrive, and no reader-visible message names the layer. What it costs, when the
 * deployment is *not* misconfigured and an isolate is cold, is queue entries instead
 * of 403s — for as long as it takes one real commenter to prove the widget.
 *
 * The reader sees the same thing either way as far as the layer is concerned: a
 * generic refusal or a generic "held", never which layer decided. The **owner** is
 * the one who gets the specific signal, in two places — this line, once per isolate,
 * and `NO_TOKEN_UNVERIFIED_REASON` on every held comment in the moderation queue.
 * Enforced by test/worker/spam/turnstile.test.ts and
 * test/worker/spam/turnstile-announcements.test.ts.
 */
function tokenless(observations: TurnstileObservations): LayerOutcome {
  if (observations.verified()) return { action: 'reject', reason: NO_TOKEN_REASON }

  // A constant key, like every other announcement in this file: a key that varied
  // with anything an attacker supplies would let hostile traffic grow the
  // announcement set without bound.
  //
  // Its own key, and not one shared with the secret-rejected line, for the reason
  // stated there — an attacker who can provoke one announcement must not be able to
  // suppress the other for the life of the isolate.
  announceOnce('turnstile-no-token-ever-verified', {
    event: 'spam_config',
    layer: 'turnstile',
    enabled: true,
    problem:
      'a comment arrived with no Turnstile token, and no token has ever been verified on this deployment',
    likelyCause:
      'TURNSTILE_SECRET_KEY is set but no page carries a matching data-turnstile-sitekey, so nothing on the site can produce a token',
    fix: 'add data-turnstile-sitekey to the embed element, or unset TURNSTILE_SECRET_KEY to turn layer 3 off',
    meanwhile: `comments are held for review with reason "${NO_TOKEN_UNVERIFIED_REASON}" rather than refused`,
  })
  return { action: 'review', reason: NO_TOKEN_UNVERIFIED_REASON }
}
