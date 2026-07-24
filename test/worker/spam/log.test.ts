// CLAUDE.md requires this: a spam layer that mis-classifies quietly is invisible.
// The counter-requirement is that the record must not itself become the leak — no
// comment body, no email, no IP, and no IP-derived hash, because logs are not
// covered by the ip_hash retention sweep (#19).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HONEYPOT_FIELD } from '../../../src/spam/fields'
import { announceOnce } from '../../../src/spam/log'
import { createSpamCheck } from '../../../src/spam'
import { contextFor, validBody } from './context'

let lines: string[] = []

beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('what a spam decision writes to the log', () => {
  it('records the layer that fired and the reason, as one structured line', async () => {
    const check = createSpamCheck({})

    await check.check(contextFor({ form: { [HONEYPOT_FIELD]: 'filled' } }))

    const record = lines.map((line) => JSON.parse(line) as Record<string, unknown>).at(-1)
    expect(record?.event).toBe('spam_verdict')
    expect(record?.action).toBe('reject')
    expect(record?.layer).toBe('honeypot')
    expect(typeof record?.reason).toBe('string')
  })

  it('records the page, so a flood against one thread is visible in the logs', async () => {
    const check = createSpamCheck({})

    await check.check(
      contextFor({ form: { [HONEYPOT_FIELD]: 'filled' }, pageKey: '/notes/leaving' }),
    )

    const record = lines.map((line) => JSON.parse(line) as Record<string, unknown>).at(-1)
    expect(record?.pageKey).toBe('/notes/leaving')
  })

  it('never writes the comment body, the author, the email or the IP', async () => {
    const check = createSpamCheck({ IP_HASH_SECRET: 'ip-secret' })

    await check.check(
      contextFor({
        form: { [HONEYPOT_FIELD]: 'filled' },
        body: validBody,
        authorName: 'Rahul Kanwar',
        ip: '198.51.100.7',
      }),
    )

    const written = lines.join('\n')
    expect(written).not.toContain(validBody)
    expect(written).not.toContain('Rahul Kanwar')
    expect(written).not.toContain('198.51.100.7')
    // Not the hash either: an HMAC of an IP is still an identifier for one person,
    // and #19 purges it from the database on a window that log retention ignores.
    expect(written).not.toMatch(/[0-9a-f]{32,}/)
  })

  it('writes a fact about the deployment once per isolate, not once per comment', () => {
    // "Turnstile is not configured here" is worth knowing exactly once and worth
    // nothing repeated on every submission — but it is the only way a site owner
    // who put the secret in the wrong place finds out layer 3 is not running.
    announceOnce('a-key-only-this-test-uses', { event: 'spam_config', layer: 'example' })
    announceOnce('a-key-only-this-test-uses', { event: 'spam_config', layer: 'example' })

    expect(lines.filter((line) => line.includes('a-key-only-this-test-uses'))).toHaveLength(0)
    expect(lines.filter((line) => line.includes('"layer":"example"'))).toHaveLength(1)
  })

  it('says nothing about a comment every layer allowed', async () => {
    // One line per rejected or held comment is a signal. One line per comment is
    // an invoice — Workers logs are metered, and the allowed case is the common one.
    const check = createSpamCheck({})

    await check.check(contextFor({ form: { [HONEYPOT_FIELD]: '', t: 31_000 } }))

    expect(lines.filter((line) => line.includes('spam_verdict'))).toHaveLength(0)
  })
})
