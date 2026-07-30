// What layer 8 says about itself (#11).
//
// Layer 8 is opt-in and off by default, which makes its failure modes invisible in
// a way no other layer's are: a site owner who paid for Akismet and whose key has
// been suspended sees exactly what a working layer with no opinion looks like —
// nothing. Every path here abstains, so the log line is the *only* signal.
//
// **A separate file on purpose**, following
// test/worker/spam/turnstile-announcements.test.ts: `announceOnce` memoises per
// isolate (src/spam/log.ts), so a line emitted by akismet.test.ts would be
// suppressed here and every absence assertion below would pass without meaning
// anything. A file of its own is a module graph of its own, and therefore a cold
// announcement set.
//
// Order matters within the file for the same reason: the assertion that a working
// deployment says nothing has to run before the lines it asserts the absence of
// have ever been written.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { akismetProvider } from '../../../src/spam/akismet'
import type { ProviderSubmission } from '../../../src/spam/provider'

const apiKey = 'not-a-real-key'
const siteUrl = 'https://maya.build'

let lines: string[] = []

/**
 * Every line this file has written, across all of its tests, and deliberately never
 * reset. `announceOnce` fires once per isolate, so the last test in the file cannot
 * re-provoke the announcements the earlier ones consumed — asking `lines` for them
 * would be asking an empty array, and the assertion would pass by measuring nothing.
 */
const everyLine: string[] = []

function announcements(from: string[] = lines): Array<Record<string, unknown>> {
  return from
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return {}
      }
    })
    .filter((record) => record.event === 'spam_config' && record.layer === 'provider')
}

function submission(): ProviderSubmission {
  return {
    authorName: 'Rahul Kanwar',
    body: 'The part people underestimate is the export.',
    kind: 'comment',
    ip: '203.0.113.9',
    userAgent: null,
    referrer: null,
    permalink: null,
    siteUrl,
    now: 1_753_300_000,
  }
}

function answering(body: string, init: ResponseInit = {}): typeof fetch {
  return () => Promise.resolve(new Response(body, init))
}

beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(' ')
    lines.push(line)
    everyLine.push(line)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('layer 8 — what it announces', () => {
  it('says nothing at all when nobody has opted in', () => {
    // The default state on every deployment. A line here would be a nag for a
    // feature this project deliberately does not push: it is the only layer that
    // transmits anything about a reader, and off is the right answer for most sites.
    expect(akismetProvider({})).toBeNull()
    expect(announcements()).toEqual([])
  })

  it('says nothing when it is configured and working', async () => {
    const provider = akismetProvider({ apiKey, siteUrl, fetch: answering('false') })
    expect(await provider?.check(submission())).toBe('ham')

    expect(announcements()).toEqual([])
  })

  it('names the missing half when only the key is set', () => {
    expect(akismetProvider({ apiKey })).toBeNull()

    const [line] = announcements()
    expect(line).toMatchObject({ enabled: false, provider: 'akismet' })
    expect(JSON.stringify(line)).toContain('CHARCHA_SITE_URL')
  })

  it('names the missing half when only the site URL is set', () => {
    expect(akismetProvider({ siteUrl })).toBeNull()

    const line = announcements().at(-1)
    expect(JSON.stringify(line)).toContain('AKISMET_API_KEY')
  })

  it('says the site URL is not a URL, rather than failing every check silently', () => {
    expect(akismetProvider({ apiKey, siteUrl: 'maya.build' })).toBeNull()

    const line = announcements().at(-1)
    expect(JSON.stringify(line)).toContain('CHARCHA_SITE_URL')
  })

  it('reports the debug help Akismet sent with an "invalid" answer', async () => {
    // This is the line that tells an owner their key expired. Without it, a
    // suspended subscription and a quiet week are the same observation.
    const provider = akismetProvider({
      apiKey,
      siteUrl,
      fetch: answering('invalid', { headers: { 'x-akismet-debug-help': 'Invalid API key' } }),
    })
    expect(await provider?.check(submission())).toBe('unknown')

    const line = announcements().at(-1)
    expect(line).toMatchObject({ enabled: true, provider: 'akismet' })
    expect(JSON.stringify(line)).toContain('Invalid API key')
  })

  it('reports an alert code and message, which ride alongside a real answer', async () => {
    const provider = akismetProvider({
      apiKey,
      siteUrl,
      fetch: answering('true', {
        headers: {
          'x-akismet-alert-code': '10402',
          'x-akismet-alert-msg': 'API key suspended for non-payment',
        },
      }),
    })
    expect(await provider?.check(submission())).toBe('spam')

    const line = announcements().at(-1)
    expect(JSON.stringify(line)).toContain('10402')
    expect(JSON.stringify(line)).toContain('non-payment')
  })

  it('keys the alert separately from the invalid answer, so neither suppresses the other', () => {
    // Two keys, not one, for the reason src/spam/turnstile.ts gives: a response an
    // attacker can provoke must not be able to silence the one the owner needs. Both
    // keys are constants, so nothing Akismet returns can grow the announcement set.
    //
    // Read from `everyLine`, not `lines` — see its comment. Five distinct problems
    // have been provoked above; a shared key would collapse two of them into one
    // line, and this would count four.
    const kinds = announcements(everyLine).map((line) => line.problem)

    expect(kinds).toHaveLength(5)
    expect(new Set(kinds).size).toBe(5)
  })
})
