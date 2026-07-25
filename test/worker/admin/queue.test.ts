// The two endpoints that make moderation possible, driven through the Worker.
// Before these, setCommentStatus had no caller anywhere in src/ and a stored
// comment could never be judged.

import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getOrCreateThread, insertComment } from '../../../src/db'
import { app } from '../../../src/index'
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
const t0 = 1_753_300_000

let cookie: string
let threadId: number

async function seed(count: number, spamReason: string | null = null): Promise<number[]> {
  const ids: number[] = []
  for (let index = 0; index < count; index++) {
    const stored = await insertComment(db, {
      threadId,
      authorName: `Commenter ${index}`,
      body: `comment ${index}`,
      bodyHash: `h${index}`,
      spamReason,
      now: t0 + index,
    })
    ids.push(stored.id)
  }
  return ids
}

function get(path: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${origin}${path}`, { headers: { cookie, ...headers } })
}

function moderate(id: string | number, body: unknown, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${origin}/admin/api/comments/${id}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

interface QueueBody {
  comments: {
    id: number
    status: string
    pageKey: string
    pageTitle: string | null
    spamReason: string | null
  }[]
  nextCursor: string | null
}

interface DecisionBody {
  id: number
  status: string
  moderatedAt: number
}

async function statusOf(id: number): Promise<string | undefined> {
  const row = await db
    .prepare('select status from comments where id = ?1')
    .bind(id)
    .first<{ status: string }>()
  return row?.status
}

beforeEach(async () => {
  configurePassword(TEST_PASSWORD)
  stubLimiter(true)
  const { token } = await issueSession(TEST_PASSWORD, Math.floor(Date.now() / 1000))
  cookie = `${SESSION_COOKIE_NAME}=${token}`

  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  const thread = await getOrCreateThread(db, {
    pageKey: '/notes/leaving',
    pageUrl: 'https://maya.build/notes/leaving',
    title: 'Leaving the comment industry',
    now: t0,
  })
  threadId = thread.id
})

afterEach(() => {
  restoreLimiter()
  restorePassword()
})

describe('GET /admin/api/queue — behind the door', () => {
  it('is a 401 with no session at all', async () => {
    const response = await exports.default.fetch(`${origin}/admin/api/queue`)

    expect(response.status).toBe(401)
  })

  it('is a 401 with a forged session', async () => {
    const response = await get('/admin/api/queue', {
      cookie: `${SESSION_COOKIE_NAME}=1785000000.${'A'.repeat(43)}`,
    })

    expect(response.status).toBe(401)
  })

  it('does not hand a pending comment to an unauthenticated caller', async () => {
    await seed(1)

    const response = await exports.default.fetch(`${origin}/admin/api/queue`)

    expect(await response.text()).not.toContain('comment 0')
  })
})

describe('GET /admin/api/queue — the triage view', () => {
  it('returns the pending queue by default', async () => {
    await seed(3)

    const body = await (await get('/admin/api/queue')).json<QueueBody>()

    expect(body.comments).toHaveLength(3)
    expect(body.comments.every((comment) => comment.status === 'pending')).toBe(true)
  })

  it('carries the page a comment is on, so triage does not need a second read', async () => {
    await seed(1)

    const body = await (await get('/admin/api/queue')).json<QueueBody>()

    expect(body.comments[0]).toMatchObject({
      pageKey: '/notes/leaving',
      pageTitle: 'Leaving the comment industry',
    })
  })

  it('carries why a comment was held (#70)', async () => {
    await seed(1, 'turnstile: unreachable')

    const body = await (await get('/admin/api/queue')).json<QueueBody>()

    expect(body.comments[0]?.spamReason).toBe('turnstile: unreachable')
  })

  it('never carries an email address or an IP hash', async () => {
    await insertComment(db, {
      threadId,
      authorName: 'Rahul',
      authorEmail: 'rahul@example.com',
      body: 'a comment',
      bodyHash: 'hx',
      ipHash: 'deadbeef',
      now: t0,
    })

    const text = await (await get('/admin/api/queue')).text()

    expect(text).not.toContain('rahul@example.com')
    expect(text).not.toContain('deadbeef')
  })

  it('is never cached', async () => {
    expect((await get('/admin/api/queue')).headers.get('cache-control')).toBe('no-store')
  })
})

describe('GET /admin/api/queue — paging', () => {
  it('offers a cursor when there is another page, and honours it', async () => {
    const ids = await seed(5)

    const first = await (await get('/admin/api/queue?limit=2')).json<QueueBody>()
    const second = await (
      await get(`/admin/api/queue?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`)
    ).json<QueueBody>()

    expect(first.comments.map((c) => c.id)).toEqual([ids[4], ids[3]])
    expect(second.comments.map((c) => c.id)).toEqual([ids[2], ids[1]])
  })

  it('offers no cursor on the last page', async () => {
    await seed(2)

    const body = await (await get('/admin/api/queue?limit=10')).json<QueueBody>()

    expect(body.nextCursor).toBeNull()
  })

  it('clamps an oversized page size silently, so the queue never empties', async () => {
    await seed(3)

    const response = await get('/admin/api/queue?limit=1000000')

    expect(response.status).toBe(200)
  })

  it.each([
    ['nonsense', 'next'],
    ['a partial cursor', '1753300000'],
    ['an injection attempt', "1753300000.1' or '1'='1"],
    ['an empty cursor', ''],
  ])('is a 400 for a cursor that is not one — %s', async (_label, cursor) => {
    // Deliberately unlike the silent limit clamp. A silently ignored cursor makes
    // every "next page" return page one, so a paging UI loops over the first page
    // forever with nothing reporting a fault.
    const response = await get(`/admin/api/queue?cursor=${encodeURIComponent(cursor)}`)

    expect(response.status).toBe(400)
  })

  it('names the cursor in the 400, so a client can tell it from a status error', async () => {
    const body = await (await get('/admin/api/queue?cursor=nope')).json()

    expect(body).toEqual({
      error: { code: 'BAD_REQUEST', message: 'That page cursor is not valid.' },
    })
  })
})

describe('GET /admin/api/queue — the status filter', () => {
  it('returns another status when asked for one', async () => {
    const ids = await seed(2)
    await moderate(ids[0] as number, { status: 'spam' })

    const body = await (await get('/admin/api/queue?status=spam')).json<QueueBody>()

    expect(body.comments.map((c) => c.id)).toEqual([ids[0]])
  })

  it.each([['aproved'], ['APPROVED'], ["' or 1=1--"], ['']])(
    'is a 400 for a status that is not one: %s',
    async (status) => {
      const response = await get(`/admin/api/queue?status=${encodeURIComponent(status)}`)

      expect(response.status).toBe(400)
    },
  )
})

describe('POST /admin/api/comments/:id/status — the decision', () => {
  it('approves a comment, which is what nothing in src/ could do before', async () => {
    const [id] = await seed(1)

    const response = await moderate(id as number, { status: 'approved' })

    expect(response.status).toBe(200)
    expect(await statusOf(id as number)).toBe('approved')
  })

  it('marks a comment spam', async () => {
    const [id] = await seed(1)

    await moderate(id as number, { status: 'spam' })

    expect(await statusOf(id as number)).toBe('spam')
  })

  it('records when the decision was taken', async () => {
    const [id] = await seed(1)

    const body = await (await moderate(id as number, { status: 'approved' })).json<DecisionBody>()

    expect(body.moderatedAt).toBeGreaterThan(0)
  })

  it('publishes the comment to the page, end to end', async () => {
    // The whole point. An approval that does not reach the public read is a
    // moderation dashboard that moderates nothing a reader can see.
    const [id] = await seed(1)
    await moderate(id as number, { status: 'approved' })

    const page = await exports.default.fetch(
      `${origin}/comments?url=${encodeURIComponent('https://maya.build/notes/leaving')}`,
    )

    expect(await page.text()).toContain('comment 0')
  })
})

describe('POST /admin/api/comments/:id/status — behind the door', () => {
  it('is a 401 with no session, and changes nothing', async () => {
    const [id] = await seed(1)

    const response = await exports.default.fetch(
      `${origin}/admin/api/comments/${id as number}/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      },
    )

    expect(response.status).toBe(401)
    expect(await statusOf(id as number)).toBe('pending')
  })

  it('is a 401 with an expired session, and changes nothing', async () => {
    const [id] = await seed(1)
    const { token } = await issueSession(TEST_PASSWORD, 0)

    const response = await moderate(
      id as number,
      { status: 'approved' },
      { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    )

    expect(response.status).toBe(401)
    expect(await statusOf(id as number)).toBe('pending')
  })

  it('is a 403 from another origin, and changes nothing', async () => {
    const [id] = await seed(1)

    const response = await moderate(
      id as number,
      { status: 'approved' },
      { origin: 'https://evil.example' },
    )

    expect(response.status).toBe(403)
    expect(await statusOf(id as number)).toBe('pending')
  })

  it('is refused entirely once the dashboard password is unset', async () => {
    const [id] = await seed(1)
    configurePassword(undefined)

    const response = await moderate(id as number, { status: 'approved' })

    expect(response.status).toBe(401)
    expect(await statusOf(id as number)).toBe('pending')
  })
})

describe('POST /admin/api/comments/:id/status — bad input', () => {
  it.each([
    ['a status that is not one', { status: 'published' }],
    ['no status at all', {}],
    ['a numeric status', { status: 1 }],
    ['SQL', { status: "approved'; drop table comments;--" }],
  ])('is a 400: %s', async (_label, body) => {
    const [id] = await seed(1)

    expect((await moderate(id as number, body)).status).toBe(400)
  })

  it('is a 400 for malformed JSON, never a 500', async () => {
    const [id] = await seed(1)

    expect((await moderate(id as number, '{nope')).status).toBe(400)
  })

  it.each([['0'], ['-1'], ['abc'], ['1.5'], ['1e9'], ['0x10'], ['99999999999999999999']])(
    'is a 400 for an id that is not one: %s',
    async (id) => {
      expect((await moderate(id, { status: 'approved' })).status).toBe(400)
    },
  )

  it('is a 404 for a comment that does not exist', async () => {
    const response = await moderate(999_999, { status: 'approved' })

    expect(response.status).toBe(404)
  })

  it('reports the 404 as a 404 rather than as a 500', async () => {
    const body = await (await moderate(999_999, { status: 'approved' })).json()

    expect(body).toEqual({
      error: { code: 'NOT_FOUND', message: 'There is no comment with that id.' },
    })
  })
})

describe('POST /admin/api/comments/:id/status — when the database is the problem', () => {
  // The handler catches `NoSuchCommentError` **by class** and re-throws everything
  // else. Catching whatever setCommentStatus threw would report a D1 outage as "no
  // such comment", which is the report that stops anyone investigating — and the
  // kill-shot on card rule 6 found that no test noticed the difference.
  //
  // Driven through `app.fetch(request, env)` with a poisoned DB rather than through
  // the deployed default export, which is the only way to hand the same route a
  // binding that fails.

  async function requestWithBrokenDb(id: number): Promise<Response> {
    const broken = {
      ...(env as unknown as Record<string, unknown>),
      DB: {
        prepare: () => {
          throw new Error('D1_ERROR: the database is unreachable')
        },
      },
    }
    return await app.fetch(
      new Request(`${origin}/admin/api/comments/${id}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ status: 'approved' }),
      }),
      broken,
    )
  }

  it('is a 500, not a 404 — a broken binding is not a missing comment', async () => {
    const response = await requestWithBrokenDb(1)

    expect(response.status).toBe(500)
  })

  it('leaks nothing about what went wrong', async () => {
    const response = await requestWithBrokenDb(1)
    const body = await response.text()

    expect(body).not.toContain('D1_ERROR')
    expect(body).not.toContain('unreachable')
  })

  it('answers in the one admin error shape, not the public routes plain text', async () => {
    const response = await requestWithBrokenDb(1)

    expect(await response.json()).toEqual({
      error: { code: 'UNAVAILABLE', message: 'Something went wrong. Try again.' },
    })
  })
})
