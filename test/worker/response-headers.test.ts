// Issue #98 — every public response that can carry attacker-influenced HTML must
// refuse to be a document.
//
// The renderer is escape-then-build and test/worker/render/vocabulary.test.ts
// asserts nothing outside the declared element list ever reaches the page, so this
// is a second lock rather than a fix for a live bug. The point of testing it here,
// across every endpoint and every status at once, is the thing #98 was opened
// about: a header on one of three sibling responses reads as protection while the
// larger door stands open. A list is the only form of that assertion that fails
// when the next response is added without one.

import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { getOrCreateThread, insertComment, setCommentStatus } from '../../src/db'
import { ALLOWED_ORIGINS_SETTING } from '../../src/cors'
import { MAX_BODY_BYTES } from '../../src/request-body'
import { PREVIEW_PATH } from '../../src/preview/route'
import { FRAGMENT_CSP } from '../../src/response-headers'

const db = env.DB
const worker = 'https://charcha.example'
const site = 'https://maya.build'
const unlisted = 'https://evil.example'
const t0 = 1_753_300_000

async function allowOrigin(origin: string) {
  await db
    .prepare('insert or replace into settings (key, value, updated_at) values (?1, ?2, ?3)')
    .bind(ALLOWED_ORIGINS_SETTING, origin, t0)
    .run()
}

async function seedApprovedComment(pageKey = '/notes/leaving') {
  const thread = await getOrCreateThread(db, { pageKey, pageUrl: `${site}${pageKey}`, now: t0 })
  const root = await insertComment(db, {
    threadId: thread.id,
    authorName: 'Rahul Kanwar',
    body: 'The export is the hard part.',
    bodyHash: 'h1',
    now: t0,
  })
  await setCommentStatus(db, root.id, 'approved', t0 + 10)
}

const validSubmission = JSON.stringify({
  authorName: 'Rahul Kanwar',
  body: 'The export is the hard part.',
  url: `${site}/notes/leaving`,
})

/**
 * Every response the three public endpoints can produce, named by what it is.
 *
 * Built as a list rather than one assertion per test because #98's complaint is
 * about coverage, not about any single header: the failure this guards is a fourth
 * response shipping without the pair, and only an enumeration catches that.
 */
const responses: Array<{ what: string; make: () => Promise<Response> }> = [
  {
    what: 'GET /comments — the page conversation',
    make: async () => {
      await seedApprovedComment()
      return exports.default.fetch(
        `${worker}/comments?url=${encodeURIComponent(`${site}/notes/leaving`)}`,
      )
    },
  },
  {
    what: 'GET /comments — a rejected page address',
    make: () => exports.default.fetch(`${worker}/comments?url=not-a-url`),
  },
  {
    what: 'POST /comments — the reader own comment, echoed back',
    make: () =>
      exports.default.fetch(`${worker}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: validSubmission,
      }),
  },
  {
    what: 'POST /comments — an unreadable body',
    make: () =>
      exports.default.fetch(`${worker}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json at all',
      }),
  },
  {
    what: 'POST /comments — a body past the size cap',
    make: () =>
      exports.default.fetch(`${worker}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(MAX_BODY_BYTES + 1),
      }),
  },
  {
    what: 'POST /comments — a browser origin the owner never listed',
    make: async () => {
      await allowOrigin(site)
      return exports.default.fetch(`${worker}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: unlisted },
        body: validSubmission,
      })
    },
  },
  {
    what: 'POST /comments/preview — the reader draft',
    make: () =>
      exports.default.fetch(`${worker}${PREVIEW_PATH}`, {
        method: 'POST',
        body: 'The **export** is the hard part.',
      }),
  },
  {
    what: 'POST /comments/preview — an empty draft',
    make: () => exports.default.fetch(`${worker}${PREVIEW_PATH}`, { method: 'POST', body: '   ' }),
  },
  {
    what: 'POST /comments/preview — a body past the size cap',
    make: () =>
      exports.default.fetch(`${worker}${PREVIEW_PATH}`, {
        method: 'POST',
        body: 'x'.repeat(MAX_BODY_BYTES + 1),
      }),
  },
  {
    what: 'POST /comments/preview — a browser origin the owner never listed',
    make: async () => {
      await allowOrigin(site)
      return exports.default.fetch(`${worker}${PREVIEW_PATH}`, {
        method: 'POST',
        headers: { origin: unlisted },
        body: 'The **export** is the hard part.',
      })
    },
  },
  {
    what: 'OPTIONS /comments — a refused preflight',
    make: async () => {
      await allowOrigin(site)
      return exports.default.fetch(`${worker}/comments`, {
        method: 'OPTIONS',
        headers: { origin: unlisted },
      })
    },
  },
]

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  await db.exec('DELETE FROM settings')
})

describe('the public endpoints refuse to be documents (#98)', () => {
  for (const { what, make } of responses) {
    it(`sends nosniff and the fragment CSP on: ${what}`, async () => {
      const response = await make()

      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('content-security-policy')).toBe(FRAGMENT_CSP)
    })
  }

  it('states the policy exactly, because each half of it does separate work', () => {
    // `sandbox` with no tokens is the whole sandboxing flag set, which includes the
    // sandboxed origin flag — "This flag forces content into an opaque origin"
    // (https://html.spec.whatwg.org/multipage/browsers.html#sandboxing). So a
    // browser navigated here does not get a document on the Worker's origin at all,
    // which is the exact harm #98 names. `default-src 'none'` is the belt: it blocks
    // every subresource that document could otherwise ask for.
    //
    // Written as an equality rather than a substring match on purpose. A CSP is
    // parsed as a whole, and a policy that gained a directive nobody intended should
    // fail here rather than continue to satisfy a `toContain`.
    expect(FRAGMENT_CSP).toBe("default-src 'none'; sandbox")
  })
})

describe('the embed is unaffected by the headers on the responses it fetches', () => {
  it('still reads the whole conversation, with the CORS header the browser needs', async () => {
    // The end-to-end proof #98 asks for. `sandbox` populates the CSP-derived
    // sandboxing flags, which are read only by "create and initialize a new Document
    // object" and "run a worker" (https://w3c.github.io/webappsec-csp/#directive-sandbox)
    // — neither of which a `fetch` performs. The string the embed hands to
    // `innerHTML` lands in the *host* page, where the host's own CSP governs and
    // this response's never applied.
    await allowOrigin(site)
    await seedApprovedComment()

    const response = await exports.default.fetch(
      `${worker}/comments?url=${encodeURIComponent(`${site}/notes/leaving`)}`,
      { headers: { origin: site } },
    )
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(site)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
    expect(html).toContain('charcha-comments')
    expect(html).toContain('The export is the hard part.')
  })

  it('leaves the cache policy each endpoint chose intact', async () => {
    // The headers are added to responses that already carry deliberate ones, and a
    // helper that rebuilt a Response could drop them silently — src/cors.ts makes
    // the same point about withCors. The read is cacheable for a minute; the
    // preview, being an unsaved draft, is never stored.
    await seedApprovedComment()

    const read = await exports.default.fetch(
      `${worker}/comments?url=${encodeURIComponent(`${site}/notes/leaving`)}`,
    )
    const preview = await exports.default.fetch(`${worker}${PREVIEW_PATH}`, {
      method: 'POST',
      body: 'a draft',
    })

    expect(read.headers.get('cache-control')).toMatch(/private/)
    expect(preview.headers.get('cache-control')).toBe('no-store')
  })
})
