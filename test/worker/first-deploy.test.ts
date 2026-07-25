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

function post(headers: Record<string, string>) {
  return exports.default.fetch(`${DEPLOYMENT}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      authorName: 'Rahul Kanwar',
      body: 'The part people underestimate is the export, and nobody checks it until they leave.',
      url: 'https://maya.build/notes/leaving',
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

  it('accepts a comment posted from its own origin, and stores it', async () => {
    const response = await post({ origin: DEPLOYMENT })

    expect(response.status).toBe(202)
    expect(await countComments()).toBe(1)
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
