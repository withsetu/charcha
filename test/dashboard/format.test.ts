// Owner-facing formatting. The locale is whatever the machine running the tests has,
// so nothing here asserts on wording — only on which scale was chosen, which is the
// decision this module makes.

import { describe, expect, it } from 'vitest'

import { formatAge, formatExact, isoInstant, pageLabel } from '../../src/dashboard/format'

const NOW = 1_700_000_000

describe('formatAge', () => {
  it('uses seconds, minutes, hours and days as the age grows', () => {
    const scales = [30, 90, 3 * 3600, 3 * 86_400].map((ago) => formatAge(NOW - ago, NOW))
    // Four different scales produce four different strings; asserting the words would
    // assert the test machine's locale.
    expect(new Set(scales).size).toBe(4)
  })

  it('switches to an absolute date past a week, where "417 days ago" says nothing', () => {
    const old = NOW - 30 * 86_400
    expect(formatAge(old, NOW)).toBe(formatExact(old))
  })

  it('does not clamp a future timestamp, so clock skew looks like clock skew', () => {
    // A clamped future age reads as a bug in the queue instead of a bug in a clock.
    expect(formatAge(NOW + 180, NOW)).not.toBe(formatAge(NOW - 180, NOW))
  })
})

describe('isoInstant', () => {
  it('is the exact instant, for the datetime attribute', () => {
    expect(isoInstant(NOW)).toBe(new Date(NOW * 1000).toISOString())
  })
})

describe('pageLabel', () => {
  it('prefers the thread title', () => {
    expect(pageLabel('Hello world', '/posts/hello')).toBe('Hello world')
  })

  it('falls back to the page key when there is no title', () => {
    expect(pageLabel(null, '/posts/hello')).toBe('/posts/hello')
  })

  it('treats a blank title as absent, because an empty label reads as "no page"', () => {
    expect(pageLabel('   ', '/posts/hello')).toBe('/posts/hello')
    expect(pageLabel('', '/posts/hello')).toBe('/posts/hello')
  })
})
