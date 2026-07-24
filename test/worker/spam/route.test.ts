// Driven through the deployed Worker, not through the layer objects — this is the
// test that would catch the spam check being wired up in src/index.ts and then not
// actually reached, which every unit test above would happily pass.

import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { ELAPSED_FIELD, HONEYPOT_FIELD } from '../../../src/spam/fields'

const db = env.DB
const origin = 'https://charcha.example'

function post(fields: Record<string, unknown>) {
  return exports.default.fetch(`${origin}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      authorName: 'Rahul Kanwar',
      body: 'The part people underestimate is the export, and nobody checks it until they leave.',
      url: 'https://maya.build/notes/leaving',
      [HONEYPOT_FIELD]: '',
      [ELAPSED_FIELD]: 31_000,
      ...fields,
    }),
  })
}

async function countComments() {
  const row = await db.prepare('select count(*) as n from comments').first<{ n: number }>()
  return row?.n ?? -1
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

describe('POST /comments — the spam layers are actually wired into the Worker', () => {
  it('accepts a comment that passes every layer', async () => {
    const response = await post({})

    expect(response.status).toBe(202)
    expect(await countComments()).toBe(1)
  })

  it('answers 403 and stores nothing when the honeypot was filled', async () => {
    const response = await post({ [HONEYPOT_FIELD]: 'https://buy-pills.example' })

    expect(response.status).toBe(403)
    expect(await countComments()).toBe(0)
  })

  it('answers 403 and stores nothing when the form was submitted instantly', async () => {
    const response = await post({ [ELAPSED_FIELD]: 30 })

    expect(response.status).toBe(403)
    expect(await countComments()).toBe(0)
  })

  it('answers 403 to the second copy of the same comment on the same page', async () => {
    expect((await post({})).status).toBe(202)

    const second = await post({})

    expect(second.status).toBe(403)
    expect(await countComments()).toBe(1)
  })

  it('does not tell the rejected caller which layer stopped it', async () => {
    const response = await post({ [HONEYPOT_FIELD]: 'filled' })

    const text = await response.text()
    expect(text).not.toMatch(/honeypot|turnstile|rate|duplicate|layer/i)
  })

  it('still holds a comment for review rather than losing it when the timing field is absent', async () => {
    // A stale cached embed sends no timing field. The reader must not lose their
    // comment over it — 202, stored, queued.
    const response = await exports.default.fetch(`${origin}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        authorName: 'Rahul Kanwar',
        body: 'A comment from an embed too old to send the timing field.',
        url: 'https://maya.build/notes/leaving',
      }),
    })

    expect(response.status).toBe(202)
    expect(await countComments()).toBe(1)
  })
})
