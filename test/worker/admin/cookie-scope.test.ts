// Card rule 8 — "no reader-side cookies, ever" — held as a mechanical property
// rather than as a promise.
//
// The dashboard is the owner's authenticated surface and a session cookie there is
// expected. What must never happen is that cookie being attached to a *reader's*
// request, and the only thing standing between those two is the `Path` attribute.
// So this file takes the real `Set-Cookie` the Worker emits on a real login, and
// runs the browser's own path-match rule over it — the rule from RFC 6265 §5.1.4,
// written out here rather than imported from src, because a test that asked
// src/admin/session.ts whether its own cookie was scoped correctly would prove
// nothing.
//
// It fails if `Path=/admin` ever becomes `Path=/`, or is dropped, or the cookie
// name gains the `__Host-` prefix that would mandate `Path=/`.

import { exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_COOKIE_NAME } from '../../../src/admin/session'
import { TEST_PASSWORD, configurePassword, restoreLimiter, stubLimiter } from './env'

const origin = 'https://charcha.example'

interface ParsedCookie {
  name: string
  value: string
  path: string
  attributes: Set<string>
}

/**
 * The Set-Cookie header, as a browser would read it. `Path` is taken as sent;
 * an absent `Path` becomes the default-path (RFC 6265 §5.1.4), which for a cookie
 * set from `/admin/api/session` would be `/admin/api` — still not `/`, which is why
 * the assertions below check the attribute is actually present rather than relying
 * on the default to save them.
 */
function parseSetCookie(header: string, requestPath: string): ParsedCookie {
  const [pair, ...rest] = header.split(';')
  const separator = (pair as string).indexOf('=')
  const attributes = new Set<string>()
  let path: string | null = null

  for (const attribute of rest) {
    const trimmed = attribute.trim()
    const equals = trimmed.indexOf('=')
    const key = (equals === -1 ? trimmed : trimmed.slice(0, equals)).toLowerCase()
    if (key === 'path') path = trimmed.slice(equals + 1)
    else attributes.add(key)
  }

  return {
    name: (pair as string).slice(0, separator),
    value: (pair as string).slice(separator + 1),
    path: path ?? defaultPath(requestPath),
    attributes,
  }
}

/** RFC 6265 §5.1.4, the default-path algorithm. */
function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith('/')) return '/'
  const lastSlash = requestPath.lastIndexOf('/')
  return lastSlash === 0 ? '/' : requestPath.slice(0, lastSlash)
}

/**
 * RFC 6265 §5.1.4, the path-match algorithm. This is the browser's rule, and it is
 * the whole of what keeps the owner's cookie off a reader's request.
 */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  if (cookiePath.endsWith('/')) return true
  return requestPath[cookiePath.length] === '/'
}

let cookie: ParsedCookie

beforeEach(async () => {
  configurePassword(TEST_PASSWORD)
  stubLimiter(true)

  const loginPath = '/admin/api/session'
  const response = await exports.default.fetch(`${origin}${loginPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  })
  const header = response.headers.get('set-cookie')
  if (header === null) throw new Error('the login set no cookie')
  cookie = parseSetCookie(header, loginPath)
})

afterEach(() => {
  restoreLimiter()
  configurePassword(TEST_PASSWORD)
})

describe('the session cookie and the reader-facing endpoints', () => {
  it('is not sent to GET /comments — the read the embed makes on every page view', () => {
    expect(pathMatches('/comments', cookie.path)).toBe(false)
  })

  it('is not sent to POST /comments either', () => {
    expect(pathMatches('/comments', cookie.path)).toBe(false)
  })

  it('is not sent to the composer preview', () => {
    expect(pathMatches('/comments/preview', cookie.path)).toBe(false)
  })

  it('is not sent to the embed script, which every reader downloads', () => {
    expect(pathMatches('/embed.js', cookie.path)).toBe(false)
  })

  it('is not sent to the health endpoint', () => {
    expect(pathMatches('/health', cookie.path)).toBe(false)
  })

  it('is not sent to the origin root', () => {
    expect(pathMatches('/', cookie.path)).toBe(false)
  })

  it('is not sent to a path that merely starts with the same letters', () => {
    expect(pathMatches('/administration', cookie.path)).toBe(false)
  })
})

describe('the session cookie and the dashboard', () => {
  // The other half. A cookie that reached nothing would also pass every test above.

  it('is sent to the dashboard itself', () => {
    expect(pathMatches('/admin', cookie.path)).toBe(true)
  })

  it('is sent to the dashboard with a trailing slash', () => {
    expect(pathMatches('/admin/', cookie.path)).toBe(true)
  })

  it('is sent to the queue endpoint', () => {
    expect(pathMatches('/admin/api/queue', cookie.path)).toBe(true)
  })

  it('is sent to the moderation endpoint', () => {
    expect(pathMatches('/admin/api/comments/1/status', cookie.path)).toBe(true)
  })
})

describe('the scope, as the Worker actually sends it', () => {
  it('is Path=/admin, not the default-path this login would otherwise have got', () => {
    expect(cookie.path).toBe('/admin')
  })

  it('is the cookie the dashboard authenticates with', () => {
    expect(cookie.name).toBe(SESSION_COOKIE_NAME)
  })

  it('carries a token, not an empty value', () => {
    expect(cookie.value.length).toBeGreaterThan(10)
  })

  it('is not __Host-, which browsers would only accept at Path=/', () => {
    expect(cookie.name.startsWith('__Host-')).toBe(false)
  })

  it('still carries every other flag', () => {
    expect(cookie.attributes.has('httponly')).toBe(true)
    expect(cookie.attributes.has('secure')).toBe(true)
  })
})

describe('the reader-facing read, driven for real', () => {
  it('is answered without the Worker ever asking for a cookie', async () => {
    // Belt to the path-match braces: the read path emits no Set-Cookie of its own,
    // so there is nothing for a reader's browser to store in the first place.
    const response = await exports.default.fetch(
      `${origin}/comments?url=${encodeURIComponent('https://maya.build/notes/leaving')}`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('sets no cookie on a submission either', async () => {
    const response = await exports.default.fetch(`${origin}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        authorName: 'Rahul Kanwar',
        body: 'The part people underestimate is the export.',
        url: 'https://maya.build/notes/leaving',
      }),
    })

    expect(response.headers.get('set-cookie')).toBeNull()
  })
})
