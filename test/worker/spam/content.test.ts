import { beforeEach, describe, expect, it } from 'vitest'
import { getOrCreateThread, insertComment } from '../../../src/db'
import { computeBodyHash } from '../../../src/submit/hash'
import {
  DUPLICATE_MIN_LENGTH,
  LINKS_REJECT_AT,
  LINKS_REVIEW_AT,
  contentLayer,
  countLinks,
} from '../../../src/spam/content'
import { contextFor, db, t0, validBody } from './context'

const layer = contentLayer()

async function seedBody(body: string, pageKey = '/notes/leaving') {
  const thread = await getOrCreateThread(db, { pageKey, now: t0 })
  await insertComment(db, {
    threadId: thread.id,
    authorName: 'Someone',
    body,
    bodyHash: await computeBodyHash(body),
    now: t0 - 600,
  })
}

function links(count: number): string {
  return `Great post. ${Array.from({ length: count }, (_, i) => `https://buy-${i}.example/x`).join(' ')}`
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

describe('layer 5 — link counting', () => {
  it('allows a comment that cites a source or two, which is what real comments do', async () => {
    expect(await layer.run(contextFor({ body: links(LINKS_REVIEW_AT - 1) }))).toBeNull()
  })

  it('holds a link-heavy comment for review rather than rejecting it', async () => {
    // Link count is a heuristic, not proof. A researcher pasting five references
    // is indistinguishable here from a low-effort spammer, so the human gate
    // decides and nobody loses a comment.
    expect((await layer.run(contextFor({ body: links(LINKS_REVIEW_AT) })))?.action).toBe('review')
  })

  it('rejects an outright link flood', async () => {
    expect((await layer.run(contextFor({ body: links(LINKS_REJECT_AT) })))?.action).toBe('reject')
  })

  it('counts a www-prefixed address as well as one carrying a scheme', () => {
    expect(countLinks('see www.example.com and https://other.example/x')).toBe(2)
  })

  it('counts a repeated link once per occurrence, because repetition is the spam shape', () => {
    expect(countLinks('https://a.example https://a.example https://a.example')).toBe(3)
  })

  it('does not read a bare dotted word as a link, so a developer blog stays usable', () => {
    // src/render/markdown.ts only makes an anchor out of [text](https://url) — it
    // never autolinks. So a bare `node.js` or `index.ts` is not a link, and a
    // counter that thought otherwise would hold half of a programming blog for
    // review.
    expect(countLinks('node.js and index.ts, see README.md. I disagree. Strongly.')).toBe(0)
  })
})

describe('layer 5 — known spam markup', () => {
  it('rejects BBCode link markup, which is never Markdown and never a real comment', async () => {
    const outcome = await layer.run(
      contextFor({ body: `Nice post [url=https://x.example]click[/url]` }),
    )

    expect(outcome?.action).toBe('reject')
  })

  it('leaves an ordinary Markdown link alone', async () => {
    const outcome = await layer.run(
      contextFor({
        body: 'The [export format](https://maya.build/spec) is the part that matters here.',
      }),
    )

    expect(outcome).toBeNull()
  })
})

describe('layer 5 — duplicate bodies', () => {
  it('rejects a body already posted to this thread', async () => {
    await seedBody(validBody)

    expect((await layer.run(contextFor({ body: validBody })))?.action).toBe('reject')
  })

  it('allows the same body on a different page, because the index is per thread', async () => {
    await seedBody(validBody, '/notes/somewhere-else')

    expect(await layer.run(contextFor({ body: validBody }))).toBeNull()
  })

  it('ignores duplicates too short to be anything but a coincidence', async () => {
    // Two readers both writing "Thanks, this helped." on the same post is a
    // coincidence, not a spammer. Rejecting there loses a real comment for free.
    const short = 'Thanks, this helped.'
    expect(short.length).toBeLessThan(DUPLICATE_MIN_LENGTH)
    await seedBody(short)

    expect(await layer.run(contextFor({ body: short }))).toBeNull()
  })

  it('does not treat a merely similar body as a duplicate', async () => {
    await seedBody(validBody)

    expect(await layer.run(contextFor({ body: `${validBody} Also this.` }))).toBeNull()
  })
})

describe('layer 5 — the query budget', () => {
  it('spends no read at all when the body is too short for the duplicate rule', async () => {
    const statements: string[] = []
    const counting = {
      ...db,
      prepare(sql: string) {
        statements.push(sql)
        return db.prepare(sql)
      },
    } as unknown as D1Database

    await layer.run({ ...contextFor({ body: 'Short.' }), db: counting })

    expect(statements).toHaveLength(0)
  })

  it('spends exactly one read otherwise, however many comments the thread has', async () => {
    for (let i = 0; i < 20; i++) await seedBody(`a stored comment number ${i} ${validBody}`)
    const statements: string[] = []
    const counting = {
      ...db,
      prepare(sql: string) {
        statements.push(sql)
        return db.prepare(sql)
      },
    } as unknown as D1Database

    await layer.run({ ...contextFor(), db: counting })

    expect(statements).toHaveLength(1)
  })
})
