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
    // ::ffff:203.0.113.9 carries a whole IPv4 address in its low 32 bits. Folding
    // it to a /64 would put every IPv4 commenter behind one key, so one flooder
    // would rate-limit the entire IPv4 internet off the site.
    expect(normaliseIp('::ffff:203.0.113.9')).not.toBe(normaliseIp('::ffff:198.51.100.7'))
  })

  it('does not fold the hex spelling of a mapped address either', () => {
    // The dotted and hex forms are the same bits. A guard that reads the spelling
    // catches only one of them, and the hex form is the one that reaches the /64.
    expect(normaliseIp('::ffff:cb00:7109')).not.toBe(normaliseIp('::ffff:c633:6407'))
  })

  it('reads the dotted and hex spellings of one mapped address as one key', () => {
    // 203.0.113.9 is 0xcb00 0x7109. If these disagreed, the per-IP counter would
    // reset the moment the spelling changed.
    expect(normaliseIp('::ffff:203.0.113.9')).toBe(normaliseIp('::ffff:cb00:7109'))
  })

  it('does not fold the NAT64 well-known prefix, which real mobile carriers use', () => {
    // 64:ff9b::/96 embeds IPv4 exactly as ::ffff:0:0/96 does, and is live traffic
    // rather than a curiosity.
    expect(normaliseIp('64:ff9b::203.0.113.9')).not.toBe(normaliseIp('64:ff9b::198.51.100.7'))
    expect(normaliseIp('64:ff9b::cb00:7109')).toBe(normaliseIp('64:ff9b::203.0.113.9'))
  })

  it('keeps loopback out of the folded namespace', () => {
    expect(normaliseIp('::1')).not.toBe(normaliseIp('::2'))
  })

  it('cannot be made to collide with a folded prefix by spelling one out', () => {
    // The folded form is namespaced, so a header whose literal value looks like a
    // prefix key lands somewhere else entirely.
    expect(normaliseIp('2001:db8:1:2:3:4:5:6')).not.toBe('2001:db8:1:2')
    expect(normaliseIp('2001:db8:1:2:3:4:5:6')).not.toBe(normaliseIp('v6-64:2001:db8:1:2'))
  })

  it('passes an unparseable address through rather than merging it with anything', () => {
    expect(normaliseIp('not:an:address:at:all:!!')).not.toBe(normaliseIp('also:not:one:!!'))
    expect(normaliseIp('not:an:address:at:all:!!')).toContain('not:an:address:at:all:!!')
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
