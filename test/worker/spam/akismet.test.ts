// The Akismet adapter (#11). Nothing here reaches Akismet: every test injects a
// `fetch`, and no test carries a key that would work anywhere.
//
// Two things are being pinned. **What is sent**, field by field, because that list
// is the disclosure the site owner has to repeat to their readers — a field that
// arrives here by accident is a promise quietly broken. And **what an answer we
// cannot use costs**, because a metered third party that is down, suspended or
// misconfigured must never be a reason a real person loses their comment.
//
// What layer 7 *says about itself* is asserted in
// test/worker/spam/akismet-announcements.test.ts instead, for the reason that file
// gives: `announceOnce` memoises per isolate, so a line written here would be
// suppressed there and every absence assertion would pass without meaning anything.

import { describe, expect, it, vi } from 'vitest'
import {
  AKISMET_COMMENT_CHECK_URL,
  AKISMET_TIMEOUT_MS,
  AKISMET_USER_AGENT,
  MAX_CONNECTION_FIELD_LENGTH,
  akismetProvider,
} from '../../../src/spam/akismet'
import type { ProviderSubmission } from '../../../src/spam/provider'

const apiKey = 'not-a-real-key'
const siteUrl = 'https://maya.build'

function submission(overrides: Partial<ProviderSubmission> = {}): ProviderSubmission {
  return {
    authorName: 'Rahul Kanwar',
    body: 'The part people underestimate is the export.',
    kind: 'comment',
    ip: '203.0.113.9',
    userAgent: 'Mozilla/5.0 (test)',
    referrer: 'https://maya.build/notes',
    permalink: 'https://maya.build/notes/leaving',
    siteUrl,
    now: 1_753_300_000,
    ...overrides,
  }
}

/** Answers with `body`, and records every request it was given. */
function answering(body: string, init: ResponseInit = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetchImpl: typeof fetch = (input, requestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      init: requestInit,
    })
    return Promise.resolve(new Response(body, init))
  }
  return { calls, fetchImpl }
}

/** The form fields of the single request that was made. */
function sentFields(calls: { init: RequestInit | undefined }[]): URLSearchParams {
  const body = calls[0]?.init?.body
  if (typeof body !== 'string') throw new Error('expected a urlencoded string body')
  return new URLSearchParams(body)
}

describe('configuration', () => {
  it('is off when neither the key nor the site URL is set', () => {
    expect(akismetProvider({})).toBeNull()
  })

  it('is off when only one half is set', () => {
    // #104's lesson: half a configuration is the state an owner cannot see. It must
    // not turn the layer on. That it is not silent either is
    // test/worker/spam/akismet-announcements.test.ts.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(akismetProvider({ apiKey })).toBeNull()
    expect(akismetProvider({ siteUrl })).toBeNull()

    log.mockRestore()
  })

  it('is on when both halves are set', () => {
    expect(akismetProvider({ apiKey, siteUrl })?.name).toBe('akismet')
  })

  it('refuses a site URL that is not an absolute http(s) URL', () => {
    // `blog` is a required Akismet parameter and the identity of the site in the
    // owner's account. A value that is not a URL cannot become one, and a layer
    // built on it would spend a metered check per comment to be told `invalid`.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    // A bare host does not parse; `javascript:` parses with no hostname. **`ftp:`
    // is the one that isolates the scheme check** — it parses, it has a hostname,
    // and only the protocol allowlist refuses it. Without it, deleting that
    // allowlist broke nothing, which a kill-shot found.
    expect(akismetProvider({ apiKey, siteUrl: 'maya.build' })).toBeNull()
    expect(akismetProvider({ apiKey, siteUrl: 'javascript:alert(1)' })).toBeNull()
    expect(akismetProvider({ apiKey, siteUrl: 'ftp://maya.build' })).toBeNull()

    log.mockRestore()
  })
})

describe('what is sent to Akismet, and what is not', () => {
  it('posts urlencoded to the documented endpoint, with a client user agent', async () => {
    const { calls, fetchImpl } = answering('false')
    await akismetProvider({ apiKey, siteUrl, fetch: fetchImpl })?.check(submission())

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(AKISMET_COMMENT_CHECK_URL)
    expect(calls[0]?.init?.method).toBe('POST')
    const headers = new Headers(calls[0]?.init?.headers)
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(headers.get('user-agent')).toBe(AKISMET_USER_AGENT)
  })

  it('sends exactly the documented fields it means to, and no others', async () => {
    // This list IS the disclosure in README.md and .dev.vars.example. If it grows,
    // that text is wrong and a site owner's privacy notice is wrong with it.
    const { calls, fetchImpl } = answering('false')
    await akismetProvider({ apiKey, siteUrl, fetch: fetchImpl })?.check(
      submission({ authorEmail: 'rahul@example.com' }),
    )

    const fields = sentFields(calls)
    expect([...fields.keys()].sort()).toEqual([
      'api_key',
      'blog',
      'comment_author',
      'comment_author_email',
      'comment_content',
      'comment_date_gmt',
      'comment_type',
      'permalink',
      'referrer',
      'user_agent',
      'user_ip',
    ])
    expect(fields.get('blog')).toBe(siteUrl)
    expect(fields.get('user_ip')).toBe('203.0.113.9')
    expect(fields.get('comment_author')).toBe('Rahul Kanwar')
    expect(fields.get('comment_author_email')).toBe('rahul@example.com')
    expect(fields.get('comment_content')).toBe('The part people underestimate is the export.')
    expect(fields.get('comment_type')).toBe('comment')
    // Unix seconds in, ISO 8601 out — `comment_date_gmt` is documented as a UTC
    // timestamp, and the pipeline's clock is in seconds.
    expect(fields.get('comment_date_gmt')).toBe('2025-07-23T19:46:40.000Z')
  })

  it('omits every field the submission does not have, rather than sending a blank', async () => {
    const { calls, fetchImpl } = answering('false')
    await akismetProvider({ apiKey, siteUrl, fetch: fetchImpl })?.check(
      submission({ userAgent: null, referrer: null, permalink: null }),
    )

    const fields = sentFields(calls)
    expect([...fields.keys()].sort()).toEqual([
      'api_key',
      'blog',
      'comment_author',
      'comment_content',
      'comment_date_gmt',
      'comment_type',
      'user_ip',
    ])
  })

  it('never sends is_test or user_role, which would make every answer a lie', async () => {
    const { calls, fetchImpl } = answering('false')
    await akismetProvider({ apiKey, siteUrl, fetch: fetchImpl })?.check(submission())

    const fields = sentFields(calls)
    expect(fields.has('is_test')).toBe(false)
    expect(fields.has('user_role')).toBe(false)
  })

  it('caps the two fields a caller controls the length of', async () => {
    // `user_agent` and `referrer` come off request headers, which the schema never
    // sees and never caps. Without this, one submission makes the Worker POST
    // whatever a caller chose to put in a header — outbound amplification on the
    // public write endpoint. The comment body is capped by src/submit/schema.ts.
    const { calls, fetchImpl } = answering('false')
    await akismetProvider({ apiKey, siteUrl, fetch: fetchImpl })?.check(
      submission({ userAgent: 'u'.repeat(9_000), referrer: 'r'.repeat(9_000) }),
    )

    const fields = sentFields(calls)
    expect(fields.get('user_agent')?.length).toBe(MAX_CONNECTION_FIELD_LENGTH)
    expect(fields.get('referrer')?.length).toBe(MAX_CONNECTION_FIELD_LENGTH)
  })

  it('spends nothing at all when there is no IP to send', async () => {
    // `user_ip` is one of Akismet's three required parameters, so a submission
    // without one cannot produce a usable answer — and a metered check spent to be
    // told so is a check the site owner paid for nothing.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { calls, fetchImpl } = answering('true')
    const verdict = await akismetProvider({ apiKey, siteUrl, fetch: fetchImpl })?.check(
      submission({ ip: null }),
    )

    expect(calls).toHaveLength(0)
    expect(verdict).toBe('unknown')
    log.mockRestore()
  })
})

describe('reading Akismet back', () => {
  it('reads "false" as ham', async () => {
    const { fetchImpl } = answering('false')
    expect(await akismetProvider({ apiKey, siteUrl, fetch: fetchImpl })?.check(submission())).toBe(
      'ham',
    )
  })

  it('reads "true" as spam', async () => {
    const { fetchImpl } = answering('true')
    expect(await akismetProvider({ apiKey, siteUrl, fetch: fetchImpl })?.check(submission())).toBe(
      'spam',
    )
  })

  it('reads the pro-tip discard header as blatant spam, and still not as a reject', async () => {
    const { fetchImpl } = answering('true', { headers: { 'x-akismet-pro-tip': 'discard' } })
    expect(await akismetProvider({ apiKey, siteUrl, fetch: fetchImpl })?.check(submission())).toBe(
      'blatant-spam',
    )
  })

  it('reads "invalid" as no answer', async () => {
    // An expired subscription, a suspended key or a site Akismet does not recognise
    // all land here. Every one of them is the owner's problem to fix and none of
    // them is the commenter's to pay for. What the owner is *told* is
    // test/worker/spam/akismet-announcements.test.ts.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { fetchImpl } = answering('invalid', {
      headers: { 'x-akismet-debug-help': 'Empty "blog" value' },
    })

    expect(await akismetProvider({ apiKey, siteUrl, fetch: fetchImpl })?.check(submission())).toBe(
      'unknown',
    )
    log.mockRestore()
  })

  it('still reads the verdict when an alert header rides alongside it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { fetchImpl } = answering('true', {
      headers: {
        'x-akismet-alert-code': '10402',
        'x-akismet-alert-msg': 'API key suspended for non-payment',
      },
    })

    expect(await akismetProvider({ apiKey, siteUrl, fetch: fetchImpl })?.check(submission())).toBe(
      'spam',
    )
    log.mockRestore()
  })

  it('reads an unexpected body as no answer', async () => {
    const { fetchImpl } = answering('<html>maintenance</html>')
    expect(await akismetProvider({ apiKey, siteUrl, fetch: fetchImpl })?.check(submission())).toBe(
      'unknown',
    )
  })

  it('reads a non-2xx as no answer', async () => {
    const { fetchImpl } = answering('true', { status: 503 })
    expect(await akismetProvider({ apiKey, siteUrl, fetch: fetchImpl })?.check(submission())).toBe(
      'unknown',
    )
  })
})

describe('when Akismet cannot answer at all', () => {
  it('abstains rather than holding the comment when the call fails', async () => {
    // Fail open, and further open than layer 3 does. A `review` here would put a
    // third party's name on a comment that third party never saw, and layer 7 is
    // the last layer — there is nothing after it for a bypass to skip.
    const failing: typeof fetch = () => Promise.reject(new Error('down'))
    expect(await akismetProvider({ apiKey, siteUrl, fetch: failing })?.check(submission())).toBe(
      'unknown',
    )
  })

  it('gives up on a slow Akismet rather than making the reader wait', async () => {
    const never: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    const provider = akismetProvider({ apiKey, siteUrl, fetch: never, timeoutMs: 1 })

    expect(await provider?.check(submission())).toBe('unknown')
  })

  it('bounds the wait with an AbortSignal on every call', async () => {
    const { calls, fetchImpl } = answering('false')
    await akismetProvider({ apiKey, siteUrl, fetch: fetchImpl })?.check(submission())

    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
    expect(AKISMET_TIMEOUT_MS).toBeLessThanOrEqual(5_000)
  })
})
