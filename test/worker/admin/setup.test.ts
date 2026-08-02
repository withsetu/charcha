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
  shortPassword: boolean
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

  it('does not report the notification addresses, which stopped being secrets (#207)', async () => {
    // They are `settings` rows now, answered by `GET /admin/api/settings` where the rest
    // of the owner's editable configuration already lives. Reporting them here as well
    // would be a second answer to one question — the reason the allowlist was never in
    // this report either. The email section on the Setup tab reads both endpoints and
    // combines them, so nothing was lost by taking them out.
    setEvery(undefined)
    configureSecret('RESEND_API_KEY', 're_test')

    const body = await readBody()

    expect(body.secrets.RESEND_API_KEY).toBe(true)
    expect(Object.keys(body.secrets)).not.toContain('CHARCHA_NOTIFY_TO')
    expect(Object.keys(body.secrets)).not.toContain('CHARCHA_NOTIFY_FROM')
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

/**
 * Signs in the way a browser does, and returns the `name=value` pair to send back.
 *
 * A real `POST /admin/api/session` rather than `issueSession`, because the property
 * under test below is that **the login itself** still accepts a short password. A
 * minted token would prove the session format works and say nothing about the door.
 */
async function signIn(password: string): Promise<string> {
  const response = await exports.default.fetch(`${origin}/admin/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  })

  expect(response.status).toBe(200)
  const pair = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  expect(pair.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
  return pair
}

/** The report as read by a session signed in with `password`, rather than a minted one. */
async function reportFor(password: string): Promise<SetupBody> {
  const response = await exports.default.fetch(SETUP, {
    headers: { cookie: await signIn(password) },
  })

  expect(response.status).toBe(200)
  return response.json()
}

describe('the dashboard password (#120)', () => {
  // The one credential guarding every destructive action here, and the only item on
  // this endpoint that is not a feature switch. It is reported as an advisory —
  // whether it clears the length floor — and never as a gate.

  // It is deliberately not in `secrets` — `answers for every secret the tab reports on,
  // and for no others` above already pins that key set exactly, so a row for the password
  // appearing there fails that test rather than needing one of its own.

  it('says a short one is short', async () => {
    configurePassword('abcd')

    expect((await reportFor('abcd')).shortPassword).toBe(true)
  })

  it('says nothing of the sort about a generated one', async () => {
    const body = await readBody()

    expect(body.shortPassword).toBe(false)
  })

  it('answers a boolean and nothing that could be a measurement', async () => {
    // The #158 rule applied to the one field that is about the credential itself: a
    // boolean is one bit to a caller who already holds the password. A length, a
    // prefix or a score would each be strictly more than they came in with.
    configurePassword('abcd')

    const body = await reportFor('abcd')

    expect(typeof body.shortPassword).toBe('boolean')
    expect(Object.keys(body).sort()).toEqual(['secrets', 'shortPassword'])
  })

  it('never carries the password, whatever it is', async () => {
    configurePassword(SENTINEL)

    const response = await exports.default.fetch(SETUP, {
      headers: { cookie: await signIn(SENTINEL) },
    })

    expect(await response.text()).not.toContain(SENTINEL)
  })

  it('tells an unauthenticated caller nothing about it either', async () => {
    // A weak-password verdict is information about the credential. It goes behind the
    // same door as the rest of the report, and the refusal must not become the answer.
    configurePassword('abcd')
    const short = await (await exports.default.fetch(SETUP)).text()

    configurePassword(TEST_PASSWORD)
    const long = await (await exports.default.fetch(SETUP)).text()

    expect(short).toBe(long)
    expect(short).not.toContain('shortPassword')
  })
})

describe('a deployment already running on a short password', () => {
  // **The no-lockout proof, driven end to end.** #120's whole constraint: whatever this
  // endpoint says about a four-character password, the deployment it says it about must
  // keep working exactly as it did. There is no reset, no second factor and no account
  // to recover through, so a floor enforced on the login path would be a self-inflicted
  // denial of service arriving in a routine update.

  it('still signs in, and gets a session that works', async () => {
    configurePassword('abcd')

    const cookie = await signIn('abcd')
    const session = await exports.default.fetch(`${origin}/admin/api/session`, {
      headers: { cookie },
    })

    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ authenticated: true })
  })

  it('still reaches every authenticated surface behind that session', async () => {
    configurePassword('abcd')
    const cookie = await signIn('abcd')

    for (const path of ['/admin/api/setup', '/admin/api/settings', '/admin/api/queue']) {
      const response = await exports.default.fetch(`${origin}${path}`, { headers: { cookie } })

      expect(response.status, path).toBe(200)
    }
  })

  // What such a deployment *is* told is `says a short one is short` above. It is the
  // same assertion, so it is not repeated here.
})
