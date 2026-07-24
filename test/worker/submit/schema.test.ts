import { describe, expect, it } from 'vitest'
import {
  MAX_AUTHOR_EMAIL_LENGTH,
  MAX_AUTHOR_NAME_LENGTH,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  parseComment,
} from '../../../src/submit/schema'
import { MAX_THREAD_ID_LENGTH, MAX_URL_LENGTH } from '../../../src/page-key'

// The caps here are the same numbers as the migration's CHECK constraints. If they
// drift, a value the boundary accepts becomes a 500 from the database instead of a
// clear 400 to the reader — which is the whole failure card rule 5 exists to stop.
// So these are pinned to the schema values in migrations/0001_initial.sql.
describe('the comment caps match the columns they defend', () => {
  it('mirrors the CHECK constraints exactly', () => {
    expect(MAX_BODY_LENGTH).toBe(10_000)
    expect(MAX_AUTHOR_NAME_LENGTH).toBe(80)
    expect(MAX_AUTHOR_EMAIL_LENGTH).toBe(254)
    expect(MAX_TITLE_LENGTH).toBe(300)
  })
})

function ok(input: unknown) {
  const result = parseComment(input)
  if (!result.ok) throw new Error(`expected valid, got: ${result.message}`)
  return result.value
}

function rejected(input: unknown) {
  const result = parseComment(input)
  if (result.ok) throw new Error('expected rejection, got a valid comment')
  return result.message
}

describe('parseComment — what a valid submission produces', () => {
  it('accepts a minimal comment: a name and a body', () => {
    const value = ok({ authorName: 'Rahul Kanwar', body: 'The export is the hard part.' })

    expect(value.authorName).toBe('Rahul Kanwar')
    expect(value.body).toBe('The export is the hard part.')
  })

  it('trims the name and the body, and stores what it validated', () => {
    const value = ok({ authorName: '  Maya  ', body: '  hello  ' })

    expect(value.authorName).toBe('Maya')
    expect(value.body).toBe('hello')
  })

  it('carries the optional fields through when present', () => {
    const value = ok({
      authorName: 'Priya',
      body: 'a reply',
      authorEmail: 'priya@example.com',
      parentId: 42,
      url: 'https://maya.build/notes/leaving',
      thread: 'leaving',
      title: 'Leaving the comment industry',
    })

    expect(value.authorEmail).toBe('priya@example.com')
    expect(value.parentId).toBe(42)
    expect(value.url).toBe('https://maya.build/notes/leaving')
    expect(value.thread).toBe('leaving')
    expect(value.title).toBe('Leaving the comment industry')
  })

  it('drops anti-spam transport and any other unknown keys rather than rejecting them', () => {
    // The embed sends a honeypot and a form-load timestamp alongside the comment.
    // Those are #8's, not the comment's, so the schema strips them — a strict
    // schema would 400 every real submission the embed makes.
    const value = ok({ authorName: 'Maya', body: 'hi', hp: 'gotcha', t: 1_753_300_000 })

    expect(Object.keys(value)).not.toContain('hp')
    expect(Object.keys(value)).not.toContain('t')
  })
})

describe('parseComment — empty optionals read as absent, not as errors', () => {
  it('treats an empty email as no email, so a blank field is not an error', () => {
    const value = ok({ authorName: 'Maya', body: 'hi', authorEmail: '' })

    expect(value.authorEmail).toBeUndefined()
  })

  it('treats an empty title as no title', () => {
    const value = ok({ authorName: 'Maya', body: 'hi', title: '   ' })

    expect(value.title).toBeUndefined()
  })
})

describe('parseComment — the rejections, each with a reader-facing message', () => {
  it('requires a body', () => {
    expect(rejected({ authorName: 'Maya' })).toMatch(/comment is required/i)
    expect(rejected({ authorName: 'Maya', body: '   ' })).toMatch(/comment is required/i)
  })

  it('rejects a body past the column limit before the database can', () => {
    const message = rejected({ authorName: 'Maya', body: 'x'.repeat(MAX_BODY_LENGTH + 1) })
    expect(message).toMatch(/too long/i)
    expect(message).toContain('10,000')
  })

  it('accepts a body exactly at the limit', () => {
    const value = ok({ authorName: 'Maya', body: 'x'.repeat(MAX_BODY_LENGTH) })
    expect(value.body).toHaveLength(MAX_BODY_LENGTH)
  })

  it('requires a name', () => {
    expect(rejected({ body: 'hi' })).toMatch(/name is required/i)
    expect(rejected({ authorName: '   ', body: 'hi' })).toMatch(/name is required/i)
  })

  it('rejects a name past the column limit', () => {
    const message = rejected({ authorName: 'a'.repeat(MAX_AUTHOR_NAME_LENGTH + 1), body: 'hi' })
    expect(message).toMatch(/name is too long/i)
  })

  it('rejects an email that is not an email', () => {
    expect(rejected({ authorName: 'Maya', body: 'hi', authorEmail: 'not-an-email' })).toMatch(
      /email address is not valid/i,
    )
  })

  it('rejects an email past the column limit even if it is otherwise valid', () => {
    const local = 'a'.repeat(MAX_AUTHOR_EMAIL_LENGTH)
    const message = rejected({ authorName: 'Maya', body: 'hi', authorEmail: `${local}@x.com` })
    expect(message).toMatch(/email address/i)
  })

  it('rejects a non-integer or non-positive parent id', () => {
    expect(rejected({ authorName: 'Maya', body: 'hi', parentId: -1 })).toMatch(/reply/i)
    expect(rejected({ authorName: 'Maya', body: 'hi', parentId: 1.5 })).toMatch(/reply/i)
    expect(rejected({ authorName: 'Maya', body: 'hi', parentId: 'x' })).toMatch(/reply/i)
  })

  it('rejects a url longer than the column, without trying to parse it', () => {
    const message = rejected({
      authorName: 'Maya',
      body: 'hi',
      url: `https://x.test/${'a'.repeat(MAX_URL_LENGTH)}`,
    })
    expect(message).toMatch(/address is too long/i)
  })

  it('rejects a thread override longer than its column', () => {
    const message = rejected({
      authorName: 'Maya',
      body: 'hi',
      thread: 'a'.repeat(MAX_THREAD_ID_LENGTH + 1),
    })
    expect(message).toMatch(/thread/i)
  })

  it('rejects a title longer than its column', () => {
    const message = rejected({
      authorName: 'Maya',
      body: 'hi',
      title: 'a'.repeat(MAX_TITLE_LENGTH + 1),
    })
    expect(message).toMatch(/title is too long/i)
  })

  it('rejects a body that is not a string, without leaking a type-machinery message', () => {
    const message = rejected({ authorName: 'Maya', body: 12345 })
    expect(message).toMatch(/comment is required/i)
    expect(message).not.toMatch(/expected string/i)
  })

  it('rejects a payload that is not an object at all', () => {
    expect(rejected('a string body').length).toBeGreaterThan(0)
    expect(rejected(null).length).toBeGreaterThan(0)
    expect(rejected([]).length).toBeGreaterThan(0)
  })
})
