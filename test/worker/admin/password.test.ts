import { describe, expect, it } from 'vitest'
import {
  MAX_SUPPLIED_PASSWORD_LENGTH,
  passwordMatches,
  usableDashboardPassword,
} from '../../../src/admin/password'

const secret = 'ThFn6Q7Rf2kZ8pWvB3xTqYuA'

describe('the configured password', () => {
  it('is the secret when one is set', () => {
    expect(usableDashboardPassword(secret)).toBe(secret)
  })

  it('is trimmed, because a pasted secret carries a newline more often than not', () => {
    expect(usableDashboardPassword(`${secret}\n`)).toBe(secret)
  })

  it('is null when unset, so the dashboard has nothing to authenticate against', () => {
    expect(usableDashboardPassword(undefined)).toBeNull()
  })

  it('is null when blank — an empty secret would match an empty submission', () => {
    expect(usableDashboardPassword('')).toBeNull()
  })

  it('is null when only whitespace, for the same reason', () => {
    expect(usableDashboardPassword('   \n\t ')).toBeNull()
  })
})

describe('comparing a submitted password', () => {
  it('accepts the configured one', async () => {
    expect(await passwordMatches(secret, secret)).toBe(true)
  })

  it('refuses a wrong one of the same length', async () => {
    expect(await passwordMatches('ThFn6Q7Rf2kZ8pWvB3xTqYuB', secret)).toBe(false)
  })

  it('refuses a prefix of the right one', async () => {
    expect(await passwordMatches(secret.slice(0, -1), secret)).toBe(false)
  })

  it('refuses the right one with something appended', async () => {
    expect(await passwordMatches(`${secret}x`, secret)).toBe(false)
  })

  it('refuses the right one with trailing whitespace — the submission is not trimmed', async () => {
    // The secret is trimmed on the way in (a pasted value); the submission is not.
    // Accepting `"secret "` for `"secret"` would widen the credential rather than
    // normalise it.
    expect(await passwordMatches(`${secret} `, secret)).toBe(false)
  })

  it('refuses an empty submission', async () => {
    expect(await passwordMatches('', secret)).toBe(false)
  })

  it('is case sensitive', async () => {
    expect(await passwordMatches(secret.toLowerCase(), secret)).toBe(false)
  })
})

describe('a submitted password that is not a password', () => {
  // The value arrives from a JSON body, where nothing TypeScript believes survives.

  it.each([
    ['a number', 12_345],
    ['null', null],
    ['undefined', undefined],
    ['an object', { toString: () => secret }],
    ['an array', [secret]],
    ['a boolean', true],
  ])('is refused: %s', async (_label, supplied) => {
    expect(await passwordMatches(supplied, secret)).toBe(false)
  })

  it('is refused when longer than the cap, without hashing it', async () => {
    expect(await passwordMatches('x'.repeat(MAX_SUPPLIED_PASSWORD_LENGTH + 1), secret)).toBe(false)
  })

  it('still accepts a real password at exactly the cap', async () => {
    const long = 'y'.repeat(MAX_SUPPLIED_PASSWORD_LENGTH)

    expect(await passwordMatches(long, long)).toBe(true)
  })
})

describe('the comparison itself', () => {
  it('never reveals the secret through a length check', async () => {
    // Two submissions of very different lengths against one secret. Both are
    // hashed to 32 bytes before anything is compared, so neither can be
    // distinguished from the other by the work done — the property the digests
    // exist for. This asserts the observable half: the answer is the same shape.
    const short = await passwordMatches('a', secret)
    const long = await passwordMatches('a'.repeat(500), secret)

    expect([short, long]).toEqual([false, false])
  })

  it('uses timingSafeEqual, which Workers really does provide', () => {
    // Card rule 7. The earlier brief for this work asserted from memory that
    // crypto.subtle.timingSafeEqual is not available in Workers. It is — a
    // documented non-standard extension. If a runtime ever drops it, this fails
    // here rather than turning the comparison into `undefined is not a function`
    // inside the login path.
    expect(typeof crypto.subtle.timingSafeEqual).toBe('function')
  })
})
