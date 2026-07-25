// Issue #104 — what layer 3 says about itself when no token ever arrives.
//
// The reported deployment had TURNSTILE_SECRET_KEY set and no `data-turnstile-sitekey`
// anywhere, so every comment was refused and the only signal was a 403 the reader saw
// and the owner never did. Holding the comment for review fixes the loss; these
// assertions cover the other half, which is the owner being *told*, in terms they can
// act on, without reading the source.
//
// **A separate file on purpose**, following test/worker/spam/rate-limit-announcements.test.ts:
// `announceOnce` memoises per isolate (src/spam/log.ts), so a line emitted by an
// earlier test in turnstile.test.ts would be suppressed here and every absence
// assertion below would pass without meaning anything. A file of its own is a module
// graph of its own, and therefore a cold announcement set.
//
// Order matters within the file for the same reason: the assertion that a *proven*
// deployment says nothing has to run before the line it is asserting the absence of
// has ever been written.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { turnstileLayer, turnstileObservations } from '../../../src/spam/turnstile'
import { contextFor } from './context'

const SECRET = 'test-secret'

let lines: string[] = []

/** The announcements written so far, parsed. */
function announcements(): Array<Record<string, unknown>> {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return {}
      }
    })
    .filter((record) => record.event === 'spam_config' && record.layer === 'turnstile')
}

/** Observations for a deployment that has already proved its widget works. */
function proven() {
  const observations = turnstileObservations()
  observations.recordVerified()
  return observations
}

beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('layer 3 — what it announces when a submission carries no token', () => {
  it('says nothing when the deployment has already verified a token', async () => {
    // A token-less submission on a working deployment is a script, not a
    // misconfiguration, and an owner sent looking for a sitekey they already set is
    // worse served than one told nothing. This runs first so the memoised line it
    // asserts the absence of has not been written by any test above it.
    const layer = turnstileLayer({ secretKey: SECRET, observations: proven() })

    const outcome = await layer.run(contextFor({ form: {} }))

    // Without this the test could pass by never reaching the token-less path at all.
    expect(outcome?.action).toBe('reject')
    expect(announcements()).toEqual([])
  })

  it('tells the owner what to set and where, once, when no token has ever been verified', async () => {
    // The count and the wording in one test, because `announceOnce` memoises: a
    // second test asserting the wording would find the line already suppressed and
    // pass on an empty record.
    const layer = turnstileLayer({ secretKey: SECRET, observations: turnstileObservations() })

    await layer.run(contextFor({ form: {} }))
    await layer.run(contextFor({ form: {} }))
    const outcome = await layer.run(contextFor({ form: {} }))

    expect(outcome?.action).toBe('review')

    // Once per isolate is the whole point: a line per submission on a bricked
    // deployment is an invoice, not a signal.
    expect(announcements()).toHaveLength(1)

    const record = announcements()[0]
    expect(record?.enabled).toBe(true)
    // The three things an owner needs to go from this line to a fix: the attribute
    // they are missing, the secret that is set and is not the problem, and the fact
    // that comments are being held rather than lost. A line that only said "no
    // token" would send them to the secret.
    const written = JSON.stringify(record)
    expect(written).toContain('data-turnstile-sitekey')
    expect(written).toContain('TURNSTILE_SECRET_KEY')
    expect(written).toContain('review')
  })
})
