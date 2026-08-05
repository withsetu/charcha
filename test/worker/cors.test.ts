import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALLOWED_ORIGINS_SETTING,
  MAX_ALLOWED_ORIGINS,
  MAX_ALLOWED_ORIGINS_LENGTH,
  matchDeclaredOrigin,
  matchOrigin,
  parseAllowedOrigins,
  readAllowedOrigins,
  resolveOrigin,
  selfOrigin,
  submittedUrlRefusal,
  UNDECLARED_URL_MESSAGE,
  unlistedOriginResponse,
  wwwSibling,
} from '../../src/cors'
import { SITE_URL_SETTING, readDeclaredOrigins } from '../../src/settings'

const db = env.DB

/** The address a deployed Charcha answers on, as the Worker sees it in `request.url`. */
const DEPLOYMENT = 'https://charcha.example.workers.dev'

/**
 * The same pairing the Worker makes: the policy in src/cors.ts, and the rows it is
 * matched against from src/settings.ts. Injected rather than imported by cors.ts, so the
 * origin policy stays free of the settings module and there is one reader (#224).
 */
function decide(request: Request, database: D1Database = db) {
  return resolveOrigin(database, request, readDeclaredOrigins)
}

async function setSetting(key: string, value: string) {
  await db
    .prepare('insert or replace into settings (key, value, updated_at) values (?1, ?2, ?3)')
    .bind(key, value, 1_753_300_000)
    .run()
}

async function setAllowedOrigins(value: string) {
  await setSetting(ALLOWED_ORIGINS_SETTING, value)
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
    const decision = await decide(
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: DEPLOYMENT },
      }),
    )

    expect(decision).toEqual({ requestOrigin: DEPLOYMENT, allowedOrigin: DEPLOYMENT })
  })

  it('still refuses every other origin — fail closed, card rule 5', async () => {
    const decision = await decide(
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: 'https://maya.build' },
      }),
    )

    expect(decision.allowedOrigin).toBeNull()
  })

  it('records nothing anywhere, so no request can widen the allowlist for the next one', async () => {
    await decide(
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: DEPLOYMENT },
      }),
    )

    const { results } = await db.prepare('select key from settings').all()
    expect(results).toEqual([])
  })

  it('does not spend a D1 query on the settings row it does not need', async () => {
    const decision = await decide(
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: DEPLOYMENT },
      }),
      unreadableDb,
    )

    expect(decision.allowedOrigin).toBe(DEPLOYMENT)
  })
})

describe('an origin that only claims to be this deployment', () => {
  it('is refused when the Origin names another host', async () => {
    const decision = await decide(
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
    )

    expect(decision.allowedOrigin).toBeNull()
  })

  it('is refused when a forwarding header claims the request arrived somewhere else', async () => {
    // The self-origin comes from `request.url` and from no header. This is the guard
    // against a future `x-forwarded-host` (or `x-forwarded-proto`, or `:authority`)
    // being read instead: reading one would make this pair same-origin, and any page
    // could then name itself so. Kill-shot confirmed on the PR for #57 — teaching
    // `selfOrigin` to prefer `x-forwarded-host` fails exactly this test.
    //
    // **`Host` is deliberately not in this list, and saying so is the point.** It is a
    // forbidden header name, so the `Request` constructor drops it and an assertion
    // including it would be inert — it would read like a kill-shot against Host-header
    // trust while testing nothing. The real protection against that is not a test at
    // all: no browser lets a page set `Host`, and a client that can set it can omit
    // `Origin` and was never subject to CORS.
    const decision = await decide(
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'https',
        },
      }),
    )

    expect(decision.allowedOrigin).toBeNull()
  })

  it('is refused for the same host on another scheme, even though it is nearly this one', async () => {
    const decision = await decide(
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

    const decision = await decide(
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: 'https://maya.build' },
      }),
    )

    expect(decision.allowedOrigin).toBe('https://maya.build')
  })

  it('still accepts its own origin, which no list has to name', async () => {
    await setAllowedOrigins('https://maya.build')

    const decision = await decide(
      new Request(`${DEPLOYMENT}/comments`, {
        method: 'POST',
        headers: { origin: DEPLOYMENT },
      }),
    )

    expect(decision.allowedOrigin).toBe(DEPLOYMENT)
  })

  it('refuses an origin they did not list', async () => {
    await setAllowedOrigins('https://maya.build')

    const decision = await decide(
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

// ---------------------------------------------------------------------------
// #224 — one declaration covers www and the apex, and the submitted url is checked
// against what the owner declared.
// ---------------------------------------------------------------------------

describe('the other spelling of the same declaration', () => {
  it('adds www to an apex', () => {
    expect(wwwSibling('https://maya.build')).toBe('https://www.maya.build')
  })

  it('removes it from a www host', () => {
    expect(wwwSibling('https://www.maya.build')).toBe('https://maya.build')
  })

  it('keeps the scheme and the port, which are part of the origin', () => {
    expect(wwwSibling('http://maya.build:8080')).toBe('http://www.maya.build:8080')
  })

  it('has none for a host that is only "www"', () => {
    // Stripping it would leave an empty host, and adding another would invent
    // `www.www.` — neither is the same declaration.
    expect(wwwSibling('https://www')).toBeNull()
  })

  it('has none for something that is not an origin at all', () => {
    expect(wwwSibling('null')).toBeNull()
    expect(wwwSibling('not a url')).toBeNull()
  })

  it('does not treat a deeper subdomain as an apex', () => {
    // `blog.maya.build` gets `www.blog.maya.build`, never `maya.build`. Walking a label
    // off any host is a wildcard by another name.
    expect(wwwSibling('https://blog.maya.build')).toBe('https://www.blog.maya.build')
  })
})

describe('matching an origin against what the owner declared', () => {
  it('matches exactly, as the browser rule does', () => {
    expect(matchDeclaredOrigin('https://maya.build', ['https://maya.build'])).toBe(
      'https://maya.build',
    )
  })

  it('accepts the www spelling of a declared apex', () => {
    expect(matchDeclaredOrigin('https://www.maya.build', ['https://maya.build'])).toBe(
      'https://www.maya.build',
    )
  })

  it('accepts the apex of a declared www', () => {
    expect(matchDeclaredOrigin('https://maya.build', ['https://www.maya.build'])).toBe(
      'https://maya.build',
    )
  })

  it('answers with the origin as it was given, never the sibling', () => {
    // It is echoed into `Access-Control-Allow-Origin`, which a browser compares against
    // the origin it sent. The sibling is how it matched, not what it is.
    expect(matchDeclaredOrigin('https://www.maya.build', ['https://maya.build'])).not.toBe(
      'https://maya.build',
    )
  })

  it('does not admit an arbitrary subdomain of a declared apex', () => {
    // That is a wildcard, and src/cors.ts refuses wildcards for a stated reason.
    expect(matchDeclaredOrigin('https://blog.maya.build', ['https://maya.build'])).toBeNull()
    expect(matchDeclaredOrigin('https://a.b.maya.build', ['https://maya.build'])).toBeNull()
  })

  it('does not let www carry a different scheme or port in', () => {
    expect(matchDeclaredOrigin('http://www.maya.build', ['https://maya.build'])).toBeNull()
    expect(matchDeclaredOrigin('https://www.maya.build:8443', ['https://maya.build'])).toBeNull()
  })

  it('refuses a lookalike that merely contains a declared host', () => {
    expect(matchDeclaredOrigin('https://wwwmaya.build', ['https://maya.build'])).toBeNull()
    expect(
      matchDeclaredOrigin('https://www.maya.build.evil.example', ['https://maya.build']),
    ).toBeNull()
  })

  it('refuses everything when nothing is declared', () => {
    expect(matchDeclaredOrigin('https://maya.build', [])).toBeNull()
  })
})

describe('the origins one deployment has declared', () => {
  it('is empty when nothing has been set — fail closed, card rule 5', async () => {
    expect(await readDeclaredOrigins(db)).toEqual([])
  })

  it('is the allowlist and the site address together', async () => {
    await setAllowedOrigins('https://staging.maya.build')
    await setSetting(SITE_URL_SETTING, 'https://maya.build')

    expect([...(await readDeclaredOrigins(db))].sort()).toEqual([
      'https://maya.build',
      'https://staging.maya.build',
    ])
  })

  it('takes the origin of the site address, not the whole URL', async () => {
    await setSetting(SITE_URL_SETTING, 'https://maya.build/blog/')

    expect(await readDeclaredOrigins(db)).toEqual(['https://maya.build'])
  })

  it('drops a site address that is not a web address at all', async () => {
    await setSetting(SITE_URL_SETTING, 'javascript:alert(1)')

    expect(await readDeclaredOrigins(db)).toEqual([])
  })

  it('reads both rows in one statement, so the check costs one seek', async () => {
    await setSetting(SITE_URL_SETTING, 'https://maya.build')
    const sent: string[] = []
    const prepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      sent.push(sql)
      return prepare(sql)
    })
    await readDeclaredOrigins(db)
    spy.mockRestore()

    expect(sent).toHaveLength(1)
  })
})

describe('what the submitted url has to be', () => {
  const self = 'https://chaipecharcha.example.workers.dev'

  it('is refused when the owner has declared nothing', () => {
    expect(submittedUrlRefusal('https://maya.build/notes/leaving', { declared: [], self })).toBe(
      'nothing-declared',
    )
  })

  it('is accepted on this deployment’s own address with nothing declared (#57)', () => {
    expect(submittedUrlRefusal(`${self}/notes/leaving`, { declared: [], self })).toBeNull()
  })

  it('is accepted on a declared address', () => {
    expect(
      submittedUrlRefusal('https://maya.build/notes/leaving', {
        declared: ['https://maya.build'],
        self,
      }),
    ).toBeNull()
  })

  it('is refused on an address the owner did not declare', () => {
    expect(
      submittedUrlRefusal('https://evil.example/notes/leaving', {
        declared: ['https://maya.build'],
        self,
      }),
    ).toBe('undeclared-origin')
  })

  it('separates the two refusals, so the log can tell a misconfiguration from an attack', () => {
    expect(
      submittedUrlRefusal('https://evil.example/x', { declared: ['https://maya.build'], self }),
    ).not.toBe(submittedUrlRefusal('https://evil.example/x', { declared: [], self }))
  })

  it('accepts the www spelling of a declared apex', () => {
    expect(
      submittedUrlRefusal('https://www.maya.build/notes/leaving', {
        declared: ['https://maya.build'],
        self,
      }),
    ).toBeNull()
  })

  it('is refused when there is no url at all', () => {
    // A `data-thread` submission with no url has nothing to check. Fail closed.
    expect(submittedUrlRefusal(null, { declared: ['https://maya.build'], self })).toBe('no-url')
  })

  it('is refused when this deployment’s own origin cannot be derived', () => {
    expect(submittedUrlRefusal('https://maya.build/x', { declared: [], self: null })).toBe(
      'nothing-declared',
    )
  })
})

describe('the refusal a reader gets when the url is not declared', () => {
  it('names the dashboard and the setting to fix, for the owner reading it', () => {
    expect(UNDECLARED_URL_MESSAGE).toContain('/admin')
    expect(UNDECLARED_URL_MESSAGE).toMatch(/address/i)
  })

  it('rules out Turnstile’s hostname list by name, as the other refusals do', () => {
    // #57's author added four hostnames to Turnstile's Hostname Management screen and had
    // no way to tell they were in the wrong product.
    expect(UNDECLARED_URL_MESSAGE).toContain('Turnstile')
  })

  it('reports nothing about how the deployment is configured', () => {
    // One message for all three reasons. Which check fired is in the log, whose audience
    // is the owner; the body's audience is whoever posted.
    expect(UNDECLARED_URL_MESSAGE).not.toMatch(/nothing-declared|undeclared-origin|no-url/)
  })
})
