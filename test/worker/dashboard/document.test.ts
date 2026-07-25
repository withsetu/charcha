// The dashboard document: the route, and the headers that are the whole reason it is
// served from the Worker rather than as a static asset.
//
// Kill-shot: drop `content-security-policy` from DASHBOARD_HEADERS in
// src/dashboard/document.ts and the policy tests below fail; register the route as
// `app.get('/admin/*')` and the shadowing test fails. Both recorded on the PR for #13.

import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { DASHBOARD_HTML } from '../../../src/dashboard/document'

const ORIGIN = 'https://comments.example.com'

async function get(path: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`)
}

/** The policy, as a map of directive to its value, so tests read one directive each. */
function policy(response: Response): Map<string, string> {
  const header = response.headers.get('content-security-policy') ?? ''
  return new Map(
    header
      .split(';')
      .map((directive) => directive.trim())
      .filter((directive) => directive !== '')
      .map((directive) => {
        const space = directive.indexOf(' ')
        return space === -1
          ? ([directive, ''] as const)
          : ([directive.slice(0, space), directive.slice(space + 1)] as const)
      }),
  )
}

describe('GET /admin', () => {
  it('answers the shell, with and without a trailing slash', async () => {
    for (const path of ['/admin', '/admin/']) {
      const response = await get(path)
      expect(response.status, path).toBe(200)
      expect(response.headers.get('content-type'), path).toBe('text/html; charset=utf-8')
      expect(await response.text(), path).toBe(DASHBOARD_HTML)
    }
  })

  it('loads its bundle and stylesheet from the static-asset paths, not from the Worker', async () => {
    const html = await (await get('/admin')).text()
    expect(html).toContain('<script type="module" src="/admin/app.js"></script>')
    expect(html).toContain('href="/admin/app.css"')
  })

  it('has no inline script, which is what makes the script policy strict', async () => {
    const html = await (await get('/admin')).text()
    // A `<script>` with a body — the bootstrap-JSON shape — would need `unsafe-inline`
    // or a nonce, on the one page in this project where an XSS reaches a session that
    // can delete every comment on the site.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
  })

  it('asks not to be indexed, in the header as well as the markup', async () => {
    const response = await get('/admin')
    // The header is the one a crawler that does not parse markup reads, and a
    // moderation dashboard in a search index is a list of deployments running one.
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(await response.text()).toContain('<meta name="robots" content="noindex, nofollow">')
  })

  it('is never stored, matching every response src/admin/api.ts produces', async () => {
    expect((await get('/admin')).headers.get('cache-control')).toBe('no-store')
  })

  it('carries the sniffing, framing and referrer guards', async () => {
    const response = await get('/admin')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('emits no CORS header: there is no legitimate cross-origin reader of this page', async () => {
    const response = await get('/admin')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('the Content-Security-Policy', () => {
  it('starts from nothing', async () => {
    expect(policy(await get('/admin')).get('default-src')).toBe("'none'")
  })

  it('allows script only from this origin, with no inline and no eval', async () => {
    const scriptSrc = policy(await get('/admin')).get('script-src')
    expect(scriptSrc).toBe("'self'")
    expect(scriptSrc).not.toContain('unsafe-inline')
    expect(scriptSrc).not.toContain('unsafe-eval')
  })

  it('confines fetches to this origin, so an injection has nowhere to send anything', async () => {
    expect(policy(await get('/admin')).get('connect-src')).toBe("'self'")
  })

  it('refuses every form submission, so an injected form cannot post the password', async () => {
    // The sign-in form is handled in JavaScript and never submits; this makes a
    // submission a refusal rather than a navigation.
    expect(policy(await get('/admin')).get('form-action')).toBe("'none'")
  })

  it('refuses framing and a rewritten base URL', async () => {
    const directives = policy(await get('/admin'))
    expect(directives.get('frame-ancestors')).toBe("'none'")
    // An injected `<base>` would repoint every relative URL on the page, including the
    // ones the API client uses to stay same-origin.
    expect(directives.get('base-uri')).toBe("'none'")
  })

  it('allows inline style and nothing else beyond this origin', async () => {
    // Radix sets inline `style` attributes and the undo bar passes a custom property.
    // `unsafe-inline` on styles cannot execute script; it is the narrowest form that
    // does not mean forking the registry components.
    expect(policy(await get('/admin')).get('style-src')).toBe("'self' 'unsafe-inline'")
  })
})

describe('the route does not shadow the API', () => {
  it('leaves /admin/api answering JSON in the documented error shape', async () => {
    // Registered as two exact paths rather than `/admin/*` for this reason: a wildcard
    // here would serve HTML where the client parses `{error:{code,message}}`, and every
    // branch in src/dashboard/api.ts would report MALFORMED.
    const response = await SELF.fetch(`${ORIGIN}/admin/api/queue`)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Sign in to use the dashboard.' },
    })
  })

  it('leaves an unknown /admin path as a plain 404 rather than the shell', async () => {
    const response = await get('/admin/nope')
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('charcha-dashboard')
  })

  it('does not answer a non-GET on /admin', async () => {
    const response = await SELF.fetch(`${ORIGIN}/admin`, { method: 'POST' })
    expect(response.status).toBe(404)
  })
})
