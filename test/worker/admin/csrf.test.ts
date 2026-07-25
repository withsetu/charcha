import { describe, expect, it } from 'vitest'
import { isCrossOriginRequest } from '../../../src/admin/csrf'

const url = 'https://charcha.example/admin/api/comments/1/status'

function post(origin?: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: origin === undefined ? {} : { origin },
  })
}

describe('a state-changing request from this dashboard', () => {
  it('is not cross-origin', () => {
    expect(isCrossOriginRequest(post('https://charcha.example'))).toBe(false)
  })
})

describe('an Origin that is not a canonical serialisation', () => {
  // The comparison is exact against `URL.origin` of this request, and the inbound
  // header is *not* run through the URL parser first. That mirrors matchOrigin in
  // src/cors.ts, which canonicalises the owner's allowlist and compares the
  // request's Origin as sent — and the reason is the same in both places: a browser
  // sends the canonical serialisation (no default port, lowercased, no path), so
  // normalising an attacker-controlled string buys nothing and every normalisation
  // step is a chance to make two different origins compare equal. Anything that can
  // choose a non-canonical spelling can also omit the header, which is allowed.

  it('is treated as cross-origin: the default https port spelled out', () => {
    expect(isCrossOriginRequest(post('https://charcha.example:443'))).toBe(true)
  })

  it('is treated as cross-origin: a trailing slash', () => {
    expect(isCrossOriginRequest(post('https://charcha.example/'))).toBe(true)
  })
})

describe('a state-changing request from somewhere else', () => {
  it.each([
    ['another site', 'https://evil.example'],
    ['a sibling subdomain, which SameSite alone would call same-site', 'https://other.example.com'],
    ['the same host over http', 'http://charcha.example'],
    ['the same host on another port', 'https://charcha.example:8443'],
    ['a suffix of this origin', 'https://charcha.example.evil.example'],
    ['a prefix of this origin', 'https://charcha.exampl'],
    ['a host this one is a suffix of', 'https://evilcharcha.example'],
    ['the literal null a sandboxed iframe sends', 'null'],
    ['an empty Origin', ''],
  ])('is cross-origin: %s', (_label, origin) => {
    expect(isCrossOriginRequest(post(origin))).toBe(true)
  })
})

describe('a state-changing request with no Origin at all', () => {
  // The same call src/cors.ts makes, for the same reason: a browser always sends
  // Origin on POST and DELETE, so no Origin means no browser — curl, a script, the
  // importer — and none of those has an ambient cookie to be ridden. Refusing them
  // would break the owner debugging their own deployment and stop no attack.

  it('is allowed', () => {
    expect(isCrossOriginRequest(post())).toBe(false)
  })
})
