import { describe, expect, it } from 'vitest'
import { loginThrottle } from '../../../src/admin/throttle'

function attempt(ip?: string): Request {
  return new Request('https://charcha.example/admin/api/session', {
    method: 'POST',
    headers: ip === undefined ? {} : { 'CF-Connecting-IP': ip },
  })
}

function limiter(success: boolean): { binding: RateLimit; keys: string[] } {
  const keys: string[] = []
  const binding = {
    limit: (options: { key: string }) => {
      keys.push(options.key)
      return Promise.resolve({ success })
    },
  }
  return { binding, keys }
}

describe('the login throttle', () => {
  it('allows an attempt the limiter has room for', async () => {
    const { binding } = limiter(true)

    expect(await loginThrottle(binding).allow(attempt('203.0.113.9'))).toBe(true)
  })

  it('refuses an attempt once the limiter says no', async () => {
    const { binding } = limiter(false)

    expect(await loginThrottle(binding).allow(attempt('203.0.113.9'))).toBe(false)
  })
})

describe('what the throttle counts', () => {
  it('counts per client address', async () => {
    const { binding, keys } = limiter(true)

    await loginThrottle(binding).allow(attempt('203.0.113.9'))

    expect(keys).toEqual(['203.0.113.9'])
  })

  it('folds an IPv6 address to its /64, so a guesser cannot reset by incrementing', async () => {
    // Reusing src/spam/ip.ts rather than keying on the raw address. A residential
    // IPv6 customer is handed a /64: keyed on the full address, the throttle is a
    // counter an attacker resets 2^64 times for free.
    const { binding, keys } = limiter(true)
    const throttle = loginThrottle(binding)

    await throttle.allow(attempt('2001:db8:1:2:3:4:5:6'))
    await throttle.allow(attempt('2001:db8:1:2:ffff:ffff:ffff:ffff'))

    expect(new Set(keys).size).toBe(1)
  })

  it('does not fold an IPv4-mapped address, which would count all of IPv4 as one', async () => {
    const { binding, keys } = limiter(true)
    const throttle = loginThrottle(binding)

    await throttle.allow(attempt('::ffff:203.0.113.9'))
    await throttle.allow(attempt('::ffff:198.51.100.4'))

    expect(new Set(keys).size).toBe(2)
  })

  it('counts every unidentifiable caller as one, rather than as none', async () => {
    const { binding, keys } = limiter(true)
    const throttle = loginThrottle(binding)

    await throttle.allow(attempt())
    await throttle.allow(attempt())

    expect(new Set(keys).size).toBe(1)
  })

  it('never uses X-Forwarded-For, which a caller sets freely', async () => {
    const { binding, keys } = limiter(true)
    const request = new Request('https://charcha.example/admin/api/session', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.9' },
    })

    await loginThrottle(binding).allow(request)

    expect(keys).not.toContain('203.0.113.9')
  })
})

describe('a deployment with no rate-limit binding', () => {
  // The type says the binding is always there and wrangler.jsonc declares it.
  // Neither is a runtime guarantee, and a throttle that silently is not running is
  // exactly the failure src/spam/rate-limit.ts shipped once already. Failing open
  // would leave the one credential that can delete every comment on the site behind
  // no brute-force bound, with every other test in this file still green.

  it('refuses every login attempt rather than allowing every login attempt', async () => {
    expect(await loginThrottle(undefined).allow(attempt('203.0.113.9'))).toBe(false)
  })

  it('refuses a caller with no address either', async () => {
    expect(await loginThrottle(undefined).allow(attempt())).toBe(false)
  })
})
