import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../../src/render'
import { attributeNames, parseElements, tagNames } from './parse'

/**
 * The Markdown subset, and the attacks against it.
 *
 * Every body rendered here is attacker-controlled: the write endpoint is public
 * and unauthenticated, and the output is inserted into someone else's page. So
 * the interesting assertions are the negative ones — which elements and
 * attributes are *absent* — and they are made against a real HTML parser rather
 * than against the output string, because the browser will not read the string.
 */

async function hrefs(html: string): Promise<string[]> {
  const elements = await parseElements(html)
  return elements
    .filter((element) => element.tag === 'a')
    .map((element) => element.attributes.href ?? '')
}

async function eventHandlerAttributes(html: string): Promise<string[]> {
  return [...(await attributeNames(html))].filter((name) => name.startsWith('on'))
}

/** How deeply emphasis elements are nested in the output, at the deepest point. */
function maxEmphasisNesting(html: string): number {
  let depth = 0
  let deepest = 0
  for (const tag of html.match(/<\/?(?:strong|em)>/g) ?? []) {
    depth += tag.startsWith('</') ? -1 : 1
    deepest = Math.max(deepest, depth)
  }
  return deepest
}

describe('the Markdown subset it renders', () => {
  it('wraps a line of prose in a paragraph', () => {
    expect(renderMarkdown('Hello there.')).toBe('<p>Hello there.</p>')
  })

  it('starts a new paragraph at a blank line', () => {
    expect(renderMarkdown('One.\n\nTwo.')).toBe('<p>One.</p><p>Two.</p>')
  })

  it('keeps a single newline as a line break, because comments are written that way', () => {
    expect(renderMarkdown('One.\nTwo.')).toBe('<p>One.<br>Two.</p>')
  })

  it('reads a Windows line ending as one break, not two', () => {
    expect(renderMarkdown('One.\r\nTwo.')).toBe('<p>One.<br>Two.</p>')
  })

  it('renders bold and italic', () => {
    expect(renderMarkdown('**bold** and *italic*')).toBe(
      '<p><strong>bold</strong> and <em>italic</em></p>',
    )
  })

  it('leaves underscores alone, so snake_case names survive being commented about', () => {
    expect(renderMarkdown('call some_variable_name here')).toBe(
      '<p>call some_variable_name here</p>',
    )
  })

  it('renders inline code', () => {
    expect(renderMarkdown('run `npm run check` first')).toBe(
      '<p>run <code>npm run check</code> first</p>',
    )
  })

  it('does not apply the other rules inside a code span', () => {
    expect(renderMarkdown('`**not bold** [not a link](https://x.example)`')).toBe(
      '<p><code>**not bold** [not a link](https://x.example)</code></p>',
    )
  })

  it('renders a fenced code block, dropping the language tag rather than emitting it', () => {
    // The info string is attacker-controlled text that would land on an element
    // we own. It is dropped rather than turned into a class, because `class` is
    // the one attribute the host page's stylesheet already trusts.
    expect(renderMarkdown('```js\nconst x = 1\n```')).toBe('<pre><code>const x = 1</code></pre>')
  })

  it('renders a blockquote', () => {
    expect(renderMarkdown('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>')
  })

  it('renders an unordered list from either marker', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>')
    expect(renderMarkdown('* one\n* two')).toBe('<ul><li>one</li><li>two</li></ul>')
  })

  it('renders a link to an https URL', () => {
    expect(renderMarkdown('[docs](https://charcha.dev/docs)')).toBe(
      '<p><a href="https://charcha.dev/docs" rel="nofollow ugc noopener noreferrer"' +
        ' target="_blank">docs</a></p>',
    )
  })

  it('produces the same output every time, so it can be snapshot-tested and cached', () => {
    const source = '# not a heading\n\n**a** [b](https://c.example) `d`\n\n- e\n\n> f'
    expect(renderMarkdown(source)).toBe(renderMarkdown(source))
  })

  it('renders nothing at all for a body that is only whitespace', () => {
    expect(renderMarkdown('   \n\n  ')).toBe('')
  })
})

describe('Markdown this subset deliberately does not support', () => {
  it('leaves a heading as text rather than emitting a heading element', async () => {
    const html = renderMarkdown('# Heading')

    expect(await tagNames(html)).toEqual(new Set(['p']))
    expect(html).toContain('# Heading')
  })

  it('leaves an image as text, so no URL in a comment is ever fetched by the reader', async () => {
    const html = renderMarkdown('![alt](https://evil.example/track.gif)')

    expect((await tagNames(html)).has('img')).toBe(false)
    expect((await attributeNames(html)).has('src')).toBe(false)
  })

  it('does not autolink a bare URL, so only the explicit link syntax makes a link', async () => {
    const html = renderMarkdown('see https://charcha.dev for more')

    expect(await hrefs(html)).toEqual([])
  })

  it('leaves a table as text rather than building one', async () => {
    const html = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |')

    expect((await tagNames(html)).has('table')).toBe(false)
  })
})

describe('HTML in a comment body', () => {
  it('renders a script tag as text, and no script element reaches the page', async () => {
    const html = renderMarkdown('<script>alert(document.cookie)</script>')

    expect(await tagNames(html)).toEqual(new Set(['p']))
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders an img with an onerror handler as text', async () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>')

    expect((await tagNames(html)).has('img')).toBe(false)
    expect(await eventHandlerAttributes(html)).toEqual([])
  })

  it('renders an svg onload payload as text', async () => {
    const html = renderMarkdown('<svg/onload=alert(1)>')

    expect(await tagNames(html)).toEqual(new Set(['p']))
  })

  it('cannot be smuggled in as HTML entities, because the ampersand is escaped too', async () => {
    const html = renderMarkdown('&lt;img src=x onerror=alert(1)&gt;')

    expect(await tagNames(html)).toEqual(new Set(['p']))
    expect(html).toContain('&amp;lt;img')
  })

  it('cannot be smuggled in as a numeric character reference', async () => {
    const html = renderMarkdown('&#60;script&#62;alert(1)&#60;/script&#62;')

    expect(await tagNames(html)).toEqual(new Set(['p']))
    expect(html).toContain('&amp;#60;')
  })

  it('survives an unclosed tag without leaking one into the output', async () => {
    const html = renderMarkdown('<div class="unclosed')

    expect(await tagNames(html)).toEqual(new Set(['p']))
    expect(await attributeNames(html)).toEqual(new Set())
  })

  it('does not let a tag hide inside markup this subset does emit', async () => {
    const html = renderMarkdown('**bold `<script>alert(1)</script>` bold**')

    expect(await tagNames(html)).toEqual(new Set(['p', 'strong', 'code']))
  })

  it('does not let a tag hide inside a fenced code block', async () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```')

    expect(await tagNames(html)).toEqual(new Set(['pre', 'code']))
  })

  it('does not let a tag hide inside a list item or a blockquote', async () => {
    expect(await tagNames(renderMarkdown('- <script>alert(1)</script>'))).toEqual(
      new Set(['ul', 'li']),
    )
    expect(await tagNames(renderMarkdown('> <script>alert(1)</script>'))).toEqual(
      new Set(['blockquote', 'p']),
    )
  })

  it('never emits an event-handler attribute, whatever the body contains', async () => {
    const bodies = [
      '<a href="#" onclick="alert(1)">x</a>',
      '<body onload=alert(1)>',
      '"><img src=x onerror=alert(1)>',
      "'><img src=x onerror=alert(1)>",
      '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      '<template><script>alert(1)</script></template>',
    ]

    for (const body of bodies) {
      expect(await eventHandlerAttributes(renderMarkdown(body))).toEqual([])
      expect((await tagNames(renderMarkdown(body))).has('script')).toBe(false)
    }
  })
})

describe('link URLs', () => {
  const dangerous = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'jav ascript:alert(1)',
    'java script:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'about:blank',
    'blob:https://charcha.dev/uuid',
    '//evil.example/protocol-relative',
    '/relative/path',
    'https:/evil.example',
    'ｈｔｔｐｓ://evil.example',
    'https\u200b://evil.example',
    'ʜᴛᴛᴘs://evil.example',
    'https://\u202eevil.example',
  ]

  for (const url of dangerous) {
    it(`refuses to make a link out of ${JSON.stringify(url)}`, async () => {
      const html = renderMarkdown(`[click me](${url})`)

      // Fail closed: the link syntax is left as literal text rather than
      // rendered as an anchor with a scrubbed href, so there is no partially
      // trusted URL anywhere in the output.
      expect(await hrefs(html)).toEqual([])
      expect((await tagNames(html)).has('a')).toBe(false)
    })
  }

  it('never emits an href that is not http or https, across the whole battery', async () => {
    const html = renderMarkdown(dangerous.map((url) => `[x](${url})`).join('\n\n'))

    for (const element of await parseElements(html)) {
      expect(element.attributes.href).toBeUndefined()
    }
  })

  it('refuses a URL carrying a quote, so no href can close its own attribute', async () => {
    const html = renderMarkdown('[x](https://ok.example" onmouseover="alert(1))')

    expect(await hrefs(html)).toEqual([])
    expect(await eventHandlerAttributes(html)).toEqual([])
  })

  it('refuses a URL longer than any real one, rather than emitting it', async () => {
    const html = renderMarkdown(`[x](https://ok.example/${'a'.repeat(4000)})`)

    expect(await hrefs(html)).toEqual([])
  })

  it('marks the links it does emit as untrusted user content', async () => {
    const html = renderMarkdown('[x](https://ok.example/)')
    const [anchor] = (await parseElements(html)).filter((element) => element.tag === 'a')

    // nofollow+ugc is what stops a comment box from being an SEO donation, and
    // noopener+noreferrer is what stops the opened page from reaching back
    // through window.opener into the host site.
    expect(anchor?.attributes.rel).toBe('nofollow ugc noopener noreferrer')
    expect(anchor?.attributes.target).toBe('_blank')
  })

  it('keeps a query string intact, ampersands and all', async () => {
    const html = renderMarkdown('[x](https://ok.example/?a=1&b=2)')

    // The parser reports an attribute as it is written, not as it decodes:
    // `&amp;` is how one `&` is spelled inside an attribute value, and the
    // browser reads it back as `?a=1&b=2`.
    expect(await hrefs(html)).toEqual(['https://ok.example/?a=1&amp;b=2'])
  })

  it('does not treat a lookalike domain as an injection, because it is not one', async () => {
    // An IDN homoglyph is a real https URL that a human should distrust. Judging
    // that is the moderation queue's job (#8, #13), not the renderer's:
    // rejecting every non-ASCII host would break legitimate IDN links instead.
    const html = renderMarkdown('[apple](https://аpple.example/)')

    expect(await hrefs(html)).toEqual(['https://аpple.example/'])
  })

  it('leaves the link text as text, so markup cannot ride in through the label', async () => {
    const html = renderMarkdown('[<script>alert(1)</script>](https://ok.example/)')

    expect(await tagNames(html)).toEqual(new Set(['p', 'a']))
  })
})

describe('adversarially shaped input', () => {
  it('never nests emphasis more than two deep, whatever the delimiters do', () => {
    const bodies = [
      '**a *b* c**',
      '*a **b** c*',
      '***a***',
      '*'.repeat(64) + 'x' + '*'.repeat(64),
      '**'.repeat(64) + 'x' + '**'.repeat(64),
      '*a**b*c**d*e**f*',
    ]

    // Emphasis closes at the *nearest* matching delimiter, so its content can
    // never contain the delimiter that opened it. That is what stops a body of
    // markers from being recursion whose depth the attacker chooses.
    for (const body of bodies) {
      expect(maxEmphasisNesting(renderMarkdown(body))).toBeLessThanOrEqual(2)
    }
  })

  it('renders a body of nothing but delimiters without hanging', () => {
    const html = renderMarkdown('*'.repeat(2500) + '`'.repeat(2500) + '['.repeat(2500))

    expect(typeof html).toBe('string')
  })

  it('renders half-written link syntax without hanging', () => {
    const html = renderMarkdown('[]('.repeat(3000) + ')')

    expect(typeof html).toBe('string')
  })

  it('leaves an unclosed code span, link or emphasis as literal text', () => {
    expect(renderMarkdown('an `unclosed span')).toBe('<p>an `unclosed span</p>')
    expect(renderMarkdown('an *unclosed emphasis')).toBe('<p>an *unclosed emphasis</p>')
    expect(renderMarkdown('an [unclosed](link')).toBe('<p>an [unclosed](link</p>')
  })

  it('leaves an unterminated code fence as a code block rather than losing the text', () => {
    expect(renderMarkdown('```\nnever closed')).toBe('<pre><code>never closed</code></pre>')
  })

  it('renders the longest body the schema allows', () => {
    // migrations/0001_initial.sql caps a body at 10,000 characters.
    const html = renderMarkdown('word '.repeat(2000))

    expect(html.startsWith('<p>word')).toBe(true)
  })
})
