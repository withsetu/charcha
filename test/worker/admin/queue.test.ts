// The two endpoints that make moderation possible, driven through the Worker.
// Before these, setCommentStatus had no caller anywhere in src/ and a stored
// comment could never be judged.

import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOrCreateThread, insertComment, writeSettings } from '../../../src/db'
import { SITE_URL_SETTING } from '../../../src/settings'
import { runSubmission } from '../../../src/submit/pipeline'
import { allowAllSpamCheck } from '../../../src/submit/spam'
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
    permalink: string | null
    spamReason: string | null
  }[]
  nextCursor: string | null
  counts: Record<string, number>
}

interface DecisionBody {
  id: number
  status: string
  moderatedAt: number
  counts: Record<string, number>
  cascaded: number
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
  await db.exec('DELETE FROM settings')
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

describe('the link to the page a comment was left on (#203)', () => {
  async function siteIs(url: string) {
    await writeSettings(db, [[SITE_URL_SETTING, url]], t0)
  }

  it('builds it from the owner’s site address and the derived key', async () => {
    await siteIs('https://maya.build')
    await seed(1)

    const body = await (await get('/admin/api/queue')).json<QueueBody>()

    expect(body.comments[0]?.permalink).toBe('https://maya.build/notes/leaving')
  })

  it('keeps a site that lives at a subpath on that subpath', async () => {
    // **The key already carries the subpath, because the key is the path the reader was
    // on.** An earlier version of this test seeded `/notes/leaving` against
    // `https://maya.github.io/blog/` and pinned the answer `https://maya.github.io/notes/leaving`
    // under the name "without eating the path" — which is the path being eaten, and would
    // have read as proof that a project-site deployment works.
    await siteIs('https://maya.github.io/blog')
    const thread = await getOrCreateThread(db, {
      pageKey: '/blog/notes/leaving',
      pageUrl: 'https://maya.github.io/blog/notes/leaving',
      title: 'Leaving',
      now: t0 + 300,
    })
    await insertComment(db, {
      threadId: thread.id,
      authorName: 'Rahul',
      body: 'on a project site',
      bodyHash: 'hsub',
      now: t0 + 300,
    })

    const body = await (await get('/admin/api/queue')).json<QueueBody>()

    expect(body.comments[0]?.permalink).toBe('https://maya.github.io/blog/notes/leaving')
  })

  it('sends none when the owner has set no site address', async () => {
    await seed(1)

    const body = await (await get('/admin/api/queue')).json<QueueBody>()

    expect(body.comments[0]?.permalink).toBeNull()
  })

  it('sends none for a data-thread key, which names no page', async () => {
    await siteIs('https://maya.build')
    const thread = await getOrCreateThread(db, {
      pageKey: 'id:leaving',
      pageUrl: null,
      title: 'Leaving',
      now: t0,
    })
    await insertComment(db, {
      threadId: thread.id,
      authorName: 'Rahul',
      body: 'declared thread',
      bodyHash: 'hid',
      now: t0 + 100,
    })

    const body = await (await get('/admin/api/queue')).json<QueueBody>()

    expect(body.comments[0]?.pageKey).toBe('id:leaving')
    expect(body.comments[0]?.permalink).toBeNull()
  })

  it('points at the owner’s own origin when the comment reported somebody else’s', async () => {
    // **The kill-shot for #203.** `derivePageKey` drops the origin, so a comment posted
    // from `https://evil.example/notes/leaving` lands on the owner's thread and writes
    // that origin into `threads.page_url`. A card built from the stored URL would put an
    // attacker's address one click from the buttons that publish comments. Driven through
    // the real submission path rather than seeded, so the attacker's URL travels the route
    // it would actually travel.
    await siteIs('https://maya.build')
    await runSubmission(
      {
        authorName: 'Rahul Kanwar',
        body: 'The part people underestimate is the export.',
        url: 'https://evil.example/notes/leaving',
      },
      { db, spamCheck: allowAllSpamCheck, request: new Request(`${origin}/comments`), now: t0 },
    )

    const response = await get('/admin/api/queue')
    const text = await response.text()
    const body = JSON.parse(text) as QueueBody

    expect(body.comments[0]?.pageKey).toBe('/notes/leaving')
    expect(body.comments[0]?.permalink).toBe('https://maya.build/notes/leaving')
    // Not merely "the permalink is right": nothing in the whole payload carries the
    // origin the attacker chose, because a second field naming it would be the same
    // hole through a different key.
    expect(text).not.toContain('evil.example')
  })

  it('refuses a stored key that would resolve onto another host', async () => {
    // **`startsWith('/')` is not the same test as "on the owner's site".**
    // `//evil.example/pwned` starts with a slash and is a protocol-relative URL, so
    // joining it to `https://maya.build` produces `https://evil.example/pwned`.
    //
    // **The public path cannot produce this key today, and that is not a reason to skip
    // the check.** `canonicalPath` collapses runs of slashes, so a comment posted from
    // `https://anything.example//evil.example/pwned` lands on `/evil.example/pwned` and is
    // harmless — asserted directly below, because if that ever stops being true this test
    // is the one that has to keep holding. But the collapse exists to make `/a//b` and
    // `/a/b` one conversation, and nothing at that line knows it is also what keeps a
    // dashboard link on the owner's domain. The row is reachable by `wrangler d1 execute`
    // and can predate a validator, which is the same argument src/settings.ts makes for
    // re-checking a stored value on the way out. So the key is seeded as a row rather than
    // submitted, which is the state being defended against.
    await siteIs('https://maya.build')
    const thread = await getOrCreateThread(db, {
      pageKey: '//evil.example/pwned',
      pageUrl: null,
      title: 'Not a path',
      now: t0 + 500,
    })
    await insertComment(db, {
      threadId: thread.id,
      authorName: 'Rahul',
      body: 'a comment on a key that is not a path',
      bodyHash: 'hevil',
      now: t0 + 500,
    })

    const response = await get('/admin/api/queue')
    const text = await response.text()
    const body = JSON.parse(text) as QueueBody

    expect(body.comments[0]?.pageKey).toBe('//evil.example/pwned')
    expect(body.comments[0]?.permalink).toBeNull()
    expect(text).not.toContain('https://evil.example')
  })

  it('collapses the slashes a submission would have arrived with, so the key is a path', async () => {
    // The other half of the paragraph above, pinned where somebody changing
    // `canonicalPath` will see it fail.
    await siteIs('https://maya.build')
    await runSubmission(
      {
        authorName: 'Rahul Kanwar',
        body: 'a comment from a doubled slash',
        url: 'https://anything.example//evil.example/pwned',
      },
      { db, spamCheck: allowAllSpamCheck, request: new Request(`${origin}/comments`), now: t0 },
    )

    const body = await (await get('/admin/api/queue')).json<QueueBody>()

    expect(body.comments[0]?.pageKey).toBe('/evil.example/pwned')
    expect(body.comments[0]?.permalink).toBe('https://maya.build/evil.example/pwned')
  })

  it('costs the same three statements however many comments the page holds', async () => {
    // The link added a third read — the owner's `site_url`, once per request rather than
    // once per card. CLAUDE.md's rule is a *constant* query count, not a low one, because
    // the invocation budget throws rather than slows: a permalink resolved per comment
    // would pass at three comments and throw on a busy morning.
    await siteIs('https://maya.build')
    await seed(1)
    const prepare = vi.spyOn(db, 'prepare')
    try {
      await get('/admin/api/queue')
      const forOne = prepare.mock.calls.length
      prepare.mockClear()
      await seed(19)
      prepare.mockClear()
      await get('/admin/api/queue')

      expect(forOne).toBe(3)
      expect(prepare.mock.calls.length).toBe(3)
    } finally {
      prepare.mockRestore()
    }
  })
})

describe('the per-status counts (#135)', () => {
  // The tabs used to render `Pending 1` where the `1` was a keyboard shortcut. These
  // are the numbers that replaced it, so they have to be the database's answer rather
  // than the length of the page that happens to be loaded.

  it('rides along with the queue, so the tabs cost no second request', async () => {
    const ids = await seed(4)
    await moderate(ids[0] as number, { status: 'approved' })
    await moderate(ids[1] as number, { status: 'spam' })

    const body = await (await get('/admin/api/queue')).json<QueueBody>()

    expect(body.counts).toEqual({ pending: 2, spam: 1, approved: 1 })
  })

  it('counts the whole status, not the page that was asked for', async () => {
    // The failure this rules out is the obvious one: a client deriving `Pending 53`
    // from `comments.length` and being told 2 because it asked for two.
    await seed(5)

    const body = await (await get('/admin/api/queue?limit=2')).json<QueueBody>()

    expect(body.comments).toHaveLength(2)
    expect(body.counts.pending).toBe(5)
  })

  it('is zero rather than absent for a status nothing is in', async () => {
    // `group by` returns no row for an empty status, and a missing key renders as
    // `undefined` in a tab. An empty queue is a success state (#13) and needs a value
    // to say so with.
    const body = await (await get('/admin/api/queue')).json<QueueBody>()

    expect(body.counts).toEqual({ pending: 0, spam: 0, approved: 0 })
  })

  it('sends the three the dashboard has views for and no fourth', async () => {
    // `deleted` is counted by the same statement and deliberately not sent: there is no
    // deleted view, so it would be a number with no reader — and the dashboard's
    // `QueueCounts` is keyed by `ViewStatus`, which is what makes a missing view
    // impossible rather than merely unlikely.
    const [id] = await seed(1)
    await moderate(id as number, { status: 'deleted' })

    const body = await (await get('/admin/api/queue')).json<QueueBody>()

    expect(Object.keys(body.counts).sort()).toEqual(['approved', 'pending', 'spam'])
  })

  it('comes back from a decision too, so a badge cannot go stale', async () => {
    const ids = await seed(3)

    const body = await (
      await moderate(ids[0] as number, { status: 'approved' })
    ).json<DecisionBody>()

    expect(body.counts).toEqual({ pending: 2, spam: 0, approved: 1 })
  })

  it('counts the replies a decision cascaded over, which no client-side tally could', async () => {
    // **The reason the decision recomputes instead of the dashboard adding and
    // subtracting one.** setCommentStatus hides the replies under a comment as well as
    // the comment, so marking one root spam moves four here. A client keeping its own
    // tally would be wrong by three, and nothing on screen would reveal it.
    const [root] = await seed(1)
    await moderate(root as number, { status: 'approved' })
    for (let index = 0; index < 3; index++) {
      await insertComment(db, {
        threadId,
        parentId: root,
        authorName: `Replier ${String(index)}`,
        body: `reply ${String(index)}`,
        bodyHash: `r${String(index)}`,
        now: t0 + 100 + index,
      })
    }

    const body = await (await moderate(root as number, { status: 'spam' })).json<DecisionBody>()

    expect(body.counts).toEqual({ pending: 0, spam: 4, approved: 0 })
  })

  // #133. The counts say the queue moved by four; without this the response says only
  // that one comment changed, and the dashboard has nothing to explain the other three
  // with. setCommentStatus has computed it since #12 and the endpoint threw it away.
  it('says how many replies the decision took with it', async () => {
    const [root] = await seed(1)
    for (let index = 0; index < 3; index++) {
      await insertComment(db, {
        threadId,
        parentId: root,
        authorName: `Replier ${String(index)}`,
        body: `reply ${String(index)}`,
        bodyHash: `r${String(index)}`,
        now: t0 + 100 + index,
      })
    }

    const body = await (await moderate(root as number, { status: 'spam' })).json<DecisionBody>()

    expect(body.cascaded).toBe(3)
  })

  // **The number is free, and this is what says so.** CLAUDE.md's rule is a *constant*
  // query count rather than a low one, because the 50-per-invocation budget throws
  // rather than slows — so a count of replies that cost a query per reply would fail
  // exactly on the comment popular enough to need it. `cascaded` comes out of the
  // statement that was already being sent.
  //
  // **Three since #10, and the third is the classifier's.** A decision is now also a
  // training example, so the handler reads the comment it was given — one row, by
  // primary key, `TRAINING_SUBJECT_SQL`. It reads *the* comment and not the replies
  // the cascade moved, which is #28's whole point and is asserted directly in
  // test/worker/spam/train.test.ts.
  //
  // It stops at three here because the embedding cannot be taken: this suite runs
  // against a real `AI` binding with no local simulation, so `env.AI.run` throws
  // "Binding AI needs to be run remotely", src/spam/embed.ts catches it, and training
  // abstains before it would write. That is itself worth having pinned — **a decision
  // must still be recorded when Workers AI is unreachable** — and the count for a
  // training run that *succeeds* is pinned separately, with an injected embedder, in
  // test/worker/spam/train.test.ts.
  it('spends the same three statements however many replies the decision moves', async () => {
    const [alone] = await seed(1)
    const [crowded] = await seed(1)
    for (let index = 0; index < 12; index++) {
      await insertComment(db, {
        threadId,
        parentId: crowded,
        authorName: `Replier ${String(index)}`,
        body: `reply ${String(index)}`,
        bodyHash: `c${String(index)}`,
        now: t0 + 200 + index,
      })
    }

    const prepare = vi.spyOn(db, 'prepare')
    try {
      await moderate(alone as number, { status: 'spam' })
      const forOne = prepare.mock.calls.length
      prepare.mockClear()
      await moderate(crowded as number, { status: 'spam' })
      const forTwelve = prepare.mock.calls.length

      expect(forOne).toBe(3)
      expect(forTwelve).toBe(3)
    } finally {
      prepare.mockRestore()
    }
  })

  it('says zero for a decision that took nothing with it', async () => {
    // Present and zero rather than absent, for the reason the counts are zero-filled: a
    // dashboard handed `undefined` renders it, and "and undefined replies" is a worse
    // answer than the true one.
    const [id] = await seed(1)

    const body = await (await moderate(id as number, { status: 'approved' })).json<DecisionBody>()

    expect(body.cascaded).toBe(0)
  })

  it('tells an unauthenticated caller nothing about how much is unmoderated', async () => {
    // A public comment count is an information leak about unpublished content, so the
    // count lives behind the same door as everything else under /admin/api.
    await seed(7)

    const response = await exports.default.fetch(`${origin}/admin/api/queue`)

    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain('7')
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
