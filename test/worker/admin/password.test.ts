import { describe, expect, it } from 'vitest'
import {
  MAX_SUPPLIED_PASSWORD_LENGTH,
  MIN_DASHBOARD_PASSWORD_LENGTH,
  dashboardPasswordIsShort,
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

describe('whether the configured password clears the length floor (#120)', () => {
  // An advisory and never a gate. The proof that it is never a gate is two tests down,
  // in "the comparison itself", and end to end in test/worker/admin/setup.test.ts.

  it('calls one character under the floor short', () => {
    expect(dashboardPasswordIsShort('x'.repeat(MIN_DASHBOARD_PASSWORD_LENGTH - 1))).toBe(true)
  })

  it('calls exactly the floor long enough, so the boundary is not off by one', () => {
    expect(dashboardPasswordIsShort('x'.repeat(MIN_DASHBOARD_PASSWORD_LENGTH))).toBe(false)
  })

  it('calls a four-character one short — the case #120 is named after', () => {
    expect(dashboardPasswordIsShort('abcd')).toBe(true)
  })

  it('calls the generated value the deploy form recommends long enough', () => {
    // `openssl rand -base64 24` is 24 bytes as base64, which is 32 characters — so the
    // length asserted here is 32 and not `secret`'s 24. If the floor ever rose above
    // what this project's own instruction produces, that is a contradiction worth
    // failing on, and this is where it would fail.
    const generated = 'm3K9vQrT8xL2wZ7pB4nC6jH1dF5sA0gY'

    expect(generated).toHaveLength(32)
    expect(dashboardPasswordIsShort(generated)).toBe(false)
  })

  it('counts characters, not UTF-16 code units', () => {
    // Fourteen astral characters are 28 code units and 14 characters. A `.length`
    // floor waves this through while calling a 14-character ASCII password short —
    // two answers for the same password by any measure a person uses.
    expect(dashboardPasswordIsShort('🔒'.repeat(MIN_DASHBOARD_PASSWORD_LENGTH - 1))).toBe(true)
    expect(dashboardPasswordIsShort('🔒'.repeat(MIN_DASHBOARD_PASSWORD_LENGTH))).toBe(false)
  })

  it('measures the value that would actually be compared, so padding cannot inflate it', () => {
    // usableDashboardPassword trims, so the credential really is the trimmed string.
    // Measuring the untrimmed one would call a four-character password padded to
    // sixteen with spaces "long enough" — about the one input a hurried deployer
    // produces by accident.
    expect(dashboardPasswordIsShort(`${' '.repeat(6)}abcd${' '.repeat(6)}\n`)).toBe(true)
  })

  it('says nothing about a deployment that has no password at all', () => {
    // Unset is absent, not short — a different and harder state, already failed closed
    // on in src/admin/env.ts, and one no caller of this can be reached in.
    expect(dashboardPasswordIsShort(undefined)).toBe(false)
    expect(dashboardPasswordIsShort('')).toBe(false)
    expect(dashboardPasswordIsShort('   \n ')).toBe(false)
  })

  it('is the floor NIST states for a single-factor password', () => {
    // https://pages.nist.gov/800-63-4/sp800-63b.html, checked 2026-07-29: "Verifiers
    // and CSPs SHALL require passwords that are used as a single-factor authentication
    // mechanism to be a minimum of 15 characters in length." This dashboard has no
    // second factor, so that is the applicable clause rather than the eight-character
    // one beside it. Pinned so that moving the number is a deliberate act.
    expect(MIN_DASHBOARD_PASSWORD_LENGTH).toBe(15)
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

  it('is refused when longer than the cap', async () => {
    expect(await passwordMatches('x'.repeat(MAX_SUPPLIED_PASSWORD_LENGTH + 1), secret)).toBe(false)
  })

  it('still accepts a real password at exactly the cap', async () => {
    const long = 'y'.repeat(MAX_SUPPLIED_PASSWORD_LENGTH)

    expect(await passwordMatches(long, long)).toBe(true)
  })
})

describe('the work an over-long submission can ask for', () => {
  // The cap cannot change the *answer* — a 1,025-character value is not the secret
  // either way — so asserting only the answer tests it not at all, which the
  // kill-shot on card rule 6 proved by removing it without a single test noticing.
  // What it changes is whether a caller's own bytes reach SHA-256, so that is what
  // is counted, with a control showing the counter can move.

  async function digests(supplied: string): Promise<number> {
    const real = crypto.subtle.digest.bind(crypto.subtle)
    const subtle = crypto.subtle as unknown as { digest: typeof crypto.subtle.digest }
    let calls = 0
    subtle.digest = (...args: Parameters<typeof crypto.subtle.digest>) => {
      calls += 1
      return real(...args)
    }

    try {
      await passwordMatches(supplied, secret)
    } finally {
      subtle.digest = real
    }
    return calls
  }

  it('is not hashed at all when it is past the cap', async () => {
    expect(await digests('x'.repeat(MAX_SUPPLIED_PASSWORD_LENGTH + 1))).toBe(0)
  })

  it('is hashed when it is inside the cap, so the count above is about the cap', async () => {
    expect(await digests('x'.repeat(MAX_SUPPLIED_PASSWORD_LENGTH))).toBeGreaterThan(0)
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

  it('accepts a four-character password, and always will — #120', async () => {
    // **Both halves of the credential path, because a floor would be written in the
    // first one.** `usableDashboardPassword` is the shared helper every authenticator
    // reads (src/admin/authenticate.ts), and returning `null` there for a short secret
    // is the obvious, wrong fix — it would 401 every deployment already running on one,
    // with no reset, no second factor and no account to recover through. Asserting only
    // the comparison would miss that entirely, which a kill-shot confirmed.
    //
    // This is the unit-level half. The end-to-end proof — a real login and a working
    // session on a four-character password — is test/worker/admin/setup.test.ts.
    expect(usableDashboardPassword('abcd')).toBe('abcd')
    expect(await passwordMatches('abcd', 'abcd')).toBe(true)
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
