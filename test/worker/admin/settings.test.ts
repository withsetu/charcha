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
import { MODERATION_POLICY_SETTING, getModerationPolicy } from '../../../src/db'
import { MODERATION_POLICIES } from '../../../src/moderation/policy'
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
  moderationPolicy: string
}

async function storedPolicy(): Promise<string | null> {
  const row = await db
    .prepare('select value from settings where key = ?1')
    .bind(MODERATION_POLICY_SETTING)
    .first<{ value: string }>()
  return row?.value ?? null
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

// The moderation policy (#173). It shares this endpoint with the allowlist and it is a
// more dangerous setting than the allowlist is: it decides whether a stranger's comment
// can be published without a human seeing it. So the door is asserted separately here
// rather than assumed from the tests above, which name the allowlist.
describe('the moderation policy', () => {
  it('is hold-all on a deployment nobody has configured', async () => {
    const body = await readBody()

    expect(body.moderationPolicy).toBe('hold-all')
  })

  it('is saved, and takes effect on the read the submission path uses', async () => {
    const response = await write({ moderationPolicy: 'trust-returning' }, { origin })

    expect(response.status).toBe(200)
    expect(await getModerationPolicy(db)).toBe('trust-returning')
    const body: SettingsBody = await response.json()
    expect(body.moderationPolicy).toBe('trust-returning')
  })

  it('accepts every policy that exists, over the real endpoint', async () => {
    // Driven rather than inferred (#189). The accepted set is derived from
    // `MODERATION_POLICIES`, so a new policy is wired up by construction — but this is
    // the write path that turns on publishing without a human, and "it should work
    // because the list is shared" is the kind of reasoning that is right until a
    // validator somewhere grows its own copy.
    for (const policy of MODERATION_POLICIES) {
      const response = await write({ moderationPolicy: policy }, { origin })

      expect(response.status).toBe(200)
      expect(await getModerationPolicy(db)).toBe(policy)
    }
  })

  it('can be set back to hold-all, so a policy is reversible from the same screen', async () => {
    await write({ moderationPolicy: 'trust-returning' }, { origin })
    await write({ moderationPolicy: 'hold-all' }, { origin })

    expect(await getModerationPolicy(db)).toBe('hold-all')
  })

  it('cannot be set without a session', async () => {
    const response = await exports.default.fetch(SETTINGS, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ moderationPolicy: 'trust-returning' }),
    })

    expect(response.status).toBe(401)
    expect(await storedPolicy()).toBeNull()
  })

  it('cannot be set from another site’s page, even with the owner’s cookie', async () => {
    // A page in another tab flipping the owner's site to trust-returning is the CSRF
    // this check exists for, and it is worth more here than on the allowlist: the
    // attacker's next step is a comment that publishes itself.
    const response = await write(
      { moderationPolicy: 'trust-returning' },
      { origin: 'https://evil.example' },
    )

    expect(response.status).toBe(403)
    expect(await storedPolicy()).toBeNull()
  })

  it('refuses a value that is not a policy, rather than storing the default quietly', async () => {
    // `parseModerationPolicy` coerces on the read path, which is right for a stored row
    // and wrong here: the caller is the owner, and a policy that saved as something
    // other than what they chose — with a 200 — is the setting most worth being told
    // about. The refused value is named in the message.
    const response = await write({ moderationPolicy: 'trust-clean' }, { origin })

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('trust-clean')
    expect(await storedPolicy()).toBeNull()
  })

  it('refuses a value that is not a string at all', async () => {
    const response = await write({ moderationPolicy: { policy: 'trust-returning' } }, { origin })

    expect(response.status).toBe(400)
    expect(await storedPolicy()).toBeNull()
  })

  it('leaves the allowlist alone when only the policy is sent', async () => {
    await write({ allowedOrigins: ['https://maya.build'] }, { origin })
    await write({ moderationPolicy: 'trust-returning' }, { origin })

    expect(await readAllowedOrigins(db)).toEqual(['https://maya.build'])
  })

  it('leaves the policy alone when only the allowlist is sent', async () => {
    // The lost update the optional fields exist to prevent: the origins dialog does not
    // know about the policy, and a PUT that required the whole document would have it
    // send back whatever it read when it opened.
    await write({ moderationPolicy: 'trust-returning' }, { origin })
    await write({ allowedOrigins: ['https://maya.build'] }, { origin })

    expect(await getModerationPolicy(db)).toBe('trust-returning')
  })

  it('saves neither when the policy in the same body is refused', async () => {
    await write({ allowedOrigins: ['https://maya.build'] }, { origin })

    const response = await write(
      { allowedOrigins: ['https://other.example'], moderationPolicy: 'trust-clean' },
      { origin },
    )

    expect(response.status).toBe(400)
    expect(await readAllowedOrigins(db)).toEqual(['https://maya.build'])
    expect(await storedPolicy()).toBeNull()
  })

  it('refuses a body carrying neither field, rather than answering a no-op 200', async () => {
    const response = await write({}, { origin })

    expect(response.status).toBe(400)
  })
})
