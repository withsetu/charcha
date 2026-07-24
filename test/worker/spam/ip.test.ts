import { describe, expect, it } from 'vitest'
import { clientIp, hashIp, normaliseIp } from '../../../src/spam/ip'

const SECRET = 'a-per-deployment-secret'

function requestWith(headers: Record<string, string>) {
  return new Request('https://charcha.example/comments', { method: 'POST', headers })
}

describe('which header the client address is read from', () => {
  it('reads CF-Connecting-IP', () => {
    expect(clientIp(requestWith({ 'CF-Connecting-IP': '198.51.100.7' }))).toBe('198.51.100.7')
  })

  it('ignores X-Forwarded-For, which the caller sets and could therefore forge', () => {
    // If this ever started reading X-Forwarded-For, the per-IP rate limit would be
    // bypassable by anyone who read this file — one header per request and the
    // counter is a fresh one every time.
    const request = requestWith({
      'CF-Connecting-IP': '198.51.100.7',
      'X-Forwarded-For': '203.0.113.1',
    })

    expect(clientIp(request)).toBe('198.51.100.7')
  })

  it('is null when Cloudflare set no address, rather than inventing one', () => {
    expect(clientIp(requestWith({ 'X-Forwarded-For': '203.0.113.1' }))).toBeNull()
    expect(clientIp(requestWith({ 'CF-Connecting-IP': '  ' }))).toBeNull()
  })
})

describe('normalising an address to the unit that is one commenter', () => {
  it('leaves an IPv4 address alone', () => {
    expect(normaliseIp('198.51.100.7')).toBe('198.51.100.7')
  })

  it('collapses an IPv6 address to its /64, because one customer holds the whole /64', () => {
    // Without this the per-IP limit is not a limit: a residential IPv6 subscriber
    // can source 2^64 addresses, so every submission would look like a new person.
    expect(normaliseIp('2001:db8:1:2:3:4:5:6')).toBe(
      normaliseIp('2001:db8:1:2:ffff:ffff:ffff:ffff'),
    )
  })

  it('keeps two different /64s apart', () => {
    expect(normaliseIp('2001:db8:1:2::1')).not.toBe(normaliseIp('2001:db8:1:3::1'))
  })

  it('reads the same prefix written two ways as one prefix', () => {
    // 2001:0db8:0000:0000::1 and 2001:db8::1 are the same address. Hashing the
    // literal string would count one commenter as two.
    expect(normaliseIp('2001:0db8:0000:0000::1')).toBe(normaliseIp('2001:db8::1'))
    expect(normaliseIp('2001:DB8::1')).toBe(normaliseIp('2001:db8::1'))
  })

  it('does not fold an IPv4-mapped address into a single bucket', () => {
    // ::ffff:203.0.113.9 carries a whole IPv4 address in its last group. Truncating
    // it to a /64 would put every IPv4 commenter behind one key and rate-limit the
    // internet as one person.
    expect(normaliseIp('::ffff:203.0.113.9')).not.toBe(normaliseIp('::ffff:198.51.100.7'))
  })

  it('passes an unparseable address through rather than merging it with anything', () => {
    expect(normaliseIp('not:an:address:at:all:!!')).toBe('not:an:address:at:all:!!')
  })
})

describe('hashing an address', () => {
  it('is stable for the same address and secret', async () => {
    expect(await hashIp('198.51.100.7', SECRET)).toBe(await hashIp('198.51.100.7', SECRET))
  })

  it('differs for a different address', async () => {
    expect(await hashIp('198.51.100.7', SECRET)).not.toBe(await hashIp('198.51.100.8', SECRET))
  })

  it('differs for a different deployment secret, so one site cannot read another’s hashes', async () => {
    expect(await hashIp('198.51.100.7', SECRET)).not.toBe(await hashIp('198.51.100.7', 'other'))
  })

  it('is keyed, not a plain digest — an unkeyed hash of an IPv4 address is reversible', async () => {
    const plain = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode('198.51.100.7')),
    )
    const plainHex = Array.from(plain, (byte) => byte.toString(16).padStart(2, '0')).join('')

    expect(await hashIp('198.51.100.7', SECRET)).not.toBe(plainHex)
  })

  it('hashes the normalised address, so the /64 truncation actually reaches the column', async () => {
    expect(await hashIp('2001:db8:1:2:3:4:5:6', SECRET)).toBe(
      await hashIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd', SECRET),
    )
  })
})
