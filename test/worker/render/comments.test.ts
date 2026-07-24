import { describe, expect, it } from 'vitest'
import type { RenderableComment } from '../../../src/db'
import { COMMENT_CLASS_NAMES, renderComments } from '../../../src/render'
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
        '<time class="charcha-comment-time" datetime="2025-07-23T19:46:40.000Z">2025-07-23</time>' +
        '</div>' +
        '<div class="charcha-comment-body"><p>Nice post.</p></div>' +
        '</li>' +
        '</ol>',
    )
  })

  it('renders a page with no comments as an empty container, not as copy', () => {
    // Wording an empty state is a design decision that belongs to the embed and
    // the theming contract (#5, #6). A renderer that invents English here would
    // make that decision for every site, in one language.
    expect(renderComments([])).toBe('<ol class="charcha-comments"></ol>')
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

  it('emits the timestamp as machine-readable UTC, read from the row and not from a clock', () => {
    const html = renderComments([comment({ id: 1, createdAt: 1_753_300_000 })])

    expect(html).toContain('datetime="2025-07-23T19:46:40.000Z"')
    expect(html).toContain('>2025-07-23</time>')
  })

  it('omits the timestamp rather than throwing when the row carries nonsense', () => {
    const html = renderComments([
      comment({ id: 1, createdAt: Number.NaN }),
      comment({ id: 2, createdAt: 8.64e15 }),
    ])

    expect(html).not.toContain('<time')
    expect(html).toContain('charcha-comment-body')
  })
})

describe('the class names it emits, which are a public API', () => {
  // Bare mode ships in v1 (#6), so a site's own stylesheet targets these names
  // directly. Renaming one is a breaking change for every deployment, and this
  // test is what makes that a failing build rather than a silent one.
  it('is exactly the documented set, and nothing else', () => {
    const html = renderComments([
      comment({ id: 1, byOwner: true, body: '**b** `c`\n\n- d\n\n> e\n\n```\nf\n```' }),
      comment({ id: 2, parentId: 1, depth: 1, body: '[g](https://ok.example/)' }),
    ])

    expect(classNamesIn(html)).toEqual(new Set(COMMENT_CLASS_NAMES))
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
