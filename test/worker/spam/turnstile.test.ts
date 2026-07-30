import { describe, expect, it } from 'vitest'
import { TURNSTILE_FIELD } from '../../../src/spam/fields'
import {
  MAX_TOKEN_LENGTH,
  NO_TOKEN_REASON,
  NO_TOKEN_UNVERIFIED_REASON,
  SITEVERIFY_URL,
  turnstileLayer,
  turnstileObservations,
} from '../../../src/spam/turnstile'
import { contextFor } from './context'

const SECRET = 'test-secret'

/** A siteverify stand-in. The real endpoint is not reachable from workerd tests. */
function siteverify(body: unknown, init: ResponseInit = {}) {
  const calls: { url: string; body: unknown }[] = []
  const fetchImpl: typeof fetch = (input, request) => {
    const sent = typeof request?.body === 'string' ? request.body : '{}'
    calls.push({ url: urlOf(input), body: JSON.parse(sent) as unknown })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        ...init,
      }),
    )
  }
  return { calls, fetchImpl }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

function withToken(token: unknown) {
  return contextFor({ form: { [TURNSTILE_FIELD]: token } })
}

/**
 * Observations for a deployment that has already proved its widget works.
 *
 * Every test that cares about the token-less verdict states which of the two
 * states it is in, rather than inheriting whatever an earlier test in this file
 * left in the isolate-wide observations. An assertion that passes because of the
 * test above it is the kind this project keeps finding inert.
 */
function proven() {
  const observations = turnstileObservations()
  observations.recordVerified()
  return observations
}

describe('layer 3 — Turnstile, when the site owner has configured a secret', () => {
  it('allows a token siteverify accepts', async () => {
    const { fetchImpl } = siteverify({ success: true })
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl })

    expect(await layer.run(withToken('a-good-token'))).toBeNull()
  })

  it('posts the token to the documented siteverify endpoint', async () => {
    // https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
    const { calls, fetchImpl } = siteverify({ success: true })
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl })

    await layer.run(withToken('a-good-token'))

    expect(calls[0]?.url).toBe(SITEVERIFY_URL)
    expect(calls[0]?.body).toEqual({ secret: SECRET, response: 'a-good-token' })
  })

  it('sends nothing about the commenter — no IP, no name, no comment body', async () => {
    // `remoteip` is optional on siteverify. Layers 1-6 promise to transmit nothing
    // about the reader, and the token already binds the challenge to the client,
    // so sending the IP would buy a disclosure obligation and no detection.
    const { calls, fetchImpl } = siteverify({ success: true })
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl })

    await layer.run(withToken('a-good-token'))

    const sent = JSON.stringify(calls[0]?.body)
    expect(sent).not.toContain('198.51.100.7')
    expect(sent).not.toContain('Rahul')
    expect(sent).not.toContain('underestimate')
  })

  it('rejects a submission with no token at all, without spending a siteverify call', async () => {
    const { calls, fetchImpl } = siteverify({ success: true })
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl, observations: proven() })

    const outcome = await layer.run(contextFor({ form: {} }))

    expect(outcome).toEqual({ action: 'reject', reason: NO_TOKEN_REASON })
    expect(calls).toHaveLength(0)
  })

  it('rejects a blank or non-string token without calling out either', async () => {
    const { calls, fetchImpl } = siteverify({ success: true })
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl, observations: proven() })

    expect((await layer.run(withToken('   ')))?.action).toBe('reject')
    expect((await layer.run(withToken(42)))?.action).toBe('reject')
    expect(calls).toHaveLength(0)
  })

  it('rejects a token past the documented 2048-character cap without calling out', async () => {
    // Two things at once. A 64 KB body cap means an uncapped token is 64 KB the
    // Worker would POST outbound per submission. And an over-long token is a
    // malformed request, whose documented answer is `bad-request` — which this
    // layer answers with `review`. Sending it would hand an attacker a way to
    // turn a hard reject into a stored comment.
    const { calls, fetchImpl } = siteverify({ success: true })
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl })

    const outcome = await layer.run(withToken('x'.repeat(MAX_TOKEN_LENGTH + 1)))

    expect(outcome?.action).toBe('reject')
    expect(calls).toHaveLength(0)
  })

  it('still accepts a token exactly at the cap', async () => {
    const { fetchImpl } = siteverify({ success: true })
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl })

    expect(await layer.run(withToken('x'.repeat(MAX_TOKEN_LENGTH)))).toBeNull()
  })

  it('rejects a token siteverify says is invalid', async () => {
    const { fetchImpl } = siteverify({ success: false, 'error-codes': ['invalid-input-response'] })
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl })

    expect((await layer.run(withToken('forged')))?.action).toBe('reject')
  })

  it('rejects a replayed token — siteverify redeems each one exactly once', async () => {
    const { fetchImpl } = siteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] })
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl })

    expect((await layer.run(withToken('spent')))?.action).toBe('reject')
  })
})

describe('layer 3 — Turnstile, when a token never arrives at all (#104)', () => {
  // The reported deployment: the deploy form (#139) made the owner supply
  // TURNSTILE_SECRET_KEY, and nothing made them put `data-turnstile-sitekey` on the
  // embed element — the sitekey is not part of deploying. No page produces a token,
  // every submission is token-less, and before this every one of them was a 403 the
  // owner never saw.
  //
  // The discriminator is `verified`: siteverify answering `success: true` once is
  // proof that some page on this deployment carries a matching sitekey. It cannot be
  // forged — only a browser that solved a real challenge produces it — and it cannot
  // be suppressed by an attacker, because a real commenter sets it.

  it('holds a token-less submission for review when no token has ever been verified here', async () => {
    // The bug. A reject here empties the site of comments and tells nobody.
    const { calls, fetchImpl } = siteverify({ success: true })
    const layer = turnstileLayer({
      secretKey: SECRET,
      fetch: fetchImpl,
      observations: turnstileObservations(),
    })

    const outcome = await layer.run(contextFor({ form: {} }))

    expect(outcome).toEqual({ action: 'review', reason: NO_TOKEN_UNVERIFIED_REASON })
    // Still no subrequest: a token-less flood on a misconfigured deployment must not
    // become a siteverify bill either.
    expect(calls).toHaveLength(0)
  })

  it('names a reason the owner can tell apart from a clean comment in the queue', async () => {
    // runSubmission stores a `review` reason as `comments.spam_reason` and the queue
    // read selects it (#70), so this string is the owner-facing half of the fix — the
    // one they see without running `wrangler tail`.
    // Enforced by test/worker/submit/pipeline.test.ts.
    const layer = turnstileLayer({ secretKey: SECRET, observations: turnstileObservations() })

    const outcome = await layer.run(contextFor({ form: {} }))

    expect(outcome?.reason).not.toBe(NO_TOKEN_REASON)
    expect(outcome?.reason).toContain('no-token')
  })

  it('goes back to rejecting token-less submissions once one token has verified', async () => {
    // The other half, and the one that keeps layer 3 a gate. On a deployment whose
    // widget demonstrably works, a submission with no token did not come from a
    // rendered widget — which is exactly the script layer 3 exists to stop.
    const { fetchImpl } = siteverify({ success: true })
    const observations = turnstileObservations()
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl, observations })

    expect(await layer.run(withToken('a-good-token'))).toBeNull()

    expect(await layer.run(contextFor({ form: {} }))).toEqual({
      action: 'reject',
      reason: NO_TOKEN_REASON,
    })
  })

  it('takes only a verified token as proof — a rejected one leaves the deployment unproven', async () => {
    // Otherwise the proof is attacker-supplied: anyone could post one garbage token
    // to flip a genuinely misconfigured deployment back into refusing every comment,
    // which is the reported bug with an extra step.
    const { fetchImpl } = siteverify({ success: false, 'error-codes': ['invalid-input-response'] })
    const observations = turnstileObservations()
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl, observations })

    expect((await layer.run(withToken('forged')))?.action).toBe('reject')

    expect((await layer.run(contextFor({ form: {} })))?.action).toBe('review')
  })

  it('remembers across layer instances, because createSpamCheck builds a new one per request', async () => {
    // src/index.ts calls createSpamCheck(c.env) on every submission, so observations
    // owned by the returned layer would be empty on every request and this whole
    // mechanism would be inert — the shape of guard this project has shipped dead
    // before (#65, #126). The default is isolate-wide for that reason.
    const { fetchImpl } = siteverify({ success: true })

    expect(
      await turnstileLayer({ secretKey: SECRET, fetch: fetchImpl }).run(withToken('good')),
    ).toBeNull()

    // A different layer object entirely, as the next request would build.
    const next = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl })
    expect((await next.run(contextFor({ form: {} })))?.action).toBe('reject')
  })

  it('treats siteverify saying missing-input-response the same way, rather than as a reject', async () => {
    // "Response parameter was not provided"
    // (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/,
    // checked 2026-07-25) is the same fact as an empty field reached by another
    // route. The local guard above means we do not expect to send an empty
    // `response` and see it — but if it arrives it must not be a way around the
    // decision the token-less path just made.
    const { fetchImpl } = siteverify({ success: false, 'error-codes': ['missing-input-response'] })
    const layer = turnstileLayer({
      secretKey: SECRET,
      fetch: fetchImpl,
      observations: turnstileObservations(),
    })

    expect((await layer.run(withToken('a-token-cloudflare-did-not-see')))?.action).toBe('review')

    const strict = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl, observations: proven() })
    expect((await strict.run(withToken('a-token-cloudflare-did-not-see')))?.action).toBe('reject')
  })

  it('never allows, in either state — the comment is held, not published', async () => {
    // Card rule 5. `review` stores the comment `pending` behind the human gate and
    // does not stop the run, so layers 4 and 6 still bound how many arrive. `allow`
    // would have been a bypass an attacker could reach by omitting the token.
    const layer = turnstileLayer({ secretKey: SECRET, observations: turnstileObservations() })

    const outcome = await layer.run(contextFor({ form: {} }))

    expect(outcome).not.toBeNull()
  })
})

describe('layer 3 — Turnstile, when the answer is ours to fix rather than the commenter to blame', () => {
  it('holds for review when the configured secret is rejected', async () => {
    // invalid-input-secret is a misconfigured deployment. Rejecting would make
    // every real comment on the site disappear until the owner noticed.
    const { fetchImpl } = siteverify({ success: false, 'error-codes': ['invalid-input-secret'] })
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl })

    expect((await layer.run(withToken('a-good-token')))?.action).toBe('review')
  })

  it('holds for review on siteverify internal-error', async () => {
    const { fetchImpl } = siteverify({ success: false, 'error-codes': ['internal-error'] })
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl })

    expect((await layer.run(withToken('a-good-token')))?.action).toBe('review')
  })

  it('holds for review, never allows, when siteverify is unreachable', async () => {
    // The fail-open/fail-closed call. Reject turns a third-party outage into the
    // site's own outage and silently loses real comments; allow turns the same
    // outage into a total bypass of the layer. Review keeps the comment and puts
    // a human in front of it, and the run continues so rate limiting still binds.
    const layer = turnstileLayer({
      secretKey: SECRET,
      fetch: () => Promise.reject(new Error('network is down')),
    })

    expect((await layer.run(withToken('a-good-token')))?.action).toBe('review')
  })

  it('holds for review on a non-2xx response from siteverify', async () => {
    const { fetchImpl } = siteverify({}, { status: 502 })
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl })

    expect((await layer.run(withToken('a-good-token')))?.action).toBe('review')
  })

  it('holds for review when the response is not the JSON the API documents', async () => {
    const layer = turnstileLayer({
      secretKey: SECRET,
      fetch: () => Promise.resolve(new Response('<html>error</html>')),
    })

    expect((await layer.run(withToken('a-good-token')))?.action).toBe('review')
  })

  it('gives up on a siteverify call that never answers, rather than hanging the submission', async () => {
    const layer = turnstileLayer({
      secretKey: SECRET,
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        }),
    })

    expect((await layer.run(withToken('a-good-token')))?.action).toBe('review')
  })
})

describe('layer 3 — Turnstile, when the site owner has not configured it', () => {
  it('abstains rather than rejecting every comment on the site', async () => {
    // Turnstile is optional configuration. A deployment with no secret must still
    // take comments — cold start abstains, it does not guess.
    const layer = turnstileLayer({})

    expect(await layer.run(withToken('anything'))).toBeNull()
    expect(await layer.run(contextFor({ form: {} }))).toBeNull()
  })

  it('makes no network call at all', async () => {
    const { calls, fetchImpl } = siteverify({ success: true })
    const layer = turnstileLayer({ fetch: fetchImpl })

    await layer.run(withToken('anything'))

    expect(calls).toHaveLength(0)
  })

  it('treats a blank secret as unconfigured, not as a secret', async () => {
    const layer = turnstileLayer({ secretKey: '   ' })

    expect(await layer.run(contextFor({ form: {} }))).toBeNull()
  })
})
