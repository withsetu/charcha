// The allowed-origins setting, driven through the Worker. Designed on issue #57.
//
// **This endpoint edits the allowlist that decides which pages may post into this
// deployment's moderation queue.** An allowlist a stranger can widen is not an
// allowlist, so most of this file is about the door rather than about the setting:
// every handler is behind a session, the write is behind the CSRF origin check as
// well, and both of those are kill-shot targets on the PR.

import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ALLOWED_ORIGINS_SETTING, MAX_ALLOWED_ORIGINS, readAllowedOrigins } from '../../../src/cors'
import { SESSION_COOKIE_NAME, issueSession } from '../../../src/admin/session'
import {
  TEST_PASSWORD,
  configurePassword,
  restoreLimiter,
  restorePassword,
  stubLimiter,
} from './env'

const db = env.DB
const origin = 'https://charcha.example'
const SETTINGS = `${origin}/admin/api/settings`

let cookie: string

function read(headers: Record<string, string> = {}) {
  return exports.default.fetch(SETTINGS, { headers: { cookie, ...headers } })
}

function write(body: unknown, headers: Record<string, string> = {}) {
  return exports.default.fetch(SETTINGS, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function storedValue(): Promise<string | null> {
  const row = await db
    .prepare('select value from settings where key = ?1')
    .bind(ALLOWED_ORIGINS_SETTING)
    .first<{ value: string }>()
  return row?.value ?? null
}

interface SettingsBody {
  allowedOrigins: string[]
  selfOrigin: string
}

/** The read endpoint's body, named rather than inferred, so a shape change is a type error. */
async function readBody(): Promise<SettingsBody> {
  return (await read()).json()
}

beforeEach(async () => {
  configurePassword(TEST_PASSWORD)
  stubLimiter(true)
  const { token } = await issueSession(TEST_PASSWORD, Math.floor(Date.now() / 1000))
  cookie = `${SESSION_COOKIE_NAME}=${token}`

  await db.exec('DELETE FROM settings')
})

afterEach(() => {
  restoreLimiter()
  restorePassword()
})

describe('the door', () => {
  it('will not read the allowlist without a session', async () => {
    const response = await exports.default.fetch(SETTINGS)

    expect(response.status).toBe(401)
  })

  it('will not read it with a forged session', async () => {
    const response = await read({
      cookie: `${SESSION_COOKIE_NAME}=1785000000.${'A'.repeat(43)}`,
    })

    expect(response.status).toBe(401)
  })

  it('will not widen the allowlist without a session, and changes nothing trying', async () => {
    const response = await exports.default.fetch(SETTINGS, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowedOrigins: ['https://evil.example'] }),
    })

    expect(response.status).toBe(401)
    expect(await storedValue()).toBeNull()
  })

  it('will not widen it from another site’s page, even with the owner’s cookie', async () => {
    // The CSRF case: the owner is signed in, and a page in another tab tries to add
    // itself to the list the owner's deployment trusts.
    const response = await write(
      { allowedOrigins: ['https://evil.example'] },
      { origin: 'https://evil.example' },
    )

    expect(response.status).toBe(403)
    expect(await storedValue()).toBeNull()
  })

  it('accepts the write from the dashboard’s own page', async () => {
    const response = await write({ allowedOrigins: ['https://maya.build'] }, { origin })

    expect(response.status).toBe(200)
  })

  it('emits no CORS header, so no other origin can read the answer either', async () => {
    const response = await read()

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('reading the setting', () => {
  it('is an empty list on a deployment nobody has configured', async () => {
    const body = await readBody()

    expect(body.allowedOrigins).toEqual([])
  })

  it('reports this deployment’s own origin, which is allowed without being listed', async () => {
    const body = await readBody()

    expect(body.selfOrigin).toBe(origin)
  })

  it('returns what was stored, canonicalised the way the origin check reads it', async () => {
    await write(
      { allowedOrigins: ['HTTPS://Maya.Build/', 'https://www.maya.build:443'] },
      { origin },
    )

    const body = await readBody()
    expect(body.allowedOrigins).toEqual(['https://maya.build', 'https://www.maya.build'])
  })
})

describe('writing the setting', () => {
  it('takes effect on the public origin check, which is the only reason it exists', async () => {
    await write({ allowedOrigins: ['https://maya.build'] }, { origin })

    expect(await readAllowedOrigins(db)).toEqual(['https://maya.build'])
  })

  it('replaces the list rather than adding to it, so removing an origin is possible', async () => {
    await write({ allowedOrigins: ['https://maya.build', 'https://old.example'] }, { origin })
    await write({ allowedOrigins: ['https://maya.build'] }, { origin })

    expect(await readAllowedOrigins(db)).toEqual(['https://maya.build'])
  })

  it('accepts an empty list, which is how an owner takes their site back off', async () => {
    await write({ allowedOrigins: ['https://maya.build'] }, { origin })
    const response = await write({ allowedOrigins: [] }, { origin })

    expect(response.status).toBe(200)
    expect(await readAllowedOrigins(db)).toEqual([])
  })

  it('refuses a typo instead of silently dropping it', async () => {
    // parseAllowedOrigins drops a malformed entry, which is right for the read path —
    // one typo must not take the site's real origin down with it. It is wrong here:
    // the caller is the owner, they can be told, and an origin that silently did not
    // save is a support ticket in a week's time.
    const response = await write({ allowedOrigins: ['maya.build'] }, { origin })

    expect(response.status).toBe(400)
    expect((await response.text()).includes('maya.build')).toBe(true)
    expect(await storedValue()).toBeNull()
  })

  it('refuses a scheme no browser sends as a page origin', async () => {
    const response = await write({ allowedOrigins: ['javascript:alert(1)'] }, { origin })

    expect(response.status).toBe(400)
    expect(await storedValue()).toBeNull()
  })

  it('never admits the literal null origin a sandboxed frame sends', async () => {
    const response = await write({ allowedOrigins: ['null'] }, { origin })

    expect(response.status).toBe(400)
    expect(await storedValue()).toBeNull()
  })

  it('refuses a wildcard, which is not a shorthand for anything here', async () => {
    const response = await write({ allowedOrigins: ['*'] }, { origin })

    expect(response.status).toBe(400)
    expect(await storedValue()).toBeNull()
  })

  it('caps how many origins one deployment may hold', async () => {
    const many = Array.from({ length: MAX_ALLOWED_ORIGINS + 1 }, (_, i) => `https://s${i}.example`)

    const response = await write({ allowedOrigins: many }, { origin })

    expect(response.status).toBe(400)
    expect(await storedValue()).toBeNull()
  })

  it('counts the cap after de-duplicating, not before', async () => {
    // `https://a.example` and `https://a.example/` are one origin. An owner who pasted
    // a list with a repeat in it should not be told they are over a limit they are not
    // over — the bound that matters is on what gets stored.
    const many = Array.from({ length: MAX_ALLOWED_ORIGINS }, (_, i) => `https://s${i}.example`)

    const response = await write({ allowedOrigins: [...many, 'https://s0.example/'] }, { origin })

    expect(response.status).toBe(200)
    expect(await readAllowedOrigins(db)).toHaveLength(MAX_ALLOWED_ORIGINS)
  })

  it('stores exactly the cap, so the boundary is usable rather than one short', async () => {
    const many = Array.from({ length: MAX_ALLOWED_ORIGINS }, (_, i) => `https://s${i}.example`)

    const response = await write({ allowedOrigins: many }, { origin })

    expect(response.status).toBe(200)
    expect(await readAllowedOrigins(db)).toHaveLength(MAX_ALLOWED_ORIGINS)
  })

  it('refuses a body that is not a list of origins', async () => {
    const response = await write({ allowedOrigins: 'https://maya.build' }, { origin })

    expect(response.status).toBe(400)
  })

  it('refuses a body that is not JSON at all', async () => {
    const response = await write('{', { origin })

    expect(response.status).toBe(400)
  })

  it('bounds one entry, so a single absurd string cannot become the stored value', async () => {
    const response = await write(
      { allowedOrigins: [`https://${'a'.repeat(3000)}.example`] },
      { origin },
    )

    expect(response.status).toBe(400)
    expect(await storedValue()).toBeNull()
  })

  it('writes a value the public reader will accept back, not one it fails closed on', async () => {
    // parseAllowedOrigins treats a value over MAX_ALLOWED_ORIGINS_LENGTH as
    // unconfigured. A write that could store one would let the dashboard report a
    // saved allowlist while the origin check silently refused every origin on it.
    await write(
      {
        allowedOrigins: Array.from(
          { length: MAX_ALLOWED_ORIGINS },
          (_, i) => `https://s${i}.example`,
        ),
      },
      { origin },
    )

    expect(await readAllowedOrigins(db)).toHaveLength(MAX_ALLOWED_ORIGINS)
  })
})
