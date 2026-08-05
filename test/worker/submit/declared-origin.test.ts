// Issue #224 — the submitted `url` has to be on an address the owner declared, and a
// deployment that has declared none accepts nothing.
//
// **Driven through the deployed Worker rather than through the pipeline**, for the reason
// test/worker/first-deploy.test.ts states: #57 was a route-level fact, and a check that is
// written and then not reached from `POST /comments` passes every unit test there is. The
// attack this closes is a request with **no `Origin` header at all** — curl — carrying
// `url: "https://evil.example/notes/leaving"`. `derivePageKey` drops the origin, so that
// request used to land on the legitimate `/notes/leaving` thread while `threads.page_url`
// kept the attacker's address, one click from the buttons that publish comments.
//
// The refusal is deliberately the same message and status in every case, and the *reason*
// separating a misconfiguration from an attack goes to the log. See src/cors.ts.

import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALLOWED_ORIGINS_SETTING } from '../../../src/cors'
import { writeSetting } from '../../../src/db'
import { SITE_URL_SETTING } from '../../../src/settings'
import { ELAPSED_FIELD, HONEYPOT_FIELD } from '../../../src/spam/fields'

const db = env.DB

/** The address this deployment answers on, as the Worker sees it in `request.url`. */
const DEPLOYMENT = 'https://chaipecharcha.example.workers.dev'

function post(url: string, headers: Record<string, string> = {}) {
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

async function pageUrls() {
  const { results } = await db.prepare('select page_url from threads').all<{ page_url: string }>()
  return results.map((row) => row.page_url)
}

async function declare(key: string, value: string) {
  await writeSetting(db, key, value, 1_753_300_000)
}

let lines: string[] = []

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  await db.exec('DELETE FROM settings')
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The structured lines this refusal writes, parsed. */
function refusals(): Array<Record<string, unknown>> {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return {}
      }
    })
    .filter((record) => record['event'] === 'submitted_url_refused')
}

describe('a deployment that has declared nothing', () => {
  it('refuses a comment for another address, and stores nothing — fail closed', async () => {
    const response = await post('https://maya.build/notes/leaving')

    expect(response.status).toBe(403)
    expect(await countComments()).toBe(0)
  })

  it('refuses it even when the browser is on this deployment’s own origin', async () => {
    // The CORS check passes — this is a same-origin request — and the url check is what
    // refuses. Two different questions: which *page* posted, and which *site* the comment
    // claims to be on.
    const response = await post('https://maya.build/notes/leaving', { origin: DEPLOYMENT })

    expect(response.status).toBe(403)
    expect(await countComments()).toBe(0)
  })

  it('tells the site owner the one thing to do about it', async () => {
    const body = await (await post('https://maya.build/notes/leaving')).text()

    expect(body).toContain('/admin')
    expect(body).toMatch(/address/i)
  })

  it('says in the log which check fired, and that nothing was declared', async () => {
    await post('https://maya.build/notes/leaving')

    expect(refusals().at(-1)?.['reason']).toBe('nothing-declared')
  })

  it('still accepts a comment whose url is on this deployment’s own address (#57)', async () => {
    // `selfOrigin` is declared by derivation, which is what keeps a deployment serving its
    // own pages working with no settings row at all.
    const response = await post(`${DEPLOYMENT}/notes/leaving`)

    expect(response.status).toBe(202)
    expect(await countComments()).toBe(1)
  })
})

describe('a deployment that declared its site address', () => {
  beforeEach(async () => {
    await declare(SITE_URL_SETTING, 'https://maya.build')
  })

  it('accepts a comment from a page on that site', async () => {
    const response = await post('https://maya.build/notes/leaving')

    expect(response.status).toBe(202)
    expect(await countComments()).toBe(1)
  })

  it('refuses a comment claiming to be on another site, and stores nothing', async () => {
    const response = await post('https://evil.example/notes/leaving')

    expect(response.status).toBe(403)
    expect(await countComments()).toBe(0)
    expect(await pageUrls()).toEqual([])
  })

  it('says in the log that the address was not one of the declared ones', async () => {
    await post('https://evil.example/notes/leaving')

    expect(refusals().at(-1)?.['reason']).toBe('undeclared-origin')
  })

  it('leaves page_url on the owner’s own address for every thread it does store', async () => {
    // The property this whole check buys: `threads.page_url` is trustworthy at rest, which
    // is what lets the queue link to the page (#203, #224).
    await post('https://maya.build/notes/leaving')
    await post('https://evil.example/notes/leaving')

    expect(await pageUrls()).toEqual(['https://maya.build/notes/leaving'])
  })

  it('accepts the www spelling of the same declaration', async () => {
    const response = await post('https://www.maya.build/notes/leaving')

    expect(response.status).toBe(202)
    expect(await countComments()).toBe(1)
  })

  it('does not admit an arbitrary subdomain — that would be a wildcard', async () => {
    const response = await post('https://blog.maya.build/notes/leaving')

    expect(response.status).toBe(403)
    expect(await countComments()).toBe(0)
  })

  it('refuses the same host over a scheme the owner did not declare', async () => {
    const response = await post('http://maya.build/notes/leaving')

    expect(response.status).toBe(403)
  })

  it('refuses a data-thread submission that reports no url at all', async () => {
    // A `data-thread` key with no url has no address to check, and the embed always sends
    // one (src/embed/mount.ts sends `location.href`). Fail closed rather than leave the
    // one door on this path that no origin check covers — that door is the whole bug.
    const response = await exports.default.fetch(`${DEPLOYMENT}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: DEPLOYMENT },
      body: JSON.stringify({
        authorName: 'Rahul Kanwar',
        body: 'A key with no page behind it, which is the shape that has nothing to check.',
        thread: 'leaving',
        [HONEYPOT_FIELD]: '',
        [ELAPSED_FIELD]: 31_000,
      }),
    })

    expect(response.status).toBe(403)
    expect(await countComments()).toBe(0)
    expect(refusals().at(-1)?.['reason']).toBe('no-url')
  })

  it('accepts a data-thread submission whose url is on the declared site', async () => {
    const response = await exports.default.fetch(`${DEPLOYMENT}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        authorName: 'Rahul Kanwar',
        body: 'A conversation rather than a page, and still on the owner’s own site.',
        url: 'https://maya.build/notes/leaving',
        thread: 'leaving',
        [HONEYPOT_FIELD]: '',
        [ELAPSED_FIELD]: 31_000,
      }),
    })

    expect(response.status).toBe(202)
  })
})

describe('a deployment that declared the www spelling', () => {
  it('accepts the apex too, so nobody has to type both', async () => {
    await declare(SITE_URL_SETTING, 'https://www.maya.build')

    const response = await post('https://maya.build/notes/leaving')

    expect(response.status).toBe(202)
  })
})

describe('a deployment that declared origins rather than a site address', () => {
  it('accepts a comment from a page on one of them', async () => {
    await declare(ALLOWED_ORIGINS_SETTING, 'https://maya.build\nhttps://staging.maya.build')

    expect((await post('https://staging.maya.build/notes/leaving')).status).toBe(202)
  })

  it('accepts a subdomain the owner listed explicitly', async () => {
    await declare(ALLOWED_ORIGINS_SETTING, 'https://blog.maya.build')

    expect((await post('https://blog.maya.build/notes/leaving')).status).toBe(202)
  })

  it('refuses everything else', async () => {
    await declare(ALLOWED_ORIGINS_SETTING, 'https://maya.build')

    expect((await post('https://evil.example/x')).status).toBe(403)
  })
})

describe('the browser origin check and the url check are both in force', () => {
  it('refuses an unlisted browser origin even when the url is declared', async () => {
    await declare(SITE_URL_SETTING, 'https://maya.build')

    const response = await post('https://maya.build/notes/leaving', {
      origin: 'https://evil.example',
    })

    expect(response.status).toBe(403)
    expect(await countComments()).toBe(0)
  })

  it('accepts a browser on the www spelling of the declared site address', async () => {
    // Without this the www rule would be dead on the only caller that has an `Origin`:
    // a reader's browser is refused by CORS before the url check is ever reached.
    await declare(SITE_URL_SETTING, 'https://maya.build')

    const response = await post('https://www.maya.build/notes/leaving', {
      origin: 'https://www.maya.build',
    })

    expect(response.status).toBe(202)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://www.maya.build')
  })
})
