import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_BODY_BYTES, renderResult } from '../../../src/submit/route'

const db = env.DB
const origin = 'https://charcha.example'

function post(body: BodyInit, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${origin}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

const valid = JSON.stringify({
  authorName: 'Rahul Kanwar',
  body: 'The export is the hard part.',
  url: 'https://maya.build/notes/leaving',
})

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

describe('renderResult — outcome to HTTP, mapped deliberately', () => {
  it('a published comment is 201 with the comment as HTML', async () => {
    const response = renderResult({
      outcome: 'published',
      html: '<ol class="charcha-comments"></ol>',
    })

    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
    expect(await response.text()).toContain('charcha-comments')
  })

  it('a pending comment is 202 — accepted, awaiting moderation, not the same as published', () => {
    const response = renderResult({
      outcome: 'pending',
      html: '<ol class="charcha-comments"></ol>',
    })

    expect(response.status).toBe(202)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
  })

  it('a validation failure is 400 in plain text, so the reader sees what to fix', async () => {
    const response = renderResult({ outcome: 'invalid', message: 'A name is required.' })

    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toMatch(/text\/plain/)
    expect(await response.text()).toBe('A name is required.')
  })

  it('a spam rejection is 403 in plain text, distinct from both success and a 400', async () => {
    const response = renderResult({
      outcome: 'rejected',
      message: 'This comment could not be posted.',
    })

    expect(response.status).toBe(403)
    expect(await response.text()).toBe('This comment could not be posted.')
  })
})

describe('POST /comments — the happy path over HTTP', () => {
  it('accepts a valid comment as 202 pending and returns its HTML', async () => {
    const response = await post(valid)

    expect(response.status).toBe(202)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
    expect(await response.text()).toContain('The export is the hard part.')

    const stored = await db.prepare('select status from comments').first<{ status: string }>()
    expect(stored?.status).toBe('pending')
  })
})

describe('POST /comments — the pre-parse size guard', () => {
  it('refuses a body past the cap with 413, before Zod or JSON ever run', async () => {
    // A body larger than the cap. It is still valid-looking JSON, so reaching a 413
    // rather than a 400 proves the size guard fired before parsing.
    const huge = JSON.stringify({
      authorName: 'Maya',
      url: 'https://maya.build/x',
      body: 'x'.repeat(MAX_BODY_BYTES + 1_000),
    })
    expect(huge.length).toBeGreaterThan(MAX_BODY_BYTES)

    const response = await post(huge)

    expect(response.status).toBe(413)
    // Nothing was stored — the guard fails closed.
    const count = await db.prepare('select count(*) as n from comments').first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  it('rejects an oversized Content-Length without reading the body at all', async () => {
    // The header claims a size past the cap. The guard must trust the smaller of
    // what it is told and what it reads, and refuse here on the header alone.
    const response = await post('{}', { 'content-length': String(MAX_BODY_BYTES + 1) })

    expect(response.status).toBe(413)
  })

  it('still refuses an oversized body streamed without a Content-Length', async () => {
    // A chunked body carries no Content-Length, so the header check cannot fire.
    // The byte-count of what was actually read is the backstop that must catch it —
    // without it, an attacker drops the header and walks a megabyte straight in.
    const huge = new TextEncoder().encode('x'.repeat(MAX_BODY_BYTES + 1_000))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(huge)
        controller.close()
      },
    })
    const request = new Request(`${origin}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      // Required by the Fetch spec for a streaming request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    // No Content-Length on the request, so only the byte-count backstop can catch it.
    expect(request.headers.has('content-length')).toBe(false)

    const response = await exports.default.fetch(request)

    expect(response.status).toBe(413)
  })
})

describe('POST /comments — malformed input', () => {
  it('answers 400 to a body that is not JSON, without a 500', async () => {
    const response = await post('this is not json{')

    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toMatch(/text\/plain/)
  })

  it('answers 400 to an empty body', async () => {
    const response = await post('')

    expect(response.status).toBe(400)
  })

  it('answers 400 with the specific reason for a missing name', async () => {
    const response = await post(JSON.stringify({ body: 'hi', url: 'https://maya.build/x' }))

    expect(response.status).toBe(400)
    expect(await response.text()).toMatch(/name is required/i)
  })

  it('never leaks an internal message on a validation failure', async () => {
    const response = await post(JSON.stringify({ url: 'https://maya.build/x' }))
    const text = await response.text()

    expect(response.status).toBe(400)
    expect(text).not.toMatch(/zod|undefined|expected string|prepare|d1_/i)
  })
})
