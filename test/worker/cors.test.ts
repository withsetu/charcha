import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ALLOWED_ORIGINS_SETTING,
  MAX_ALLOWED_ORIGINS,
  MAX_ALLOWED_ORIGINS_LENGTH,
  matchOrigin,
  parseAllowedOrigins,
  readAllowedOrigins,
} from '../../src/cors'

const db = env.DB

async function setAllowedOrigins(value: string) {
  await db
    .prepare('insert or replace into settings (key, value, updated_at) values (?1, ?2, ?3)')
    .bind(ALLOWED_ORIGINS_SETTING, value, 1_753_300_000)
    .run()
}

beforeEach(async () => {
  await db.exec('DELETE FROM settings')
})

describe('parsing the owner-configured allowlist', () => {
  it('reads a comma-separated list', () => {
    expect(parseAllowedOrigins('https://maya.build, https://www.maya.build')).toEqual([
      'https://maya.build',
      'https://www.maya.build',
    ])
  })

  it('reads a newline-separated list too, because a settings box invites one per line', () => {
    expect(parseAllowedOrigins('https://maya.build\nhttps://staging.maya.build')).toEqual([
      'https://maya.build',
      'https://staging.maya.build',
    ])
  })

  it('normalises to an origin, so a trailing slash or a default port still matches', () => {
    expect(parseAllowedOrigins('https://maya.build/, https://maya.build:443')).toEqual([
      'https://maya.build',
      'https://maya.build',
    ])
  })

  it('lowercases the scheme and host, which are case-insensitive', () => {
    expect(parseAllowedOrigins('HTTPS://Maya.Build')).toEqual(['https://maya.build'])
  })

  it('keeps a non-default port, which is part of the origin', () => {
    expect(parseAllowedOrigins('http://localhost:4321')).toEqual(['http://localhost:4321'])
  })

  it('drops an entry that is not a URL rather than failing the whole list', () => {
    expect(parseAllowedOrigins('not a url, https://maya.build')).toEqual(['https://maya.build'])
  })

  it('drops a scheme that a browser would never send as a page origin', () => {
    expect(parseAllowedOrigins('javascript:alert(1), file:///etc, https://maya.build')).toEqual([
      'https://maya.build',
    ])
  })

  it('never admits the literal "null" origin a sandboxed frame sends', () => {
    expect(parseAllowedOrigins('null')).toEqual([])
  })

  it('caps how many origins it will hold, so the list cannot become the work', () => {
    const many = Array.from({ length: MAX_ALLOWED_ORIGINS + 10 }, (_, i) => `https://s${i}.example`)

    expect(parseAllowedOrigins(many.join(','))).toHaveLength(MAX_ALLOWED_ORIGINS)
  })

  it('fails closed on a value too long to be something an owner typed', () => {
    const oversized = `https://maya.build,${'https://x.example,'.repeat(500)}`
    expect(oversized.length).toBeGreaterThan(MAX_ALLOWED_ORIGINS_LENGTH)

    expect(parseAllowedOrigins(oversized)).toEqual([])
  })
})

describe('reading the allowlist from settings', () => {
  it('is empty when the owner has configured nothing — fail closed', async () => {
    expect(await readAllowedOrigins(db)).toEqual([])
  })

  it('returns what the owner configured', async () => {
    await setAllowedOrigins('https://maya.build')

    expect(await readAllowedOrigins(db)).toEqual(['https://maya.build'])
  })
})

describe('matching a request origin against the allowlist', () => {
  it('returns the origin when it is listed', () => {
    expect(matchOrigin('https://maya.build', ['https://maya.build'])).toBe('https://maya.build')
  })

  it('returns null when the allowlist is empty, whatever the origin claims', () => {
    expect(matchOrigin('https://maya.build', [])).toBeNull()
  })

  it('refuses an origin that is not listed', () => {
    expect(matchOrigin('https://evil.example', ['https://maya.build'])).toBeNull()
  })

  it('refuses a suffix that merely ends with an allowed origin', () => {
    // The check is equality on the whole origin, never endsWith. "maya.build" is a
    // substring of "evilmaya.build" and of "maya.build.evil.example", and a
    // suffix or substring test hands both of them the header.
    expect(matchOrigin('https://evilmaya.build', ['https://maya.build'])).toBeNull()
    expect(matchOrigin('https://maya.build.evil.example', ['https://maya.build'])).toBeNull()
  })

  it('refuses the same host over a different scheme', () => {
    expect(matchOrigin('http://maya.build', ['https://maya.build'])).toBeNull()
  })

  it('refuses the same host on a different port', () => {
    expect(matchOrigin('https://maya.build:8443', ['https://maya.build'])).toBeNull()
  })

  it('refuses the literal "null" origin even if something contrived listed it', () => {
    expect(matchOrigin('null', ['null'])).toBeNull()
  })

  it('refuses a request that carries no Origin at all', () => {
    expect(matchOrigin(null, ['https://maya.build'])).toBeNull()
  })

  it('never answers with a wildcard', () => {
    // There is no configuration that produces `*`. A wildcard is unnecessary for a
    // read (the HTML is public anyway) and, on the write endpoint, it would let any
    // page in any tab post into this deployment's moderation queue from a reader's
    // browser. The owner lists their origins instead.
    expect(matchOrigin('https://anywhere.example', parseAllowedOrigins('*'))).toBeNull()
  })
})
