// The API client. Two properties matter more than the rest:
//
//   - it never throws, whatever the network or the server does, because a rejection
//     here becomes a spinner that never stops;
//   - every request is relative and same-origin, because that is what makes the
//     browser send an `Origin` the CSRF check in src/admin/csrf.ts accepts and what
//     makes the `Path=/admin` cookie ride along at all.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decide, readQueue, readSession, signIn, signOut } from '../../src/dashboard/api'

interface Call {
  url: string
  init: RequestInit
}

let calls: Call[]

function answer(status: number, body: unknown, contentType = 'application/json'): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  })
}

function stubFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      // Never `String(input)`: on a `Request` that records `[object Object]`, and every
      // path assertion below would pass or fail for a reason nothing explains.
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, init })
      return Promise.resolve(responder(url, init))
    }),
  )
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('every request', () => {
  it('is relative, so the browser sets the Origin the server will accept', () => {
    // An absolute URL to this origin would work; one to any other would be refused by
    // src/admin/csrf.ts, and there is deliberately no OPTIONS route to preflight it.
    // Relative is the form that cannot be wrong.
    stubFetch(() => answer(200, { authenticated: true, via: 'session' }))
    void readSession()
    expect(calls[0]?.url.startsWith('/admin/api/')).toBe(true)
    expect(calls[0]?.url).not.toContain('://')
  })

  it('carries the same-origin credentials the Path=/admin cookie needs', () => {
    stubFetch(() => answer(200, { authenticated: true, via: 'session' }))
    void readSession()
    expect(calls[0]?.init.credentials).toBe('same-origin')
  })

  it('is never read from a cache, matching the no-store the server sets', () => {
    stubFetch(() => answer(200, { comments: [], nextCursor: null }))
    void readQueue('pending')
    expect(calls[0]?.init.cache).toBe('no-store')
  })

  it('sends JSON only when there is a body, and never sets Origin itself', () => {
    stubFetch(() => answer(200, { authenticated: true, via: 'session' }))
    void signIn('hunter2')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('origin')
    expect(calls[0]?.init.body).toBe(JSON.stringify({ password: 'hunter2' }))
  })
})

describe('the endpoints', () => {
  it('reads a queue page and passes a cursor straight back', async () => {
    stubFetch(() => answer(200, { comments: [], nextCursor: '1699999998.2' }))
    const first = await readQueue('spam')
    expect(calls[0]?.url).toBe('/admin/api/queue?status=spam')
    expect(first).toEqual({ ok: true, value: { comments: [], nextCursor: '1699999998.2' } })

    await readQueue('spam', '1699999998.2')
    // Encoded, not assembled: src/db's parseQueueCursor rejects rather than clamps, so
    // a cursor this client had built would 400 the day the encoding changed.
    expect(calls[1]?.url).toBe('/admin/api/queue?status=spam&cursor=1699999998.2')
  })

  it('posts one decision per comment', async () => {
    stubFetch(() => answer(200, { id: 12, status: 'spam', moderatedAt: 5 }))
    const result = await decide(12, 'spam')
    expect(calls[0]?.url).toBe('/admin/api/comments/12/status')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.body).toBe(JSON.stringify({ status: 'spam' }))
    expect(result).toEqual({ ok: true, value: { id: 12, status: 'spam', moderatedAt: 5 } })
  })

  it('accepts the 204 that signing out answers, without trying to read a body', async () => {
    stubFetch(() => new Response(null, { status: 204 }))
    expect(await signOut()).toEqual({ ok: true, value: undefined })
    expect(calls[0]?.init.method).toBe('DELETE')
  })
})

describe('failures', () => {
  it('reads the {error:{code,message}} shape the server guarantees', async () => {
    stubFetch(() =>
      answer(401, { error: { code: 'UNAUTHORIZED', message: 'Sign in to use the dashboard.' } }),
    )
    expect(await readQueue('pending')).toEqual({
      ok: false,
      failure: {
        code: 'UNAUTHORIZED',
        message: 'Sign in to use the dashboard.',
        status: 401,
      },
    })
  })

  it('keeps the throttle message, which is the one that says what to do next', async () => {
    stubFetch(() =>
      answer(429, {
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many attempts. Wait a minute and try again.',
        },
      }),
    )
    const result = await signIn('nope')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.code).toBe('TOO_MANY_REQUESTS')
      expect(result.failure.message).toContain('Wait a minute')
    }
  })

  it('never throws when fetch rejects, and says the request did not arrive', async () => {
    // The offline case. A rejection escaping here is the loading skeleton that never
    // resolves, which CLAUDE.md names as an unreported failure.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
    const result = await readQueue('pending')
    expect(result).toEqual({
      ok: false,
      failure: {
        code: 'NETWORK',
        message: 'Could not reach the server. Check your connection and try again.',
        status: null,
      },
    })
  })

  it('reports a body that is not JSON as MALFORMED, keeping the status', async () => {
    // A proxy in front of the Worker answering an HTML 502. The status is the only part
    // of it worth showing anyone.
    stubFetch(() => new Response('<html>gateway</html>', { status: 502 }))
    const result = await readQueue('pending')
    expect(result).toEqual({
      ok: false,
      failure: {
        code: 'MALFORMED',
        message: 'The server sent a reply this dashboard could not read.',
        status: 502,
      },
    })
  })

  it('refuses to invent a code from an error body it does not recognise', async () => {
    // A client that trusted `error.code` would branch on a string a proxy chose.
    stubFetch(() => answer(403, { error: { code: 'TEAPOT', message: 'no' } }))
    const result = await readQueue('pending')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('MALFORMED')
  })

  it.each([
    ['a null error', { error: null }],
    ['no error key at all', { nope: true }],
    ['an empty message', { error: { code: 'FORBIDDEN', message: '' } }],
  ])('reports %s as MALFORMED rather than crashing', async (_name, body) => {
    stubFetch(() => answer(400, body))
    const result = await readQueue('pending')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('MALFORMED')
  })
})
