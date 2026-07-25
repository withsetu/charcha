import { describe, expect, it } from 'vitest'
import {
  ADMIN_AUTHENTICATOR_ORDER,
  adminAuthenticators,
  resolveIdentity,
  sessionAuthenticator,
} from '../../../src/admin/authenticate'
import type { AdminAuthenticator } from '../../../src/admin/authenticate'
import { SESSION_COOKIE_NAME, issueSession } from '../../../src/admin/session'
import { TEST_PASSWORD } from './env'

const t0 = 1_753_300_000
const db = undefined as unknown as D1Database

function request(cookie?: string): Request {
  return new Request('https://charcha.example/admin/api/queue', {
    headers: cookie === undefined ? {} : { cookie },
  })
}

function stub(name: string, identity: string | null): AdminAuthenticator {
  return { name, authenticate: () => Promise.resolve(identity === null ? null : { via: identity }) }
}

describe('the authenticator list', () => {
  // The order is data so a test can assert it rather than a reader infer it — the
  // same device SPAM_LAYER_ORDER uses. #108 inserts 'cloudflare-access' at index 0,
  // and it has to go *ahead* of the password: an owner who puts Access in front of
  // their deployment must not still have a live password path behind it.

  it('is exactly the authenticators this deployment runs, in order', () => {
    const authenticators = adminAuthenticators({ db: undefined } as never)

    expect(authenticators.map((one) => one.name)).toEqual([...ADMIN_AUTHENTICATOR_ORDER])
  })

  it('ends with the password session, so anything added later is consulted first', () => {
    expect(ADMIN_AUTHENTICATOR_ORDER.at(-1)).toBe('session')
  })
})

describe('resolving an identity', () => {
  it('takes the first authenticator that vouches for the request', async () => {
    const identity = await resolveIdentity(
      [stub('first', 'first'), stub('second', 'second')],
      request(),
      t0,
    )

    expect(identity?.via).toBe('first')
  })

  it('does not ask a later authenticator once an earlier one has answered', async () => {
    // This is what makes the order meaningful rather than decorative. If a later
    // entry were still consulted, putting Access first (#108) would only *prefer*
    // it, and the password path would stay reachable behind it.
    const asked: string[] = []
    const recording = (name: string, identity: string | null): AdminAuthenticator => ({
      name,
      authenticate: () => {
        asked.push(name)
        return Promise.resolve(identity === null ? null : { via: identity })
      },
    })

    await resolveIdentity(
      [recording('first', 'first'), recording('second', 'second')],
      request(),
      t0,
    )

    expect(asked).toEqual(['first'])
  })

  it('falls through an authenticator with no opinion to the next one', async () => {
    const identity = await resolveIdentity(
      [stub('first', null), stub('second', 'second')],
      request(),
      t0,
    )

    expect(identity?.via).toBe('second')
  })

  it('is null when no authenticator vouches for the request', async () => {
    const identity = await resolveIdentity(
      [stub('first', null), stub('second', null)],
      request(),
      t0,
    )

    expect(identity).toBeNull()
  })

  it('is null for an empty list, so a misassembled resolver admits nobody', async () => {
    expect(await resolveIdentity([], request(), t0)).toBeNull()
  })
})

describe('the password-session authenticator', () => {
  const env = { DB: db, CHARCHA_DASHBOARD_PASSWORD: TEST_PASSWORD }

  it('vouches for a request carrying a session this deployment issued', async () => {
    const { token } = await issueSession(TEST_PASSWORD, t0)

    const identity = await sessionAuthenticator(env).authenticate(
      request(`${SESSION_COOKIE_NAME}=${token}`),
      t0,
    )

    expect(identity).toEqual({ via: 'session' })
  })

  it('does not vouch for a request with no cookie', async () => {
    expect(await sessionAuthenticator(env).authenticate(request(), t0)).toBeNull()
  })

  it('does not vouch for a forged cookie', async () => {
    const identity = await sessionAuthenticator(env).authenticate(
      request(`${SESSION_COOKIE_NAME}=1785000000.${'A'.repeat(43)}`),
      t0,
    )

    expect(identity).toBeNull()
  })

  it('vouches for a real session even when a junk one is listed ahead of it', async () => {
    // The lockout. `readSessionCookies` returning every candidate is only half the
    // fix — the authenticator has to *try* them, and a kill-shot that reduced this
    // loop back to `[0]` broke no test until this one existed. `__Secure-` says
    // nothing about `Domain`, so on a custom domain anything able to write a cookie
    // on a sibling host could otherwise sign the owner out indefinitely.
    const { token } = await issueSession(TEST_PASSWORD, t0)
    const planted = `1785000000.${'A'.repeat(43)}`

    const identity = await sessionAuthenticator(env).authenticate(
      request(`${SESSION_COOKIE_NAME}=${planted}; ${SESSION_COOKIE_NAME}=${token}`),
      t0,
    )

    expect(identity).toEqual({ via: 'session' })
  })

  it('still refuses when every candidate is junk', async () => {
    const junk = Array.from(
      { length: 3 },
      (_, index) => `${SESSION_COOKIE_NAME}=178500000${index}.${'A'.repeat(43)}`,
    ).join('; ')

    expect(await sessionAuthenticator(env).authenticate(request(junk), t0)).toBeNull()
  })

  it('does not vouch for an expired session', async () => {
    const { token, expiresAt } = await issueSession(TEST_PASSWORD, t0)

    const identity = await sessionAuthenticator(env).authenticate(
      request(`${SESSION_COOKIE_NAME}=${token}`),
      expiresAt + 1,
    )

    expect(identity).toBeNull()
  })
})

describe('an unconfigured deployment', () => {
  // Fail closed. The spam layers abstain when a secret is missing so that comments
  // still get taken; abstaining here would be the opposite of a guard, because the
  // thing behind this one is every comment on the site.

  it('authenticates nobody when the secret is unset', async () => {
    const { token } = await issueSession(TEST_PASSWORD, t0)
    const env = { DB: db }

    const identity = await sessionAuthenticator(env).authenticate(
      request(`${SESSION_COOKIE_NAME}=${token}`),
      t0,
    )

    expect(identity).toBeNull()
  })

  it('authenticates nobody when the secret is blank', async () => {
    // A blank secret must not become a blank signing key. usableDashboardPassword
    // returns null for it, so nothing is ever derived — and it must not throw
    // either: an exception here would be a 500 on every dashboard request instead
    // of the 401 that tells the owner what to fix.
    const { token } = await issueSession(TEST_PASSWORD, t0)
    const env = { DB: db, CHARCHA_DASHBOARD_PASSWORD: '   ' }

    const identity = await sessionAuthenticator(env).authenticate(
      request(`${SESSION_COOKIE_NAME}=${token}`),
      t0,
    )

    expect(identity).toBeNull()
  })

  it('cannot even derive a key from a blank secret, which is the layer under that', async () => {
    // Belt to the usableDashboardPassword braces: Web Crypto refuses a zero-length
    // HMAC key outright, so there is no signature a blank-secret deployment could
    // produce for a forger to reuse.
    await expect(issueSession('', t0)).rejects.toThrow()
  })
})
