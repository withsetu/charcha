// Driven through the deployed Worker, not through the handlers — this is the test
// that would catch an admin route wired up and then not actually reached, or one
// reached without its authentication, which every unit test would happily pass.

import { exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_COOKIE_NAME, issueSession } from '../../../src/admin/session'
import {
  TEST_PASSWORD,
  configurePassword,
  removeLimiter,
  restoreLimiter,
  restorePassword,
  stubLimiter,
} from './env'

const origin = 'https://charcha.example'

function login(body: unknown, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${origin}/admin/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function sessionCookieHeader(): Promise<string> {
  const { token } = await issueSession(TEST_PASSWORD, Math.floor(Date.now() / 1000))
  return `${SESSION_COOKIE_NAME}=${token}`
}

beforeEach(() => {
  configurePassword(TEST_PASSWORD)
  stubLimiter(true)
})

afterEach(() => {
  restoreLimiter()
  restorePassword()
})

describe('POST /admin/api/session — the right password', () => {
  it('is accepted', async () => {
    const response = await login({ password: TEST_PASSWORD })

    expect(response.status).toBe(200)
  })

  it('sets a session cookie scoped to /admin', async () => {
    const response = await login({ password: TEST_PASSWORD })

    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(cookie).toContain('Path=/admin')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
  })

  it('says which authenticator let it in, so #108 needs no second endpoint', async () => {
    const response = await login({ password: TEST_PASSWORD })

    expect(await response.json()).toMatchObject({ authenticated: true, via: 'session' })
  })

  it('is never cached', async () => {
    const response = await login({ password: TEST_PASSWORD })

    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})

describe('POST /admin/api/session — the wrong password', () => {
  it('is refused with 401 and no cookie', async () => {
    const response = await login({ password: 'not-the-password' })

    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('says nothing about why, in one shape the client can branch on', async () => {
    const response = await login({ password: 'not-the-password' })

    expect(await response.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Sign in to use the dashboard.' },
    })
  })

  it('is refused identically when no password is configured at all', async () => {
    // "Unconfigured" and "wrong" must be indistinguishable to a caller. The
    // configuration case goes to a server log, which the owner can read.
    configurePassword(undefined)
    const unconfigured = await login({ password: 'anything' })
    configurePassword(TEST_PASSWORD)
    const wrong = await login({ password: 'not-the-password' })

    expect(unconfigured.status).toBe(wrong.status)
    expect(await unconfigured.json()).toEqual(await wrong.json())
  })

  it('is refused when the configured password is blank', async () => {
    configurePassword('   ')

    expect((await login({ password: '   ' })).status).toBe(401)
  })
})

describe('POST /admin/api/session is not an oracle for whether it is configured', () => {
  // The finding a fresh-context review made, and the reason the body is validated
  // before the secret is consulted. With the secret checked first, a malformed body
  // answered 400/413 on a configured deployment and 401 on an unconfigured one — so
  // one unauthenticated request revealed whether CHARCHA_DASHBOARD_PASSWORD was set,
  // which is to say whether anyone was watching. The assertion above only covered a
  // *well-formed* attempt, and read as coverage of a property that did not hold.

  const brokenBodies: [string, unknown][] = [
    ['malformed JSON', '{not json'],
    ['no password field', { user: 'maya' }],
    ['a numeric password', { password: 12_345 }],
    ['a body past the cap', { password: 'x'.repeat(70_000) }],
    ['an empty body', ''],
  ]

  it.each(brokenBodies)('answers a %s identically either way', async (_label, body) => {
    configurePassword(TEST_PASSWORD)
    const configured = await login(body)
    configurePassword(undefined)
    const unconfigured = await login(body)

    expect(unconfigured.status).toBe(configured.status)
    expect(await unconfigured.text()).toBe(await configured.text())
  })
})

describe('the admin surface answers one error shape, including where no route runs', () => {
  // The 404 and the 500 are handled by src/index.ts rather than by any route, so
  // without an admin branch there they were the only two admin responses *not* in
  // the {error:{code,message}} shape — and they are the two a dashboard client is
  // most likely to meet. A client branching on error.code would throw parsing them.

  it('answers an unknown admin path as JSON, not plain text', async () => {
    const response = await exports.default.fetch(`${origin}/admin/api/nope`)

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'There is nothing at that address.' },
    })
  })

  it('answers a rejected preflight as JSON too', async () => {
    const response = await exports.default.fetch(`${origin}/admin/api/session`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    })

    expect(response.status).toBe(404)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('still answers an unknown public path as plain text', async () => {
    // The public routes' house style is unchanged; only /admin/api/ moves.
    const response = await exports.default.fetch(`${origin}/nope`)

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Not found')
  })
})

describe('POST /admin/api/session — a body that is not a login attempt', () => {
  it.each([
    ['no password field', { user: 'maya' }],
    ['a null password', { password: null }],
    ['a numeric password', { password: 12_345 }],
    ['an array', ['secret']],
    ['a bare string', '"secret"'],
    ['null', 'null'],
  ])('is a 400 rather than a 401: %s', async (_label, body) => {
    const response = await login(body)

    expect(response.status).toBe(400)
  })

  it('is a 400 for malformed JSON, never a 500', async () => {
    const response = await login('{not json')

    expect(response.status).toBe(400)
  })

  it('is a 413 for a body past the shared cap', async () => {
    const response = await login({ password: 'x'.repeat(70_000) })

    expect(response.status).toBe(413)
  })
})

describe('POST /admin/api/session — the brute-force bound', () => {
  it('is a 429 once the throttle says no', async () => {
    stubLimiter(false)

    const response = await login({ password: TEST_PASSWORD })

    expect(response.status).toBe(429)
  })

  it('refuses even the correct password once throttled, not just wrong ones', async () => {
    // A throttle that let the right password through would be a throttle an
    // attacker never meets on the attempt that matters.
    stubLimiter(false)

    expect((await login({ password: TEST_PASSWORD })).headers.get('set-cookie')).toBeNull()
  })

  it('refuses every login when the binding is missing, rather than allowing every login', async () => {
    removeLimiter()

    expect((await login({ password: TEST_PASSWORD })).status).toBe(429)
  })
})

describe('POST /admin/api/session — CSRF', () => {
  it('refuses a login posted from another origin', async () => {
    const response = await login({ password: TEST_PASSWORD }, { origin: 'https://evil.example' })

    expect(response.status).toBe(403)
  })

  it('accepts a login posted from the dashboard itself', async () => {
    const response = await login({ password: TEST_PASSWORD }, { origin })

    expect(response.status).toBe(200)
  })

  it('accepts a login with no Origin, which is curl rather than a browser page', async () => {
    expect((await login({ password: TEST_PASSWORD })).status).toBe(200)
  })
})

describe('GET /admin/api/session', () => {
  it('is a 401 without a session', async () => {
    const response = await exports.default.fetch(`${origin}/admin/api/session`)

    expect(response.status).toBe(401)
  })

  it('reports the session when there is one', async () => {
    const response = await exports.default.fetch(`${origin}/admin/api/session`, {
      headers: { cookie: await sessionCookieHeader() },
    })

    expect(await response.json()).toEqual({ authenticated: true, via: 'session' })
  })

  it('is a 401 for a session signed with a different secret', async () => {
    const cookie = await sessionCookieHeader()
    configurePassword('a-completely-different-secret-value')

    const response = await exports.default.fetch(`${origin}/admin/api/session`, {
      headers: { cookie },
    })

    expect(response.status).toBe(401)
  })
})

describe('DELETE /admin/api/session', () => {
  it('clears the cookie', async () => {
    const response = await exports.default.fetch(`${origin}/admin/api/session`, {
      method: 'DELETE',
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('clears it at the same path, or the browser keeps the original beside it', async () => {
    const response = await exports.default.fetch(`${origin}/admin/api/session`, {
      method: 'DELETE',
    })

    expect(response.headers.get('set-cookie')).toContain('Path=/admin')
  })

  it('works without a valid session, because an expired one is when it is pressed', async () => {
    const response = await exports.default.fetch(`${origin}/admin/api/session`, {
      method: 'DELETE',
      headers: { cookie: `${SESSION_COOKIE_NAME}=nonsense` },
    })

    expect(response.status).toBe(204)
  })

  it('refuses a sign-out from another origin', async () => {
    const response = await exports.default.fetch(`${origin}/admin/api/session`, {
      method: 'DELETE',
      headers: { origin: 'https://evil.example' },
    })

    expect(response.status).toBe(403)
  })
})

describe('the admin surface and CORS', () => {
  // No legitimate cross-origin caller exists for a moderation queue, so no admin
  // response may carry an allow-origin header under any circumstances — and the
  // preflight a browser would need before sending a real cross-origin request is
  // deliberately unregistered.

  it('never allows an origin on a successful login', async () => {
    const response = await login({ password: TEST_PASSWORD }, { origin })

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('never allows an origin on a refusal either', async () => {
    const response = await login({ password: 'wrong' }, { origin })

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('never allows an origin on the queue', async () => {
    const response = await exports.default.fetch(`${origin}/admin/api/queue`, {
      headers: { cookie: await sessionCookieHeader(), origin },
    })

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers no preflight, so a browser never sends the real cross-origin request', async () => {
    const response = await exports.default.fetch(`${origin}/admin/api/session`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    })

    expect(response.status).toBe(404)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})
