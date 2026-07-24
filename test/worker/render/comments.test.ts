import { describe, expect, it } from 'vitest'
import type { RenderableComment } from '../../../src/db'
import type { CommentStrings } from '../../../src/render'
import { COMMENT_CLASS_NAMES, ENGLISH_STRINGS, renderComments } from '../../../src/render'
import { attributeNames, parseElements, tagNames } from './parse'

const t0 = 1_753_300_000

function comment(overrides: Partial<RenderableComment> & { id: number }): RenderableComment {
  return {
    parentId: null,
    depth: 0,
    authorName: 'Rahul Kanwar',
    body: 'A comment.',
    byOwner: false,
    createdAt: t0,
    ...overrides,
  }
}

/**
 * A complete strings table with one slot replaced. Every key is required, so a
 * table missing one is a type error rather than the word `undefined` on a page —
 * which means a test overriding a single string has to supply the rest.
 */
function strings(overrides: Partial<CommentStrings>): CommentStrings {
  return { ...ENGLISH_STRINGS, ...overrides }
}

function classNamesIn(html: string): Set<string> {
  const found = new Set<string>()
  for (const match of html.matchAll(/class="([^"]*)"/g)) {
    for (const name of (match[1] ?? '').split(' ')) if (name !== '') found.add(name)
  }
  return found
}

describe('renderComments', () => {
  it('renders the author and the body of a comment', () => {
    const html = renderComments([comment({ id: 1, authorName: 'Maya', body: 'Nice post.' })])

    expect(html).toContain('>Maya<')
    expect(html).toContain('<p>Nice post.</p>')
  })

  it('produces exactly this markup, so a change to the shape has to be deliberate', () => {
    // Written out rather than snapshotted: the embed inserts this string with
    // innerHTML and a site's stylesheet targets it, so the shape is as much a
    // contract as the class names are.
    expect(renderComments([comment({ id: 1, authorName: 'Maya', body: 'Nice post.' })])).toBe(
      '<ol class="charcha-comments">' +
        '<li class="charcha-comment" id="charcha-comment-1">' +
        '<div class="charcha-comment-header">' +
        '<span class="charcha-comment-author">Maya</span>' +
        '<time class="charcha-comment-time" datetime="2025-07-23T19:46:40.000Z">' +
        '2025-07-23 19:46 UTC</time>' +
        '</div>' +
        '<div class="charcha-comment-body"><p>Nice post.</p></div>' +
        '</li>' +
        '</ol>',
    )
  })

  it('keeps the order the data layer returned, which is oldest first', () => {
    const html = renderComments([
      comment({ id: 1, authorName: 'First', createdAt: t0 }),
      comment({ id: 2, authorName: 'Second', createdAt: t0 + 10 }),
    ])

    expect(html.indexOf('First')).toBeLessThan(html.indexOf('Second'))
  })

  it('nests a reply inside the comment it answers', () => {
    const html = renderComments([
      comment({ id: 1, authorName: 'Root' }),
      comment({ id: 2, parentId: 1, depth: 1, authorName: 'Replier', createdAt: t0 + 10 }),
    ])

    expect(html).toContain('<ol class="charcha-replies">')
    expect(html.indexOf('charcha-replies')).toBeGreaterThan(html.indexOf('Root'))
    expect(html.indexOf('Replier')).toBeGreaterThan(html.indexOf('charcha-replies'))
  })

  it('gives a root comment with no replies no reply list at all', () => {
    const html = renderComments([comment({ id: 1 })])

    expect(html).not.toContain('charcha-replies')
  })

  it('keeps replies in the order they arrived', () => {
    const html = renderComments([
      comment({ id: 1 }),
      comment({ id: 2, parentId: 1, depth: 1, authorName: 'Earlier', createdAt: t0 + 10 }),
      comment({ id: 3, parentId: 1, depth: 1, authorName: 'Later', createdAt: t0 + 20 }),
    ])

    expect(html.indexOf('Earlier')).toBeLessThan(html.indexOf('Later'))
  })

  it('drops a reply whose parent is not on the page, rather than promoting it', () => {
    // The page read already hides a reply whose parent is not approved, so a
    // reply arriving here without its parent means something upstream is wrong.
    // Promoting it to the top level would publish an answer to a comment the
    // moderator took down, next to the comment it was never replying to.
    const html = renderComments([
      comment({ id: 1, authorName: 'Root' }),
      comment({ id: 9, parentId: 404, depth: 1, authorName: 'Orphan' }),
    ])

    expect(html).not.toContain('Orphan')
    expect(html).toContain('Root')
  })

  it('reads a comment with no parent field at all as a root, rather than dropping it', () => {
    const withoutParent = { ...comment({ id: 1, authorName: 'Rootish' }) }
    delete (withoutParent as Partial<RenderableComment>).parentId

    expect(renderComments([withoutParent])).toContain('Rootish')
  })

  it('drops a reply to a reply, so threading cannot exceed the two levels it renders', () => {
    const html = renderComments([
      comment({ id: 1, authorName: 'Root' }),
      comment({ id: 2, parentId: 1, depth: 1, authorName: 'Reply' }),
      comment({ id: 3, parentId: 2, depth: 1, authorName: 'ReplyToReply' }),
    ])

    expect(html).not.toContain('ReplyToReply')
  })

  it('marks a comment written by the site owner with a modifier class', () => {
    const html = renderComments([comment({ id: 1, byOwner: true })])

    expect(html).toContain('class="charcha-comment charcha-comment-by-owner"')
  })

  it('gives every comment a stable anchor, so a reply can be linked to', () => {
    const html = renderComments([comment({ id: 7 }), comment({ id: 8, parentId: 7, depth: 1 })])

    expect(html).toContain('id="charcha-comment-7"')
    expect(html).toContain('id="charcha-comment-8"')
  })

  it('shows the date and the time, read from the row and not from a clock', () => {
    const html = renderComments([comment({ id: 1, createdAt: 1_753_300_000 })])

    expect(html).toContain('datetime="2025-07-23T19:46:40.000Z"')
    expect(html).toContain('>2025-07-23 19:46 UTC</time>')
  })

  it('names the timezone in the text, because a bare time reads as the reader’s own', () => {
    // This function has no clock and no locale, so the time it shows is UTC and
    // cannot be anything else. An unlabelled "19:46" that is nine hours off the
    // reader's wall clock is worse than no time at all, because it looks right.
    // The label is in the text rather than in a title attribute for the same
    // reason: a tooltip is not read by someone who is not suspicious yet.
    const html = renderComments([comment({ id: 1 })])

    expect(html).toContain('UTC</time>')
    expect(html).not.toContain('title=')
  })

  it('keeps the attribute at full precision, whatever the text says', async () => {
    // The attribute is the hook a later client-side upgrade is intended to read
    // — the reader's own timezone, or relative time — so it stays exact even
    // though the visible text is rounded to the minute.
    const html = renderComments([comment({ id: 1, createdAt: 1_753_300_007 })])
    const [time] = (await parseElements(html)).filter((element) => element.tag === 'time')

    expect(time?.attributes.datetime).toBe('2025-07-23T19:46:47.000Z')
    expect(Object.keys(time?.attributes ?? {}).sort()).toEqual(['class', 'datetime'])
  })

  it('omits the timestamp rather than throwing when the row carries nonsense', () => {
    const html = renderComments([
      comment({ id: 1, createdAt: Number.NaN }),
      comment({ id: 2, createdAt: 8.64e15 }),
    ])

    expect(html).not.toContain('<time')
    expect(html).toContain('charcha-comment-body')
  })

  it('omits the timestamp for a year outside four digits, rather than printing rubble', () => {
    // Past year 9999 toISOString switches to the expanded form
    // (+275760-09-13T00:00:00.000Z), and reading a date and a time out of it by
    // position yields "+275760-09 3T00: UTC" — a string that is not a date and
    // does not look like a bug until somebody reads it.
    const html = renderComments([
      comment({ id: 1, createdAt: 8.64e12 }),
      comment({ id: 2, createdAt: 253_402_300_800 }),
      comment({ id: 3, createdAt: -62_167_219_201 }),
    ])

    expect(html).not.toContain('<time')
  })

  it('still renders the years that are real', () => {
    const html = renderComments([
      comment({ id: 1, createdAt: 0 }),
      comment({ id: 2, createdAt: 253_402_300_799 }),
    ])

    expect(html).toContain('>1970-01-01 00:00 UTC</time>')
    expect(html).toContain('>9999-12-31 23:59 UTC</time>')
  })
})

describe('a page nobody has commented on', () => {
  it('invites the first comment', () => {
    expect(renderComments([])).toBe('<p class="charcha-empty">Be the first to comment</p>')
  })

  it('says so in words rather than rendering an empty list', async () => {
    // An empty <ol> is markup describing a list that is not there, and a reader
    // sees nothing at all. The invitation is the point of the state.
    expect(await tagNames(renderComments([]))).toEqual(new Set(['p']))
  })

  it('says it once, not per orphaned reply', () => {
    // Replies whose parent is not on the page are dropped, which can empty the
    // page even though rows arrived. That is still an empty page.
    expect(renderComments([comment({ id: 9, parentId: 404, depth: 1 })])).toBe(renderComments([]))
  })
})

describe('the words it shows a reader', () => {
  it('takes them from a table, so a second language is a table and not a rewrite', () => {
    const html = renderComments([], strings({ emptyState: 'Soyez le premier à commenter' }))

    expect(html).toBe('<p class="charcha-empty">Soyez le premier à commenter</p>')
  })

  it('defaults to English rather than to nothing', () => {
    expect(renderComments([])).toBe(renderComments([], ENGLISH_STRINGS))
  })

  it('escapes them, because a translation is untrusted input the day one is contributed', async () => {
    const html = renderComments([], strings({ emptyState: '<script>alert(1)</script>' }))

    expect((await tagNames(html)).has('script')).toBe(false)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes a translation that tries to reopen the attribute it sits beside', async () => {
    const html = renderComments([], strings({ emptyState: '"><img src=x onerror=alert(1)>' }))

    expect((await tagNames(html)).has('img')).toBe(false)
    expect([...(await attributeNames(html))].filter((name) => name.startsWith('on'))).toEqual([])
  })

  it('stays pure: the table is a parameter, never a global', () => {
    const french = strings({ emptyState: 'Aucun commentaire' })

    expect(renderComments([], french)).toContain('Aucun commentaire')
    expect(renderComments([])).toContain('Be the first to comment')
  })
})

describe('a conversation the page read had to cut short', () => {
  // #27 caps the page read, and a cap the reader cannot see is a page that lies
  // about the conversation. The renderer is told, rather than guessing from the
  // row count, because only the caller knows whether there was another row.
  it('says how much it is showing, below the comments it showed', () => {
    const html = renderComments([comment({ id: 1 })], undefined, { truncated: true })

    expect(html).toContain('charcha-truncated')
    expect(html.indexOf('charcha-truncated')).toBeGreaterThan(html.indexOf('charcha-comments'))
  })

  it('names the number it showed, so the notice is checkable rather than vague', () => {
    const html = renderComments([comment({ id: 1 }), comment({ id: 2 })], undefined, {
      truncated: true,
    })

    expect(html).toContain('2')
  })

  it('says nothing at all when the whole conversation fits', () => {
    expect(renderComments([comment({ id: 1 })], undefined, { truncated: false })).toBe(
      renderComments([comment({ id: 1 })]),
    )
  })

  it('takes its words from the strings table like every other sentence', () => {
    const french: CommentStrings = {
      emptyState: 'Aucun commentaire',
      truncatedNotice: (shown) => `Affichage des ${shown} premiers commentaires.`,
    }

    const html = renderComments([comment({ id: 1 })], french, { truncated: true })

    expect(html).toContain('Affichage des 1 premiers commentaires.')
  })

  it('escapes that translation, because a contributed table is untrusted input', async () => {
    const html = renderComments(
      [comment({ id: 1 })],
      { emptyState: 'x', truncatedNotice: () => '<script>alert(1)</script>' },
      { truncated: true },
    )

    expect((await tagNames(html)).has('script')).toBe(false)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})

describe('the class names it emits, which are a public API', () => {
  // Bare mode ships in v1 (#6), so a site's own stylesheet targets these names
  // directly. Renaming one is a breaking change for every deployment, and this
  // test is what makes that a failing build rather than a silent one.
  it('is exactly the documented set, and nothing else', () => {
    // Every state, because each emits a class the others never do — and a name
    // that only one render can produce is still a name a stylesheet depends on.
    const populated = renderComments([
      comment({ id: 1, byOwner: true, body: '**b** `c`\n\n- d\n\n> e\n\n```\nf\n```' }),
      comment({ id: 2, parentId: 1, depth: 1, body: '[g](https://ok.example/)' }),
    ])
    const empty = renderComments([])
    const truncated = renderComments([comment({ id: 1 })], undefined, { truncated: true })

    expect(
      new Set([...classNamesIn(populated), ...classNamesIn(empty), ...classNamesIn(truncated)]),
    ).toEqual(new Set(COMMENT_CLASS_NAMES))
  })

  it('prefixes every one of them, so nothing collides with the host page', () => {
    for (const name of COMMENT_CLASS_NAMES) {
      expect(name.startsWith('charcha-')).toBe(true)
    }
  })
})

describe('an author name is untrusted input too', () => {
  it('renders a name containing a tag as text', async () => {
    const html = renderComments([comment({ id: 1, authorName: '<img src=x onerror=alert(1)>' })])

    expect((await tagNames(html)).has('img')).toBe(false)
    expect([...(await attributeNames(html))].filter((n) => n.startsWith('on'))).toEqual([])
  })

  it('escapes both quote characters in a name, so no attribute can be reopened', () => {
    const html = renderComments([comment({ id: 1, authorName: `Maya" onmouseover='x'` })])

    expect(html).toContain('Maya&quot; onmouseover=&#39;x&#39;')
    expect(html).not.toContain(`onmouseover='x'`)
  })

  it('escapes an id that is not the integer the type promises', async () => {
    // The renderer is also called from the v1.1 build-time API, where the rows
    // arrive from a site generator rather than from this project's data layer.
    const hostile = comment({ id: '1" onload="alert(1)' as unknown as number })

    const html = renderComments([hostile])

    expect([...(await attributeNames(html))].filter((n) => n.startsWith('on'))).toEqual([])
    expect(html).toContain('id="charcha-comment-1&quot; onload=&quot;alert(1)"')
  })
})

describe('the whole document it produces', () => {
  const conversation = [
    comment({
      id: 1,
      authorName: '<b>Maya</b>',
      body: '<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n[y](https://ok.example/)',
    }),
    comment({ id: 2, parentId: 1, depth: 1, byOwner: true, body: '> quoted\n\n- item' }),
  ]

  it('contains no element that could run code or load a resource', async () => {
    const tags = await tagNames(renderComments(conversation))

    for (const forbidden of ['script', 'style', 'iframe', 'img', 'link', 'meta', 'object']) {
      expect(tags.has(forbidden)).toBe(false)
    }
  })

  it('contains no attribute outside the small set it means to emit', async () => {
    // Card rule 8: no reader-side cookies, ever. A renderer that emitted no
    // script and no meta cannot set one, and this is the assertion that keeps
    // both out as the markup grows.
    const allowed = new Set(['class', 'id', 'datetime', 'href', 'rel', 'target'])

    for (const name of await attributeNames(renderComments(conversation))) {
      expect(allowed.has(name)).toBe(true)
    }
  })

  it('emits only http and https hrefs', async () => {
    for (const element of await parseElements(renderComments(conversation))) {
      const href = element.attributes.href
      if (href !== undefined) expect(href.startsWith('https://')).toBe(true)
    }
  })

  it('is pure: same input, same output, and the input is left alone', () => {
    const input = [comment({ id: 1 }), comment({ id: 2, parentId: 1, depth: 1 })]
    const snapshot = structuredClone(input)

    const first = renderComments(input)
    const second = renderComments(input)

    expect(second).toBe(first)
    expect(input).toEqual(snapshot)
  })
})
