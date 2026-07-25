import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../../src/index'
import { ALLOWED_ORIGINS_SETTING } from '../../../src/cors'
import { MAX_BODY_BYTES } from '../../../src/request-body'
import { MAX_BODY_LENGTH } from '../../../src/submit/schema'
import { MARKDOWN_ELEMENTS, renderComments, renderMarkdown } from '../../../src/render'
import { PREVIEW_PATH } from '../../../src/preview/route'

const db = env.DB
const worker = 'https://charcha.example'
const site = 'https://maya.build'
const t0 = 1_753_300_000

function preview(body: BodyInit, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${worker}${PREVIEW_PATH}`, { method: 'POST', headers, body })
}

async function allowOrigin(origin: string) {
  await db
    .prepare('insert or replace into settings (key, value, updated_at) values (?1, ?2, ?3)')
    .bind(ALLOWED_ORIGINS_SETTING, origin, t0)
    .run()
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  await db.exec('DELETE FROM settings')
})

describe('POST /comments/preview — the contract the composer builds against', () => {
  it('answers a Markdown draft with its rendered HTML', async () => {
    const response = await preview('The **export** is the hard part.')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
    expect(await response.text()).toBe('<p>The <strong>export</strong> is the hard part.</p>')
  })

  it('is the same HTML the published comment will carry, character for character', async () => {
    // The whole reason this endpoint exists rather than a Markdown parser in the
    // embed (#78, #1): a second implementation disagrees with the first exactly
    // when it matters, which is after the reader has posted. So the preview is not
    // *similar* to the published body — it is the identical string, and this test
    // is what keeps it that way.
    const draft = 'A [link](https://maya.build) and `code`.\n\n- one\n- two'

    const previewed = await preview(draft).then((r) => r.text())
    const published = renderComments([
      {
        id: 1,
        parentId: null,
        depth: 0,
        authorName: 'Maya',
        body: draft,
        createdAt: t0,
        byOwner: false,
      },
    ])

    expect(previewed).toBe(renderMarkdown(draft))
    expect(published).toContain(`<div class="charcha-comment-body">${previewed}</div>`)
  })

  it('renders the trimmed body, exactly as the submission would store it', async () => {
    // The schema trims before it stores, so a preview of the untrimmed draft would
    // differ from the published comment by whatever the reader typed at the edges.
    const response = await preview('   surrounded by space   ')

    expect(await response.text()).toBe('<p>surrounded by space</p>')
  })

  it('never stores the reader’s unsaved draft in any cache', async () => {
    const response = await preview('a draft nobody has posted')

    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('cannot be reached by navigation — a GET renders nothing', async () => {
    // POST-only is a security property, not a REST preference. A previewer
    // reachable by URL is a way to put attacker-chosen HTML on this Worker's own
    // origin with a link, and the renderer's escaping should not be the only thing
    // standing between that link and a reader.
    const response = await exports.default.fetch(`${worker}${PREVIEW_PATH}?body=hello`)

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await response.text()).not.toContain('<p>')
  })
})

describe('POST /comments/preview — it costs the deployment nothing', () => {
  it('writes nothing at all — no thread row, no comment row', async () => {
    await preview('# not a heading, but definitely not a comment either')

    const threads = await db.prepare('select count(*) as n from threads').first<{ n: number }>()
    const comments = await db.prepare('select count(*) as n from comments').first<{ n: number }>()
    expect(threads?.n).toBe(0)
    expect(comments?.n).toBe(0)
  })

  it('runs zero D1 queries when the caller sends no Origin', async () => {
    // The renderer is pure, so a preview needs the database for exactly one thing:
    // the owner's origin allowlist. A caller that is not a browser is not subject to
    // that policy, so it must not spend a row read either. Card rule: keep the query
    // count constant, and here the constant is zero.
    const { statements, envelope } = countingEnv()

    const response = await app.fetch(
      new Request(`${worker}${PREVIEW_PATH}`, { method: 'POST', body: 'hello' }),
      envelope,
    )

    expect(response.status).toBe(200)
    expect(statements).toEqual([])
  })

  it('runs exactly one D1 query for a browser — the allowlist, and nothing else', async () => {
    await allowOrigin(site)
    const { statements, envelope } = countingEnv()

    const response = await app.fetch(
      new Request(`${worker}${PREVIEW_PATH}`, {
        method: 'POST',
        headers: { origin: site },
        body: 'hello',
      }),
      envelope,
    )

    expect(response.status).toBe(200)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/from settings/)
  })
})

describe('POST /comments/preview — the size guard, shared with the write', () => {
  it('refuses an oversized Content-Length with 413, without reading the body', async () => {
    const response = await preview('hi', { 'content-length': String(MAX_BODY_BYTES + 1) })

    expect(response.status).toBe(413)
    expect(response.headers.get('content-type')).toMatch(/text\/plain/)
  })

  it('refuses an oversized body streamed without a Content-Length at all', async () => {
    // A chunked body carries no Content-Length, so the header check cannot fire and
    // the byte count of what was actually read is the only backstop. Without it an
    // attacker drops one header and walks a megabyte into the renderer.
    const huge = new TextEncoder().encode('x'.repeat(MAX_BODY_BYTES + 1_000))
    const request = new Request(`${worker}${PREVIEW_PATH}`, {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(huge)
          controller.close()
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    expect(request.headers.has('content-length')).toBe(false)

    const response = await exports.default.fetch(request)

    expect(response.status).toBe(413)
  })

  it('refuses a draft past the comment length the write accepts, with the same message', async () => {
    // Not a second, looser limit. A preview that rendered 100 KB while the write
    // caps at 10,000 characters would be a renderer to abuse rather than a preview.
    const response = await preview('x'.repeat(MAX_BODY_LENGTH + 1))

    expect(response.status).toBe(400)
    expect(await response.text()).toMatch(/too long/i)
  })

  it('accepts a draft exactly at the limit, so the cap is the write’s and not tighter', async () => {
    const response = await preview('x'.repeat(MAX_BODY_LENGTH))

    expect(response.status).toBe(200)
  })

  it('answers an empty draft with what the write would say, not with blank HTML', async () => {
    // Blank HTML and a failed request look identical in a preview pane. The reader
    // is told the same thing the Post button would tell them.
    const response = await preview('')

    expect(response.status).toBe(400)
    expect(await response.text()).toBe('A comment is required.')
  })

  it('treats a whitespace-only draft as empty, exactly as the write does', async () => {
    const response = await preview('   \n\t  ')

    expect(response.status).toBe(400)
  })

  it('never leaks an internal message on a rejection', async () => {
    const body = await preview('').then((r) => r.text())

    expect(body).not.toMatch(/zod|d1_|prepare|sqlite|renderMarkdown/i)
  })
})

describe('POST /comments/preview — the origin allowlist', () => {
  it('answers a configured origin and names it in the header', async () => {
    await allowOrigin(site)

    const response = await preview('hello', { origin: site })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(site)
  })

  it('refuses an unlisted browser origin outright, and renders nothing for it', async () => {
    // Unlike the read, which answers everyone and only withholds the header. The
    // read's reasons do not carry here: this output is not public data — it is a
    // pure function of the caller's own input — and no v1.1 server-rendering path
    // calls it over HTTP, so refusing costs nothing and denies work to a page the
    // owner never authorised.
    await allowOrigin(site)

    const response = await preview('**evil**', { origin: 'https://evil.example' })

    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(await response.text()).not.toContain('<strong>')
  })

  it('refuses every browser when the owner has configured nothing — fail closed', async () => {
    const response = await preview('hello', { origin: site })

    expect(response.status).toBe(403)
  })

  it('still answers a caller that sends no Origin, so curl and the owner can drive it', async () => {
    // Refusing here would stop no attack — anything that can omit the header was
    // never subject to CORS — and would break the owner debugging their deployment.
    await allowOrigin(site)

    const response = await preview('hello')

    expect(response.status).toBe(200)
  })

  it('never claims to accept credentials — card rule 8, no reader-side cookies', async () => {
    await allowOrigin(site)

    const response = await preview('hello', { origin: site })

    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('declares that the answer depends on the request Origin', async () => {
    await allowOrigin(site)

    const response = await preview('hello', { origin: site })

    expect(response.headers.get('vary')?.toLowerCase()).toContain('origin')
  })
})

describe('OPTIONS /comments/preview — the preflight', () => {
  function preflight(headers: Record<string, string>) {
    return exports.default.fetch(`${worker}${PREVIEW_PATH}`, { method: 'OPTIONS', headers })
  }

  it('approves a preflight from a configured origin', async () => {
    // The embed sends a plain-text body and is never preflighted. This exists for
    // the request that is not simple — any future header makes it one — so that the
    // endpoint does not answer 404 to a browser that asks permission first.
    await allowOrigin(site)

    const response = await preflight({
      origin: site,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(site)
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
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
})

describe('POST /comments/preview — attacker Markdown through the preview path', () => {
  // The published path has these tests already (test/worker/render/markdown.test.ts).
  // They are repeated *through this route* deliberately: the guarantee the composer
  // relies on is that the preview and the publish escape identically, and a route
  // that reached the renderer by another path would break that silently.
  const payloads: ReadonlyArray<[string, string, readonly string[]]> = [
    ['a script tag', '<script>alert(1)</script>', ['<script', '</script>']],
    ['an error-handler image', '<img src=x onerror=alert(1)>', ['<img']],
    ['a javascript: link', '[click me](javascript:alert(1))', ['<a ', 'href="javascript']],
    [
      'an attribute-breaking quote in a link',
      '[x](https://maya.build" onmouseover="alert(1))',
      ['<a ', 'onmouseover="'],
    ],
    ['a quote-broken code fence', '```\n"><script>alert(1)</script>\n```', ['<script', '">']],
    ['markup hidden in a blockquote', '> <iframe src=//evil.example></iframe>', ['<iframe']],
    ['a tag split across a hard line break', '<scr\nipt>alert(1)</scr\nipt>', ['<scr']],
    ['a data: URL link', '[x](data:text/html,<script>alert(1)</script>)', ['<a ', 'href=']],
    ['a control character smuggled into a scheme', '[x](java\tscript:alert(1))', ['<a ', 'href=']],
  ]

  for (const [name, payload, forbidden] of payloads) {
    it(`escapes ${name}`, async () => {
      const html = await preview(payload).then((r) => r.text())

      for (const fragment of forbidden) expect(html).not.toContain(fragment)
    })

    it(`escapes ${name} identically to the published comment`, async () => {
      const html = await preview(payload).then((r) => r.text())

      expect(html).toBe(renderMarkdown(payload))
    })

    it(`emits only the renderer’s own tags and attributes for ${name}`, async () => {
      // The per-payload lists above only catch attacks somebody thought of. This is
      // what holds against the ones nobody has: whatever arrives, every tag that
      // comes back is one src/render/markdown.ts declares, and every attribute is
      // one this project writes literally. A payload that invented either would be
      // a fragment the renderer built rather than escaped.
      const html = await preview(payload).then((r) => r.text())

      for (const tag of tagsIn(html)) expect(MARKDOWN_ELEMENTS).toContain(tag)
      // The only attributes src/render/markdown.ts ever writes, and it writes all
      // three of them literally, on the one element that carries any.
      for (const attribute of attributesIn(html)) {
        expect(['href', 'rel', 'target']).toContain(attribute)
      }
    })
  }

  it('stays cheap on a body written to make the scanner backtrack', async () => {
    // This endpoint is where an attacker picks the renderer's input directly and
    // can repeat it, so the cost of the *worst* legal body matters, not the
    // average one. A full cap of unclosed link syntax is the shape that would go
    // quadratic under a scanner that restarted its search on every `[`; the
    // forward-only cursor in src/render/markdown.ts is what keeps it linear, and
    // Workers Free allows 10 ms of CPU per request (verified 2026-07-25,
    // https://developers.cloudflare.com/workers/platform/limits/).
    const pathological = '['.repeat(MAX_BODY_LENGTH - 1) + ']'

    const response = await preview(pathological)

    expect(response.status).toBe(200)
    for (const tag of tagsIn(await response.text())) expect(tag).toBe('p')
  })

  it('invents no element for markup the subset does not know at all', async () => {
    const html = await preview(
      '<svg onload=alert(1)><math><style>x</style><object data="y">\n\n<form action=z>',
    ).then((r) => r.text())

    for (const tag of tagsIn(html)) expect(tag).toBe('p')
    expect(attributesIn(html)).toEqual([])
  })
})

/** Every element name the response opens or closes, in order. */
function tagsIn(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((match) => match[1]!.toLowerCase())
}

/** Every `name=` that appears inside a tag of the response, in order. */
function attributesIn(html: string): string[] {
  return [...html.matchAll(/<[a-zA-Z][^>]*?>/g)].flatMap((tag) =>
    [...tag[0].matchAll(/\s([a-zA-Z-]+)=/g)].map((match) => match[1]!.toLowerCase()),
  )
}

/**
 * An `Env` whose D1 binding records every statement prepared through it.
 *
 * A count assertion is only worth anything against the binding the route actually
 * uses, so this wraps the real one rather than faking it — the queries still run,
 * and the test still sees real answers.
 */
function countingEnv(): { statements: string[]; envelope: Env } {
  const statements: string[] = []
  const real = env.DB
  const spy = new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (sql: string) => {
          statements.push(sql)
          return target.prepare(sql)
        }
      }
      // Everything else passes straight through, bound to the real binding — a
      // spy that broke `batch` or `exec` would be measuring itself.
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') return value
      const method = value as (this: D1Database, ...args: unknown[]) => unknown
      return method.bind(target)
    },
  })
  return { statements, envelope: { ...env, DB: spy } }
}
