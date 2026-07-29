// What the Setup tab reads (#158), driven through the Worker.
//
// **Two properties, and the file is arranged around them.** The endpoint reports which
// of a deployment's optional features are switched on, which is a sentence worth
// refusing a stranger — "Turnstile is not set" tells a spammer where to spend their
// afternoon — and it reports it as booleans, because there is no version of this screen
// that needs a secret's value back.
//
// Both are kill-shot targets on the PR: delete the `authenticated` call and the door
// tests fail; return the secret instead of the boolean and `never carries a value`
// fails.

import { exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_COOKIE_NAME, issueSession } from '../../../src/admin/session'
import { REPORTED_SECRETS, type ReportedSecret } from '../../../src/admin/setup'
import {
  TEST_PASSWORD,
  configurePassword,
  configureSecret,
  restoreLimiter,
  restorePassword,
  restoreSecrets,
  stubLimiter,
} from './env'

const origin = 'https://charcha.example'
const SETUP = `${origin}/admin/api/setup`

/**
 * The value every reported secret is set to for the leak test.
 *
 * One distinctive string for all of them, so a single `toContain` over the raw response
 * body covers every field at once — including a field somebody adds later without
 * reading this file.
 */
const SENTINEL = 'sentinel-uNgUeSsAbLe-value-0f8a3c'

let cookie: string

function read(headers: Record<string, string> = {}) {
  return exports.default.fetch(SETUP, { headers: { cookie, ...headers } })
}

interface SetupBody {
  secrets: Record<ReportedSecret, boolean>
}

async function readBody(): Promise<SetupBody> {
  return (await read()).json()
}

function setEvery(value: string | undefined): void {
  for (const name of REPORTED_SECRETS) configureSecret(name, value)
}

beforeEach(async () => {
  configurePassword(TEST_PASSWORD)
  stubLimiter(true)
  const { token } = await issueSession(TEST_PASSWORD, Math.floor(Date.now() / 1000))
  cookie = `${SESSION_COOKIE_NAME}=${token}`
})

afterEach(() => {
  restoreLimiter()
  restorePassword()
  restoreSecrets()
})

describe('the door', () => {
  it('will not say what is configured without a session', async () => {
    const response = await exports.default.fetch(SETUP)

    expect(response.status).toBe(401)
  })

  it('will not say it with a forged session', async () => {
    const response = await read({
      cookie: `${SESSION_COOKIE_NAME}=1785000000.${'A'.repeat(43)}`,
    })

    expect(response.status).toBe(401)
  })

  it('tells an unauthenticated caller nothing about the deployment, either way', async () => {
    // The point of the door here is that the *answer* is the disclosure. A 401 whose
    // body differed by configuration would leak the whole report through the refusal.
    setEvery(SENTINEL)
    const configured = await exports.default.fetch(SETUP)
    const configuredBody = await configured.text()

    setEvery(undefined)
    const bare = await exports.default.fetch(SETUP)

    expect(configuredBody).toBe(await bare.text())
    expect(configuredBody).not.toContain(SENTINEL)
  })

  it('emits no CORS header, so no other origin can read the answer either', async () => {
    // **With an `Origin` on the request, because the realistic way this breaks is
    // reflection.** A handler that echoed the caller's `Origin` would emit nothing at all
    // for a request that carried none, and an assertion on that request would pass while
    // any page on the internet read the report. Both origins are tried: `selfOrigin`
    // gets special treatment on the public routes (src/cors.ts), and this surface must
    // not have inherited it.
    for (const candidate of ['https://evil.example', origin]) {
      const response = await read({ origin: candidate })

      expect(response.status, candidate).toBe(200)
      expect(response.headers.get('access-control-allow-origin'), candidate).toBeNull()
      expect(response.headers.get('access-control-allow-credentials'), candidate).toBeNull()
    }
  })

  it('is never cached, like every other answer on this surface', async () => {
    const response = await read()

    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})

describe('the report', () => {
  it('never carries a value, only whether there is one', async () => {
    setEvery(SENTINEL)

    const response = await read()
    const text = await response.text()

    expect(response.status).toBe(200)
    // The whole body, not a field-by-field check: a field added later without a test is
    // exactly the way a value would get out.
    expect(text).not.toContain(SENTINEL)
    for (const value of Object.values((JSON.parse(text) as SetupBody).secrets)) {
      expect(typeof value).toBe('boolean')
    }
  })

  it('answers for every secret the tab reports on, and for no others', async () => {
    const body = await readBody()

    expect(Object.keys(body.secrets).sort()).toEqual([...REPORTED_SECRETS].sort())
  })

  it('says false on a deployment where nothing optional was set', async () => {
    setEvery(undefined)

    const body = await readBody()

    expect(Object.values(body.secrets)).toEqual(REPORTED_SECRETS.map(() => false))
  })

  it('says true for the ones that are set, and false for the ones that are not', async () => {
    setEvery(undefined)
    configureSecret('TURNSTILE_SECRET_KEY', '0x4AAAAAAA')

    const body = await readBody()

    expect(body.secrets.TURNSTILE_SECRET_KEY).toBe(true)
    expect(body.secrets.IP_HASH_SECRET).toBe(false)
    expect(body.secrets.RESEND_API_KEY).toBe(false)
  })

  it('reports the three email secrets separately, because two of three is off', async () => {
    // The half-configured case the tab exists for: a key and a recipient with no
    // from-address sends nothing, and nothing anywhere says so.
    setEvery(undefined)
    configureSecret('RESEND_API_KEY', 're_test')
    configureSecret('CHARCHA_NOTIFY_TO', 'maya@example.com')

    const body = await readBody()

    expect(body.secrets.RESEND_API_KEY).toBe(true)
    expect(body.secrets.CHARCHA_NOTIFY_TO).toBe(true)
    expect(body.secrets.CHARCHA_NOTIFY_FROM).toBe(false)
  })

  it('calls a blank secret unset, the way the code that reads it does', async () => {
    // `wrangler secret put` with a stray newline is a real way to configure nothing.
    // usableIpSecret and usableDashboardPassword both trim and treat blank as absent, so
    // a tab calling this "set" would assert a property the runtime does not hold.
    setEvery(undefined)
    configureSecret('IP_HASH_SECRET', '   \n  ')

    const body = await readBody()

    expect(body.secrets.IP_HASH_SECRET).toBe(false)
  })
})
