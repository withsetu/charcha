// Layer 3 — Turnstile. The first layer that leaves the Worker, so it runs after
// the two that cannot: a comment the honeypot or the clock already caught must
// never cost a subrequest.
//
// Everything here is from the API reference, not from memory (card rule 7):
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
// https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
// Enforced by test/worker/spam/turnstile.test.ts.

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

export interface TurnstileConfig {
  /** Absent or blank means the owner has not configured Turnstile: the layer abstains. */
  secretKey?: string
  /** Injectable so tests never reach the network; defaults to the Worker's `fetch`. */
  fetch?: typeof fetch
  timeoutMs?: number
}

/**
 * The documented error codes, split by **whose fault the failure is**.
 *
 * This split is the whole judgement in this layer. A commenter who could not
 * produce a valid token failed the challenge, and that is a reject. A deployment
 * whose secret is wrong, or a siteverify that answered `internal-error`, has told
 * us nothing about the commenter — punishing them for our configuration would
 * empty the site of comments until somebody noticed.
 */
const COMMENTER_AT_FAULT = new Set([
  'missing-input-response',
  'invalid-input-response',
  'timeout-or-duplicate',
])

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
      // No token, once the owner has configured Turnstile, is a reject and not a
      // review — the widget puts one in every form it renders, so a submission
      // without one did not come from a rendered widget. Downgrading this to
      // review would make Turnstile a tag rather than a gate. Checked before the
      // call, so a token-less flood costs no subrequests.
      if (token === undefined || token === '') {
        return { action: 'reject', reason: 'no-token' }
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
        //   runLayers) — rate limiting still bounds how many arrive. Note that
        //   the *reason* does not currently reach that human: the pipeline
        //   stores every public comment as `pending` and discards the reason, so
        //   a held comment is intended to be distinguishable from a clean one in
        //   the queue but is not yet. That is #70.
        //
        // The deliberate error is caught rather than inspected: a DNS failure, a
        // TLS failure, an abort and a body that is not JSON all mean the same
        // thing here, which is that we did not get an answer.
        return held('unreachable')
      }

      if (payload.success === true) return null

      const codes = errorCodesOf(payload)
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
