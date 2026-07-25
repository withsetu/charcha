import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { runSubmission } from '../../../src/submit/pipeline'
import { allowAllSpamCheck } from '../../../src/submit/spam'
import type { SpamCheck, SpamCheckContext, SpamVerdict } from '../../../src/submit/spam'

const db = env.DB
const t0 = 1_753_300_000
const request = new Request('https://charcha.example/comments', { method: 'POST' })

function verdict(action: SpamVerdict): SpamCheck {
  return { check: () => Promise.resolve(action) }
}

async function countThreads() {
  const row = await db.prepare('select count(*) as n from threads').first<{ n: number }>()
  return row?.n ?? -1
}

async function countComments() {
  const row = await db.prepare('select count(*) as n from comments').first<{ n: number }>()
  return row?.n ?? -1
}

function deps(spamCheck: SpamCheck = allowAllSpamCheck) {
  return { db, spamCheck, request, now: t0 }
}

const validRoot = {
  authorName: 'Rahul Kanwar',
  body: 'The part people underestimate is the export.',
  url: 'https://maya.build/notes/leaving',
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

describe('runSubmission — a good comment the spam layers allow', () => {
  it('stores it as pending, because the moderation queue is the human gate', async () => {
    const result = await runSubmission(validRoot, deps())

    expect(result.outcome).toBe('pending')
    const stored = await db
      .prepare('select status, body from comments')
      .first<{ status: string; body: string }>()
    expect(stored?.status).toBe('pending')
    expect(stored?.body).toBe(validRoot.body)
  })

  it('returns the comment rendered as HTML, not JSON', async () => {
    const result = await runSubmission(validRoot, deps())

    if (result.outcome !== 'pending') throw new Error('expected pending')
    expect(result.html).toContain('charcha-comment')
    expect(result.html).toContain('The part people underestimate is the export.')
  })

  it('opens the thread for the derived page key, keyed off the URL not a client value', async () => {
    await runSubmission(validRoot, deps())

    const thread = await db.prepare('select page_key from threads').first<{ page_key: string }>()
    // The origin is dropped and the path is the key — see src/page-key.ts.
    expect(thread?.page_key).toBe('/notes/leaving')
  })
})

describe('runSubmission — a comment the spam layers reject', () => {
  it('does not store it, and says so distinctly from a success', async () => {
    const result = await runSubmission(
      validRoot,
      deps(verdict({ action: 'reject', reason: 'honeypot' })),
    )

    expect(result.outcome).toBe('rejected')
    expect(await countComments()).toBe(0)
  })

  it('writes nothing at all — not even the thread row — so a spammer cannot burn the write budget', async () => {
    // getOrCreateThread writes. If the spam check ran after it, a rejected flood
    // would still spend the 100k/day write allowance and litter the threads table.
    await runSubmission(validRoot, deps(verdict({ action: 'reject', reason: 'honeypot' })))

    expect(await countThreads()).toBe(0)
  })

  it('does not leak which layer caught it', async () => {
    const result = await runSubmission(
      validRoot,
      deps(verdict({ action: 'reject', reason: 'honeypot field was filled' })),
    )

    if (result.outcome !== 'rejected') throw new Error('expected rejected')
    expect(result.message).not.toMatch(/honeypot/i)
  })
})

describe('runSubmission — a comment held for review', () => {
  it('persists as pending, the same landing spot as allow on this public route', async () => {
    const result = await runSubmission(
      validRoot,
      deps(verdict({ action: 'review', reason: 'low classifier confidence' })),
    )

    expect(result.outcome).toBe('pending')
    expect(await countComments()).toBe(1)
    const stored = await db.prepare('select status from comments').first<{ status: string }>()
    expect(stored?.status).toBe('pending')
  })

  // #70. Before this, `review` and `allow` produced byte-identical rows and the
  // moderator could not tell a comment held because Turnstile was down from one
  // that arrived clean.
  it('records why it was held, so the human gate is told what it is being asked', async () => {
    await runSubmission(
      validRoot,
      deps(verdict({ action: 'review', reason: 'turnstile: unreachable' })),
    )

    const stored = await db
      .prepare('select spam_reason from comments')
      .first<{ spam_reason: string | null }>()
    expect(stored?.spam_reason).toBe('turnstile: unreachable')
  })

  it('records no reason for a comment no layer doubted', async () => {
    await runSubmission(validRoot, deps())

    const stored = await db
      .prepare('select spam_reason from comments')
      .first<{ spam_reason: string | null }>()
    expect(stored?.spam_reason).toBeNull()
  })

  it('costs the same one insert it always did, so the query budget is unchanged', async () => {
    // #70 adds a column, not a statement. A second write here would be a second
    // row written per comment against the 100k/day budget.
    const before = await countComments()
    await runSubmission(
      validRoot,
      deps(verdict({ action: 'review', reason: 'content: many-links' })),
    )

    expect(await countComments()).toBe(before + 1)
  })
})

describe('runSubmission — the spam seam gets what #8 needs', () => {
  it('hands the check the derived key, the raw form, the request and the clock', async () => {
    let seen: SpamCheckContext | undefined
    const capture: SpamCheck = {
      check(context) {
        seen = context
        return Promise.resolve<SpamVerdict>({ action: 'allow' })
      },
    }

    await runSubmission(
      { ...validRoot, hp: '', t: t0 * 1000 },
      { db, spamCheck: capture, request, now: t0 },
    )

    expect(seen?.pageKey).toBe('/notes/leaving')
    expect(seen?.comment.body).toBe(validRoot.body)
    // The honeypot and timestamp are the embed's transport: stripped from the
    // validated comment, but present in the raw form for #8 to inspect.
    expect(seen?.form.hp).toBe('')
    expect(seen?.form.t).toBe(t0 * 1000)
    expect(seen?.request).toBe(request)
    // #8's rate-limiting and duplicate-body layers read history — without the db
    // handle in the context they could not be built behind this seam.
    expect(seen?.db).toBe(db)
    expect(seen?.now).toBe(t0)
  })

  it('runs the check before the write, so a reject never touches the database', async () => {
    let sawRowsAtCheckTime = -1
    const nosy: SpamCheck = {
      async check() {
        sawRowsAtCheckTime = await countComments()
        return { action: 'reject', reason: 'x' }
      },
    }

    await runSubmission(validRoot, { db, spamCheck: nosy, request, now: t0 })

    expect(sawRowsAtCheckTime).toBe(0)
  })
})

describe('runSubmission — invalid input never reaches the spam check or the database', () => {
  it('rejects a missing body as invalid, before any layer or write', async () => {
    let checked = false
    const spy: SpamCheck = {
      check() {
        checked = true
        return Promise.resolve<SpamVerdict>({ action: 'allow' })
      },
    }

    const result = await runSubmission(
      { authorName: 'Maya', url: validRoot.url },
      { db, spamCheck: spy, request, now: t0 },
    )

    if (result.outcome !== 'invalid') throw new Error('expected invalid')
    expect(result.message).toMatch(/comment is required/i)
    expect(checked).toBe(false)
    expect(await countComments()).toBe(0)
  })

  it('rejects a hostile page URL as invalid rather than deriving a key from it', async () => {
    const result = await runSubmission(
      { authorName: 'Maya', body: 'hi', url: 'javascript:alert(1)' },
      deps(),
    )

    if (result.outcome !== 'invalid') throw new Error('expected invalid')
    expect(result.message.length).toBeGreaterThan(0)
    expect(await countThreads()).toBe(0)
  })

  it('rejects a submission with neither a URL nor a thread override', async () => {
    const result = await runSubmission({ authorName: 'Maya', body: 'hi' }, deps())

    expect(result.outcome).toBe('invalid')
  })
})

describe('runSubmission — replies', () => {
  async function postRoot() {
    const result = await runSubmission(validRoot, deps())
    if (result.outcome !== 'pending') throw new Error('root did not persist')
    const row = await db.prepare('select id from comments').first<{ id: number }>()
    // Approve it so it is a valid reply target the way a real one would be.
    await db.prepare("update comments set status = 'approved' where id = ?1").bind(row?.id).run()
    return row?.id as number
  }

  it('stores a reply at depth 1 under its parent, still pending', async () => {
    const rootId = await postRoot()

    const result = await runSubmission(
      {
        authorName: 'Maya',
        body: 'answering the export point',
        url: validRoot.url,
        parentId: rootId,
      },
      { db, spamCheck: allowAllSpamCheck, request, now: t0 + 10 },
    )

    expect(result.outcome).toBe('pending')
    const reply = await db
      .prepare('select depth, parent_id, status from comments where parent_id = ?1')
      .bind(rootId)
      .first<{ depth: number; parent_id: number; status: string }>()
    expect(reply?.depth).toBe(1)
    expect(reply?.status).toBe('pending')
  })

  it('echoes the reply back as HTML the reader can see', async () => {
    const rootId = await postRoot()

    const result = await runSubmission(
      { authorName: 'Maya', body: 'a visible reply echo', url: validRoot.url, parentId: rootId },
      { db, spamCheck: allowAllSpamCheck, request, now: t0 + 10 },
    )

    if (result.outcome !== 'pending') throw new Error('expected pending')
    expect(result.html).toContain('a visible reply echo')
  })
})
