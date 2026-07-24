import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { getOrCreateThread, insertComment, setCommentStatus } from '../../../src/db'
import { ALLOWED_ORIGINS_SETTING } from '../../../src/cors'
import { READ_CACHE_MAX_AGE_SECONDS } from '../../../src/read/route'

const db = env.DB
const worker = 'https://charcha.example'
const site = 'https://maya.build'
const t0 = 1_753_300_000

function read(params: Record<string, string>, headers: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString()
  return exports.default.fetch(`${worker}/comments?${query}`, { headers })
}

async function allowOrigin(origin: string) {
  await db
    .prepare('insert or replace into settings (key, value, updated_at) values (?1, ?2, ?3)')
    .bind(ALLOWED_ORIGINS_SETTING, origin, t0)
    .run()
}

/** One approved root, one approved reply, one still in the queue. */
async function seedConversation(pageKey = '/notes/leaving') {
  const thread = await getOrCreateThread(db, { pageKey, pageUrl: `${site}${pageKey}`, now: t0 })
  const root = await insertComment(db, {
    threadId: thread.id,
    authorName: 'Rahul Kanwar',
    authorEmail: 'rahul@example.com',
    body: 'The export is the hard part.',
    bodyHash: 'h1',
    ipHash: 'ip-hash-1',
    now: t0,
  })
  const reply = await insertComment(db, {
    threadId: thread.id,
    parentId: root.id,
    authorName: 'Maya',
    body: 'Agreed, and nobody tests it.',
    bodyHash: 'h2',
    now: t0 + 10,
  })
  await insertComment(db, {
    threadId: thread.id,
    authorName: 'Priya',
    body: 'still waiting for review',
    bodyHash: 'h3',
    now: t0 + 20,
  })
  await setCommentStatus(db, root.id, 'approved', t0 + 30)
  await setCommentStatus(db, reply.id, 'approved', t0 + 30)
  return { thread, root, reply }
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  await db.exec('DELETE FROM settings')
})

describe('GET /comments — the read half of the embed contract', () => {
  it('returns the page conversation as HTML, not JSON', async () => {
    await seedConversation()

    const response = await read({ url: `${site}/notes/leaving` })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
    expect(body).toContain('charcha-comments')
    expect(body).toContain('The export is the hard part.')
    expect(body).toContain('Agreed, and nobody tests it.')
  })

  it('nests the reply under its root, through the one renderer', async () => {
    await seedConversation()

    const body = await read({ url: `${site}/notes/leaving` }).then((r) => r.text())

    expect(body).toContain('charcha-replies')
  })

  it('does not show a comment still held for review', async () => {
    await seedConversation()

    const body = await read({ url: `${site}/notes/leaving` }).then((r) => r.text())

    expect(body).not.toContain('still waiting for review')
  })

  it('never sends an email address or an IP hash to the page', async () => {
    await seedConversation()

    const body = await read({ url: `${site}/notes/leaving` }).then((r) => r.text())

    expect(body).not.toContain('rahul@example.com')
    expect(body).not.toContain('ip-hash-1')
  })

  it('renders an unknown page as empty, never as a 404', async () => {
    // A page nobody has commented on is indistinguishable from a page with no
    // comments, and that is correct: a 404 would make the embed show an error on
    // every quiet page on the site.
    const response = await read({ url: `${site}/a-page-nobody-has-commented-on` })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('charcha-empty')
  })

  it('creates nothing — reading a page must not spend the write budget', async () => {
    await read({ url: `${site}/a-page-nobody-has-commented-on` })

    const threads = await db.prepare('select count(*) as n from threads').first<{ n: number }>()
    expect(threads?.n).toBe(0)
  })

  it('lands on the same thread the POST wrote to, for the same URL', async () => {
    // The read derives its key with src/page-key.ts exactly as the submission path
    // does. If the two ever disagreed, a reader would post to one thread and then
    // be shown another — and every test on either side would still pass.
    const posted = await exports.default.fetch(`${worker}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        authorName: 'Rahul Kanwar',
        body: 'posted through the pipeline',
        url: `${site}/notes/leaving/`,
      }),
    })
    expect(posted.status).toBe(202)

    const stored = await db.prepare('select id from comments').first<{ id: number }>()
    await setCommentStatus(db, stored!.id, 'approved', t0)

    const body = await read({ url: `${site}/notes/leaving` }).then((r) => r.text())
    expect(body).toContain('posted through the pipeline')
  })
})

describe('GET /comments — the untrusted URL', () => {
  it('refuses a request that names no page at all', async () => {
    const response = await read({})

    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toMatch(/text\/plain/)
  })

  it('refuses a page address that is not a URL', async () => {
    const response = await read({ url: 'not-a-url' })

    expect(response.status).toBe(400)
    expect(await response.text()).toMatch(/not valid/i)
  })

  it('refuses a scheme that is not http or https', async () => {
    const response = await read({ url: 'javascript:alert(1)' })

    expect(response.status).toBe(400)
  })

  it('refuses a page address past the cap before parsing it', async () => {
    const response = await read({ url: `${site}/${'x'.repeat(3000)}` })

    expect(response.status).toBe(400)
    expect(await response.text()).toMatch(/too long/i)
  })

  it('refuses a thread id that is not a slug', async () => {
    const response = await read({ thread: '../../etc/passwd' })

    expect(response.status).toBe(400)
  })

  it('never reflects the raw input back into the response', async () => {
    const response = await read({ url: `${site}/<script>alert(1)</script>` })
    const body = await response.text()

    expect(body).not.toContain('<script>')
    expect(body).not.toContain('alert(1)')
  })

  it('never leaks an internal message on a rejection', async () => {
    const body = await read({ url: 'gopher://x' }).then((r) => r.text())

    expect(body).not.toMatch(/d1_|prepare|sqlite|unsupported-scheme|derivePageKey/i)
  })

  it('accepts the owner-declared thread id instead of a URL', async () => {
    await getOrCreateThread(db, { pageKey: 'id:leaving', now: t0 })
    const thread = await db
      .prepare('select id from threads where page_key = ?1')
      .bind('id:leaving')
      .first<{ id: number }>()
    const comment = await insertComment(db, {
      threadId: thread!.id,
      authorName: 'Maya',
      body: 'found by thread id',
      bodyHash: 'h1',
      now: t0,
    })
    await setCommentStatus(db, comment.id, 'approved', t0)

    const body = await read({ thread: 'leaving' }).then((r) => r.text())

    expect(body).toContain('found by thread id')
  })
})

describe('GET /comments — caching', () => {
  it('is cacheable by the reader browser only, never by a shared cache', async () => {
    // `private` is load-bearing, not conservatism. The response carries an
    // origin-specific Access-Control-Allow-Origin, and Cloudflare's cache does not
    // honour `Vary: Origin` by default — only `Vary: Accept-Encoding`. A shared
    // cache would therefore hand one site's allow-origin header to another site's
    // reader and break the embed there.
    // https://developers.cloudflare.com/cache/concepts/vary/
    const response = await read({ url: `${site}/notes/leaving` })
    const cacheControl = response.headers.get('cache-control')

    expect(cacheControl).toContain('private')
    expect(cacheControl).not.toContain('public')
    expect(cacheControl).toContain(`max-age=${READ_CACHE_MAX_AGE_SECONDS}`)
  })

  it('declares that the response depends on the request Origin', async () => {
    const response = await read({ url: `${site}/notes/leaving` })

    expect(response.headers.get('vary')?.toLowerCase()).toContain('origin')
  })

  it('does not cache a rejection, so fixing the URL is not a stale answer', async () => {
    const response = await read({ url: 'not-a-url' })

    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})

describe('CORS — the origin allowlist over HTTP', () => {
  it('allows a configured origin on the read', async () => {
    await allowOrigin(site)
    await seedConversation()

    const response = await read({ url: `${site}/notes/leaving` }, { origin: site })

    expect(response.headers.get('access-control-allow-origin')).toBe(site)
  })

  it('sends no allow-origin header to an origin the owner never listed', async () => {
    await allowOrigin(site)

    const response = await read(
      { url: `${site}/notes/leaving` },
      { origin: 'https://evil.example' },
    )

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('sends no allow-origin header when the owner has configured nothing — fail closed', async () => {
    const response = await read({ url: `${site}/notes/leaving` }, { origin: site })

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('still answers a request that carries no Origin, for the v1.1 build-time path', async () => {
    await seedConversation()

    const response = await read({ url: `${site}/notes/leaving` })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('never claims to accept credentials — card rule 8, no reader-side cookies', async () => {
    await allowOrigin(site)

    const response = await read({ url: `${site}/notes/leaving` }, { origin: site })

    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('allows a configured origin on the write, too', async () => {
    await allowOrigin(site)

    const response = await exports.default.fetch(`${worker}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: site },
      body: JSON.stringify({ authorName: 'Maya', body: 'hello', url: `${site}/notes/leaving` }),
    })

    expect(response.status).toBe(202)
    expect(response.headers.get('access-control-allow-origin')).toBe(site)
  })

  it('sends no allow-origin header on a write from an unlisted origin', async () => {
    await allowOrigin(site)

    const response = await exports.default.fetch(`${worker}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ authorName: 'Evil', body: 'hello', url: `${site}/notes/leaving` }),
    })

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('OPTIONS /comments — the preflight', () => {
  function preflight(headers: Record<string, string>) {
    return exports.default.fetch(`${worker}/comments`, { method: 'OPTIONS', headers })
  }

  it('approves a preflight from a configured origin', async () => {
    await allowOrigin(site)

    const response = await preflight({
      origin: site,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(site)
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
    expect(response.headers.get('access-control-allow-methods')).toContain('GET')
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'content-type',
    )
    expect(Number(response.headers.get('access-control-max-age'))).toBeGreaterThan(0)
  })

  it('refuses a preflight from an origin the owner never listed', async () => {
    await allowOrigin(site)

    const response = await preflight({
      origin: 'https://evil.example',
      'access-control-request-method': 'POST',
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('refuses a preflight when the owner has configured no allowlist at all', async () => {
    const response = await preflight({
      origin: site,
      'access-control-request-method': 'POST',
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  // The submit endpoint takes application/json, which is not a CORS-safelisted
  // content type, so every cross-origin POST from the embed is preflighted. The
  // preflight is therefore the gate that actually stops another site's page from
  // posting into this deployment's queue from a reader's browser.
  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS
  it('never approves credentials on the preflight either', async () => {
    await allowOrigin(site)

    const response = await preflight({ origin: site, 'access-control-request-method': 'POST' })

    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('varies on Origin so no cache can reuse one origin’s answer for another', async () => {
    await allowOrigin(site)

    const response = await preflight({ origin: site, 'access-control-request-method': 'POST' })

    expect(response.headers.get('vary')?.toLowerCase()).toContain('origin')
  })
})
