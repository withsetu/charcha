import { beforeEach, describe, expect, it } from 'vitest'
import { getOrCreateThread, insertComment } from '../../../src/db'
import { computeBodyHash } from '../../../src/submit/hash'
import {
  DUPLICATE_MIN_LENGTH,
  DUPLICATE_WINDOW_SECONDS,
  LINKS_REJECT_AT,
  LINKS_REVIEW_AT,
  LINK_FLOOD_MAX_PROSE,
  contentLayer,
  countLinks,
  proseLength,
} from '../../../src/spam/content'
import { contextFor, db, t0, validBody } from './context'

const layer = contentLayer()

async function seedBody(body: string, pageKey = '/notes/leaving', at = t0 - 600) {
  const thread = await getOrCreateThread(db, { pageKey, now: t0 })
  await insertComment(db, {
    threadId: thread.id,
    authorName: 'Someone',
    body,
    bodyHash: await computeBodyHash(body),
    now: at,
  })
}

function links(count: number): string {
  return `Great post. ${Array.from({ length: count }, (_, i) => `https://buy-${i}.example/x`).join(' ')}`
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

describe('layer 6 — link counting', () => {
  it('allows a comment that cites a source or two, which is what real comments do', async () => {
    expect(await layer.run(contextFor({ body: links(LINKS_REVIEW_AT - 1) }))).toBeNull()
  })

  it('holds a link-heavy comment for review rather than rejecting it', async () => {
    // Link count is a heuristic, not proof. A researcher pasting five references
    // is indistinguishable here from a low-effort spammer, so the human gate
    // decides and nobody loses a comment.
    expect((await layer.run(contextFor({ body: links(LINKS_REVIEW_AT) })))?.action).toBe('review')
  })

  it('rejects an outright link flood — many links wrapped around almost no writing', async () => {
    expect((await layer.run(contextFor({ body: links(LINKS_REJECT_AT) })))?.action).toBe('reject')
  })

  it('holds, rather than rejects, a long argument that happens to cite ten sources', async () => {
    // "At ten the body is a link list" is a claim about the ratio, not the count.
    // A researcher's answer with ten citations has the same link count as a link
    // dump, and rejecting it loses the best comment of the week to a bare 403.
    const essay = `${'The export format is the part everyone underestimates, and here is why. '.repeat(20)} ${links(LINKS_REJECT_AT)}`
    expect(proseLength(essay)).toBeGreaterThan(LINK_FLOOD_MAX_PROSE)

    expect((await layer.run(contextFor({ body: essay })))?.action).toBe('review')
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

describe('layer 6 — known spam markup', () => {
  it('holds BBCode link markup for review — it is forum spam, but a person can write it', async () => {
    // Not a reject: src/render/markdown.ts renders fenced code blocks, so a
    // reader quoting the spam they received, or a comment on a thread about
    // migrating off phpBB, produces this markup honestly.
    const outcome = await layer.run(
      contextFor({ body: `Nice post [url=https://x.example]click[/url]` }),
    )

    expect(outcome?.action).toBe('review')
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

describe('layer 6 — duplicate bodies', () => {
  it('rejects a body already posted to this thread', async () => {
    await seedBody(validBody)

    expect((await layer.run(contextFor({ body: validBody })))?.action).toBe('reject')
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

  it('forgets a duplicate once it is outside the window', async () => {
    // Comments are soft-deleted, so an unbounded rule would let one moderator
    // takedown ban that text on that page forever, invisibly, for everyone
    // including the person who wrote it.
    await seedBody(validBody, '/notes/leaving', t0 - DUPLICATE_WINDOW_SECONDS - 1)

    expect(await layer.run(contextFor({ body: validBody }))).toBeNull()
  })
})

describe('layer 6 — the same body on other pages (#184)', () => {
  it('holds a body that has turned up on one other page', async () => {
    // One other page is a cross-post, not yet a blast: a person answering the same
    // question on two posts about the same thing writes this. The moderator sees
    // `duplicate-across-pages` and can tell the two apart; nothing here can.
    await seedBody(validBody, '/notes/somewhere-else')

    expect(await layer.run(contextFor({ body: validBody }))).toEqual({
      action: 'review',
      reason: 'duplicate-across-pages',
    })
  })

  it('refuses a body that has turned up on two other pages, which is a broadcast', async () => {
    // The signal the page-scoped rule was structurally unable to see at all — one
    // payload fired at every URL a crawler found, which under the old index was fifty
    // first-time comments.
    await seedBody(validBody, '/notes/somewhere-else')
    await seedBody(validBody, '/notes/a-third-page')

    expect(await layer.run(contextFor({ body: validBody }))).toEqual({
      action: 'reject',
      reason: 'duplicate-broadcast',
    })
  })

  it('counts pages and not copies, so two copies on one other page is still a cross-post', async () => {
    // `count(distinct page_key)`, asserted through the verdict. Counting rows would let
    // two copies on one page read as a two-page blast and refuse a comment the
    // threshold says to hold.
    await seedBody(validBody, '/notes/somewhere-else')
    await seedBody(validBody, '/notes/somewhere-else', t0 - 500)

    expect((await layer.run(contextFor({ body: validBody })))?.action).toBe('review')
  })

  it('still refuses on the same page first, so the reason names what actually happened', async () => {
    // Both rules match here. `duplicate-body` is the truer statement — the reader is
    // looking at a page that already carries this text — and it is the one the queue
    // and the log should say.
    await seedBody(validBody)
    await seedBody(validBody, '/notes/somewhere-else')

    expect(await layer.run(contextFor({ body: validBody }))).toEqual({
      action: 'reject',
      reason: 'duplicate-body',
    })
  })

  it('outranks every other review this layer can produce', async () => {
    // A body seen elsewhere is the only review here that has information the moderator
    // cannot get by looking at the comment, so it must not be shadowed by a link count.
    const withLinks = `${validBody} ${['a', 'b', 'c'].map((n) => `https://${n}.example/x`).join(' ')}`
    await seedBody(withLinks, '/notes/somewhere-else')

    expect(await layer.run(contextFor({ body: withLinks }))).toEqual({
      action: 'review',
      reason: 'duplicate-across-pages',
    })
  })

  it('forgets a cross-page duplicate once it is outside the window', async () => {
    // The same bound as the same-page rule, and it matters more here rather than less:
    // across pages the copy refused is the only copy that page would have had, so an
    // unbounded rule would let one takedown ban a piece of text site-wide forever.
    await seedBody(validBody, '/notes/somewhere-else', t0 - DUPLICATE_WINDOW_SECONDS - 1)

    expect(await layer.run(contextFor({ body: validBody }))).toBeNull()
  })

  it('ignores a cross-page duplicate too short to mean anything', async () => {
    // Short comments collide honestly across pages *more* readily than on one page: one
    // reader writing "Thanks, this helped." on two posts of a blog is one polite person.
    const short = 'Thanks, this helped.'
    expect(short.length).toBeLessThan(DUPLICATE_MIN_LENGTH)
    await seedBody(short, '/notes/somewhere-else')
    await seedBody(short, '/notes/a-third-page')

    expect(await layer.run(contextFor({ body: short }))).toBeNull()
  })
})

describe('layer 6 — a link in the author’s name (#184)', () => {
  it('holds a comment whose name field is a URL', async () => {
    expect(await layer.run(contextFor({ authorName: 'www.cheap-pills.example' }))).toEqual({
      action: 'review',
      reason: 'link-in-name',
    })
  })

  it('holds one whose name merely contains a URL, which is the keyword-stuffed shape', async () => {
    expect(await layer.run(contextFor({ authorName: 'Jane — https://janeblog.example' }))).toEqual({
      action: 'review',
      reason: 'link-in-name',
    })
  })

  it('leaves an ordinary name alone, including one with a dot in it', async () => {
    // The same rule the body counter uses: a bare dotted word is prose, not a link, or
    // half the names on a programming blog would be held.
    expect(await layer.run(contextFor({ authorName: 'A. R. Rahman' }))).toBeNull()
    expect(await layer.run(contextFor({ authorName: 'node.js fan' }))).toBeNull()
  })

  it('does not soften a refusal the body had already earned', async () => {
    await seedBody(validBody)

    expect(
      (await layer.run(contextFor({ body: validBody, authorName: 'www.x.example' })))?.action,
    ).toBe('reject')
  })
})

describe('layer 6 — the query budget', () => {
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
