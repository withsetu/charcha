import { describe, expect, it } from 'vitest'
import { TURNSTILE_FIELD } from '../../../src/spam/fields'
import { SITEVERIFY_URL, turnstileLayer } from '../../../src/spam/turnstile'
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
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl })

    const outcome = await layer.run(contextFor({ form: {} }))

    expect(outcome?.action).toBe('reject')
    expect(calls).toHaveLength(0)
  })

  it('rejects a blank or non-string token without calling out either', async () => {
    const { calls, fetchImpl } = siteverify({ success: true })
    const layer = turnstileLayer({ secretKey: SECRET, fetch: fetchImpl })

    expect((await layer.run(withToken('   ')))?.action).toBe('reject')
    expect((await layer.run(withToken(42)))?.action).toBe('reject')
    expect(calls).toHaveLength(0)
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
