import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ALLOWED_ORIGINS_SETTING,
  MAX_ALLOWED_ORIGINS,
  MAX_ALLOWED_ORIGINS_LENGTH,
  matchOrigin,
  parseAllowedOrigins,
  readAllowedOrigins,
  resolveOrigin,
  selfOrigin,
  unlistedOriginResponse,
} from '../../src/cors'

const db = env.DB

/** The address a deployed Charcha answers on, as the Worker sees it in `request.url`. */
const DEPLOYMENT = 'https://charcha.example.workers.dev'

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

/**
 * A database that fails if it is consulted at all.
 *
 * The double cast is the point rather than a shortcut: the assertion is that
 * `resolveOrigin` never reaches D1 on the same-origin path, and a stub that throws is
 * the only way to prove a call did not happen without counting calls on a real one.
 */
const unreadableDb = {
  prepare() {
    throw new Error('the settings row must not be read for a same-origin request')
  },
} as unknown as D1Database

describe("this deployment's own origin", () => {
  it('is derived from the request the Worker was handed', () => {
    expect(selfOrigin(new Request(`${DEPLOYMENT}/comments?url=https://maya.build/a`))).toBe(
      DEPLOYMENT,
    )
  })

  it('keeps a non-default port, so a local wrangler dev is its own origin', () => {
    expect(selfOrigin(new Request('http://localhost:8787/comments'))).toBe('http://localhost:8787')
  })
})

describe('a fresh deployment, with nothing in settings at all', () => {
  it('accepts a request from its own origin — the state after a deploy is not "refuses everything"', async () => {
    const decision = await resolveOrigin(
      db,
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: DEPLOYMENT },
      }),
    )

    expect(decision).toEqual({ requestOrigin: DEPLOYMENT, allowedOrigin: DEPLOYMENT })
  })

  it('still refuses every other origin — fail closed, card rule 5', async () => {
    const decision = await resolveOrigin(
      db,
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: 'https://maya.build' },
      }),
    )

    expect(decision.allowedOrigin).toBeNull()
  })

  it('records nothing anywhere, so no request can widen the allowlist for the next one', async () => {
    await resolveOrigin(
      db,
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: DEPLOYMENT },
      }),
    )

    const { results } = await db.prepare('select key from settings').all()
    expect(results).toEqual([])
  })

  it('does not spend a D1 query on the settings row it does not need', async () => {
    const decision = await resolveOrigin(
      unreadableDb,
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: DEPLOYMENT },
      }),
    )

    expect(decision.allowedOrigin).toBe(DEPLOYMENT)
  })
})

describe('an origin that only claims to be this deployment', () => {
  it('is refused when the Origin names another host', async () => {
    const decision = await resolveOrigin(
      db,
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
    )

    expect(decision.allowedOrigin).toBeNull()
  })

  it('is refused when a forwarding header claims the request arrived somewhere else', async () => {
    // The self-origin comes from `request.url`, which Cloudflare builds from the
    // request line and the Host the edge resolved — never from a header a caller
    // chose. If it were read from one, this pair would let any page name itself
    // same-origin.
    const decision = await resolveOrigin(
      db,
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'x-forwarded-host': 'evil.example',
          host: 'evil.example',
        },
      }),
    )

    expect(decision.allowedOrigin).toBeNull()
  })

  it('is refused for the same host on another scheme, even though it is nearly this one', async () => {
    const decision = await resolveOrigin(
      db,
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: 'http://charcha.example.workers.dev' },
      }),
    )

    expect(decision.allowedOrigin).toBeNull()
  })
})

describe('a deployment the owner has configured', () => {
  it('accepts the origins they listed', async () => {
    await setAllowedOrigins('https://maya.build')

    const decision = await resolveOrigin(
      db,
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: 'https://maya.build' },
      }),
    )

    expect(decision.allowedOrigin).toBe('https://maya.build')
  })

  it('still accepts its own origin, which no list has to name', async () => {
    await setAllowedOrigins('https://maya.build')

    const decision = await resolveOrigin(
      db,
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: DEPLOYMENT },
      }),
    )

    expect(decision.allowedOrigin).toBe(DEPLOYMENT)
  })

  it('refuses an origin they did not list', async () => {
    await setAllowedOrigins('https://maya.build')

    const decision = await resolveOrigin(
      db,
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
    )

    expect(decision.allowedOrigin).toBeNull()
  })
})

describe('the refusal a site owner reads while setting this up', () => {
  it('names where the list is set, and says it is not Turnstile’s', async () => {
    const body = await unlistedOriginResponse().text()

    expect(body).toContain('/admin')
    expect(body).toContain('Turnstile')
  })

  it('carries no allow-origin header, so the page that was refused cannot read it', () => {
    expect(unlistedOriginResponse().headers.get('access-control-allow-origin')).toBeNull()
  })
})
