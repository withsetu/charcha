// What a Charcha deployment does in the state it is in the moment the Deploy button
// finishes: the Worker is live, the migrations have run, and **nothing has ever
// written a row to `settings`**, because nothing in the one-click flow can.
//
// Driven through the deployed Worker rather than through src/cors.ts, deliberately.
// That is the test that would catch the same-origin default being written and then not
// reached from the POST handler — which every unit test in test/worker/cors.test.ts
// would pass without noticing. #57 was found on a real deploy, and the whole of it was
// a route-level fact: `resolveOrigin` ran before `handleSubmit`, refused, and the
// spam layers behind it were never reached at all.
//
// Designed on issues #57 and #140.

import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { ELAPSED_FIELD, HONEYPOT_FIELD } from '../../src/spam/fields'

const db = env.DB

/** The address Cloudflare hands a deployer on the success screen. */
const DEPLOYMENT = 'https://chaipecharcha.example.workers.dev'

/**
 * A submission, reporting a page on this deployment's own address by default.
 *
 * **That default changed with #224 and the change is the point.** A fresh deployment has
 * declared no addresses, so it accepts comments for its own pages and refuses every other
 * address — including the owner's real site, until they say it is theirs. `url` is a
 * parameter here rather than a constant so both halves are driven below.
 */
function post(headers: Record<string, string>, url = `${DEPLOYMENT}/notes/leaving`) {
  return exports.default.fetch(`${DEPLOYMENT}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      authorName: 'Rahul Kanwar',
      body: 'The part people underestimate is the export, and nobody checks it until they leave.',
      url,
      [HONEYPOT_FIELD]: '',
      [ELAPSED_FIELD]: 31_000,
    }),
  })
}

async function countComments() {
  const row = await db.prepare('select count(*) as n from comments').first<{ n: number }>()
  return row?.n ?? -1
}

async function countSettings() {
  const row = await db.prepare('select count(*) as n from settings').first<{ n: number }>()
  return row?.n ?? -1
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  // The point of the whole file: not an empty allowlist value, but no row at all.
  await db.exec('DELETE FROM settings')
})

describe('a fresh deployment, nothing configured, no SQL run by hand', () => {
  it('has no settings row — this is the state the Deploy button leaves behind', async () => {
    expect(await countSettings()).toBe(0)
  })

  it('accepts a comment posted from its own origin, for a page on its own address', async () => {
    const response = await post({ origin: DEPLOYMENT })

    expect(response.status).toBe(202)
    expect(await countComments()).toBe(1)
  })

  it('refuses a comment for any other address until the owner declares one (#224)', async () => {
    // **The behaviour change, stated where #57 is stated.** This is not #57 returning: a
    // deployment in this state says so on the Setup tab, in the loudest register that tab
    // has, and names the one setting that fixes it — see
    // src/dashboard/components/setup/sections/declared.tsx. What #57 was is a deployment
    // that refused everything and explained nothing.
    const response = await post({ origin: DEPLOYMENT }, 'https://maya.build/notes/leaving')

    expect(response.status).toBe(403)
    expect(await countComments()).toBe(0)
  })

  it('says which setting to fix when it refuses one', async () => {
    const body = await (
      await post({ origin: DEPLOYMENT }, 'https://maya.build/notes/leaving')
    ).text()

    expect(body).toContain('/admin')
    expect(body).toMatch(/site’s address/)
  })

  it('echoes the allow-origin header back, so the browser hands the answer over', async () => {
    const response = await post({ origin: DEPLOYMENT })

    expect(response.headers.get('access-control-allow-origin')).toBe(DEPLOYMENT)
    expect(response.headers.get('vary')).toBe('Origin')
  })

  it('answers its own origin’s preflight, so a JSON submission is never blocked', async () => {
    const response = await exports.default.fetch(`${DEPLOYMENT}/comments`, {
      method: 'OPTIONS',
      headers: { origin: DEPLOYMENT, 'access-control-request-method': 'POST' },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(DEPLOYMENT)
  })

  it('still refuses another site’s page, and stores nothing — fail closed, card rule 5', async () => {
    const response = await post({ origin: 'https://evil.example' })

    expect(response.status).toBe(403)
    expect(await countComments()).toBe(0)
  })

  it('tells the site owner where the allowlist actually is when it refuses', async () => {
    const response = await post({ origin: 'https://maya.build' })

    const body = await response.text()
    expect(body).toContain('/admin')
    expect(body).toContain('Turnstile')
  })

  it('writes no settings row on the way, however many comments it takes', async () => {
    // The default is derived per request and stored nowhere. If it were seeded
    // instead, this is where the seed would show up — and an attacker who could ever
    // influence the hostname once would have widened the allowlist for good.
    await post({ origin: DEPLOYMENT })
    await post({ origin: 'https://evil.example' })

    expect(await countSettings()).toBe(0)
  })
})
