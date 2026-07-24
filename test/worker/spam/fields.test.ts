// The three transport field names are a contract with the embed (#5): the embed
// builds a form to match them, so renaming one silently disarms a layer on every
// deployment that has not re-fetched embed.js. Frozen here so a rename is a CI
// failure and a deliberate decision, the same way #6 freezes the class names.

import { describe, expect, it } from 'vitest'
import {
  ELAPSED_FIELD,
  HONEYPOT_FIELD,
  TURNSTILE_FIELD,
  readNumber,
  readString,
} from '../../../src/spam/fields'

describe('the embed transport field names', () => {
  it('are exactly the names posted on #8 and #5', () => {
    expect(HONEYPOT_FIELD).toBe('subject')
    expect(ELAPSED_FIELD).toBe('t')
    expect(TURNSTILE_FIELD).toBe('cf-turnstile-response')
  })

  it('keeps the Turnstile field on the name Cloudflare’s own widget injects', () => {
    // https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
    // "an invisible input field with the name cf-turnstile-response is
    // automatically created" — so the embed can serialise the form untouched.
    expect(TURNSTILE_FIELD).toBe('cf-turnstile-response')
  })

  it('never collide with a field the comment schema already owns', () => {
    // src/submit/schema.ts owns body, authorName, authorEmail, parentId, url,
    // thread and title. A transport field sharing one of those names would be
    // silently eaten by validation instead of reaching a layer.
    const owned = ['body', 'authorName', 'authorEmail', 'parentId', 'url', 'thread', 'title']
    for (const field of [HONEYPOT_FIELD, ELAPSED_FIELD, TURNSTILE_FIELD]) {
      expect(owned).not.toContain(field)
    }
  })
})

describe('reading a field out of the raw form', () => {
  it('returns a string field', () => {
    expect(readString({ a: 'x' }, 'a')).toBe('x')
  })

  it('returns undefined for a field that is absent or not a string', () => {
    expect(readString({}, 'a')).toBeUndefined()
    expect(readString({ a: 3 }, 'a')).toBeUndefined()
    expect(readString({ a: null }, 'a')).toBeUndefined()
  })

  it('reads a number, and a numeric string, because a form-encoded client sends strings', () => {
    expect(readNumber({ a: 3 }, 'a')).toBe(3)
    expect(readNumber({ a: '3' }, 'a')).toBe(3)
  })

  it('returns undefined rather than NaN or Infinity for anything that is not a finite number', () => {
    expect(readNumber({ a: 'soon' }, 'a')).toBeUndefined()
    expect(readNumber({ a: Number.NaN }, 'a')).toBeUndefined()
    expect(readNumber({ a: Infinity }, 'a')).toBeUndefined()
    expect(readNumber({ a: '' }, 'a')).toBeUndefined()
    expect(readNumber({ a: null }, 'a')).toBeUndefined()
    expect(readNumber({}, 'a')).toBeUndefined()
  })
})
