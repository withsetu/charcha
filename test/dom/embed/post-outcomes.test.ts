// What the widget says when the Worker accepts a comment but sends back nothing it
// can show (#93).
//
// The status code is the whole taxonomy — 201 published, 202 held for review — so a
// 2xx means the comment was accepted and the embed must never call that a failure.
// The body is a separate promise, and it is one the embed cannot enforce: `data-api`
// is owner configuration and can point anywhere, which src/embed/api.ts already says
// out loud. Before #93 the two were conflated: the insert bailed silently on a body
// with no `.charcha-comment` in it, and the reader was told "Only you can see it
// here" on a thread still reading "Be the first."
//
// These tests are the third outcome written down. They live apart from
// mount.test.ts because #94 is rewriting that file's fixtures; the small harness
// below is a deliberate duplicate for the length of that overlap, and #112 is the
// issue for folding the two together once it lands.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmbedConfig } from '../../../src/embed/config'
import { fieldIds } from '../../../src/embed/markup'
import { mountWidget } from '../../../src/embed/mount'

const API = 'https://comments.example.com'
const CONFIG: EmbedConfig = { api: API, thread: null, styles: 'inherit', turnstileSitekey: null }

const READ_FAILED = 'Comments could not be loaded.'
const POSTED_PENDING = 'Thanks — your comment is awaiting review. Only you can see it here.'
const POSTED_PUBLISHED = 'Thanks — your comment is published.'
const POSTED_UNSHOWN =
  'Your comment was received, but it could not be shown here. ' +
  'Your text is still in the box below — posting it again would send it twice.'

const EMPTY_THREAD = '<p class="charcha-empty">Be the first to comment.</p>'

/** One rendered comment, in the shape src/render/comments.ts emits. */
function commentHtml(id: number): string {
  return (
    `<li class="charcha-comment" id="charcha-comment-${id}">` +
    `<div class="charcha-comment-header"><span class="charcha-comment-author">Reader</span></div>` +
    `<div class="charcha-comment-body"><p>Hello.</p></div>` +
    `</li>`
  )
}

function threadHtml(...comments: string[]): string {
  return `<ol class="charcha-comments">${comments.join('')}</ol>`
}

type Outcome = { status: number; body: string }

interface Call {
  url: string
  method: string
  body: string | null
}

/** Answers the widget's fetches in order, consuming one outcome per request. */
function serve(...outcomes: readonly Outcome[]): { calls: Call[] } {
  const calls: Call[] = []
  let next = 0

  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: { method?: string; body?: unknown }) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      })
      const outcome = outcomes[next]
      next += 1
      if (outcome === undefined) {
        return Promise.reject(new Error(`unexpected request ${calls.length}: ${String(input)}`))
      }
      return Promise.resolve(new Response(outcome.body, { status: outcome.status }))
    }),
  )

  return { calls }
}

interface Harness {
  status: HTMLElement
  thread: HTMLElement
  form: HTMLFormElement
  body: HTMLTextAreaElement
  name: HTMLInputElement
  email: HTMLInputElement
  error: HTMLElement
  submit: HTMLButtonElement
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (found === null) throw new Error(`the widget has no ${selector}`)
  return found
}

async function mount(): Promise<Harness> {
  const host = document.createElement('div')
  host.id = 'charcha'
  document.body.appendChild(host)

  mountWidget(host, CONFIG, 1)

  const root = must<HTMLElement>(host, '.charcha-root')
  const id = fieldIds('charcha-1')
  const harness: Harness = {
    status: must<HTMLElement>(root, '.charcha-status'),
    thread: must<HTMLElement>(root, '.charcha-thread'),
    form: must<HTMLFormElement>(root, '.charcha-form'),
    body: must<HTMLTextAreaElement>(root, `#${id.body}`),
    name: must<HTMLInputElement>(root, `#${id.name}`),
    email: must<HTMLInputElement>(root, `#${id.email}`),
    error: must<HTMLElement>(root, `#${id.error}`),
    submit: must<HTMLButtonElement>(root, '.charcha-submit'),
  }

  // Set before the read and cleared in a `finally`, so it is true for exactly as
  // long as a read is outstanding — on the success path and the failure path alike.
  await vi.waitFor(() => {
    expect(harness.thread.hasAttribute('aria-busy')).toBe(false)
  })
  return harness
}

function compose(harness: Harness, body = 'Something worth saying.'): void {
  harness.body.value = body
  harness.name.value = 'Reader'
  harness.email.value = ''
}

function submitForm(harness: Harness): void {
  harness.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

/** Waits for the widget to have finished with the POST, whatever it decided. */
async function settled(harness: Harness): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.submit.disabled).toBe(false)
  })
}

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  document.body.innerHTML = ''
  document.title = 'Hello, world'
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/* -------------------------------------------------------------------------- */

describe('when the server accepts a comment but sends nothing to show', () => {
  // Four bodies, one outcome. The first three are what a misconfigured `data-api`,
  // a proxy that ate the body, or a stripped renderer actually return; the fourth is
  // the body the bug was reproduced against on #93.
  const bodies: readonly { name: string; body: string }[] = [
    { name: 'an empty body', body: '' },
    { name: 'a body of whitespace', body: '   \n\t  ' },
    { name: 'a body with no comment in it', body: '<p>Thanks!</p>' },
    { name: 'a body that is JSON', body: '{"ok":true}' },
  ]

  for (const status of [201, 202]) {
    for (const { name, body } of bodies) {
      it(`says so, for a ${status} with ${name}`, async () => {
        serve({ status: 200, body: EMPTY_THREAD }, { status, body })

        const harness = await mount()
        compose(harness)
        submitForm(harness)
        await settled(harness)

        // The whole of the bug: the reader was told their comment was on the page.
        expect(harness.status.textContent).toBe(POSTED_UNSHOWN)
        expect(harness.status.textContent).not.toContain(POSTED_PENDING)
        expect(harness.status.textContent).not.toContain(POSTED_PUBLISHED)
      })
    }
  }

  it('keeps what the reader wrote, because it is the only copy they can see', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { status: 201, body: '' })

    const harness = await mount()
    compose(harness, 'Something worth saying.')
    submitForm(harness)
    await settled(harness)

    // Clearing the box is safe only when the comment is on screen. It is not, and
    // the two ways of being wrong are not symmetrical: a comment the server really
    // stored can be recovered by reloading, while text thrown away by a widget that
    // believed a 201 from something that is not a Charcha deployment is gone.
    expect(harness.body.value).toBe('Something worth saying.')
    expect(harness.name.value).toBe('Reader')
  })

  it('does not claim the thread has something on it', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { status: 202, body: '' })

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await settled(harness)

    // Nothing was inserted, so the invitation stays. A widget that emptied the
    // thread here would have turned "no comments" into "no page".
    expect(harness.thread.querySelector('.charcha-empty')).not.toBeNull()
    expect(harness.thread.querySelector('.charcha-comment')).toBeNull()
  })

  it('is not a read failure, so it offers no retry and shows no error', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { status: 201, body: '' })

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await settled(harness)

    // Three states have to stay apart: the read failed, the post failed, and the
    // post succeeded but cannot be shown. A retry here would re-read the thread,
    // which answers a question nobody asked; the error region would paint an
    // accepted comment as a refusal.
    expect(harness.status.querySelector('.charcha-retry')).toBeNull()
    expect(harness.status.textContent).not.toContain(READ_FAILED)
    expect(harness.error.hidden).toBe(true)
  })

  it('gives the site owner the detail, in the console', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { status: 202, body: '{"ok":true}' })

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await settled(harness)

    // This is a deployment fault, and the reader cannot fix it. The one person who
    // can is reading the console on their own site.
    expect(consoleError).toHaveBeenCalledWith(
      'charcha: comment accepted but could not be shown',
      202,
    )
  })

  it('gives the button back, so the reader is not stranded', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { status: 201, body: '' })

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await settled(harness)

    expect(harness.submit.disabled).toBe(false)
    expect(harness.submit.textContent).toBe('Post comment')
  })

  it('says so when the comment it is a reply to is no longer on the page', async () => {
    // The second door into the same bug, found auditing the branch. A reply is
    // placed inside its parent, and the parent can be gone by the time the answer
    // arrives — the thread is replaced wholesale by every read. The comment then
    // lands in a fragment attached to nothing, which is invisible in exactly the
    // way an empty body is, and the old code could not tell the two apart because
    // it did not look.
    serve({ status: 200, body: threadHtml(commentHtml(2)) }, { status: 201, body: commentHtml(10) })

    const harness = await mount()
    must<HTMLButtonElement>(
      must(harness.thread, '#charcha-comment-2'),
      '.charcha-reply-button',
    ).click()
    compose(harness)
    submitForm(harness)
    // Synchronously, while the POST is in flight: submit() reads the form and then
    // awaits, so this lands in the same window a read racing the post would.
    harness.thread.innerHTML = ''
    await settled(harness)

    expect(harness.status.textContent).toBe(POSTED_UNSHOWN)
    expect(harness.body.value).toBe('Something worth saying.')
  })

  it('keeps a reply addressed to the comment it was written under', async () => {
    const { calls } = serve(
      { status: 200, body: threadHtml(commentHtml(2)) },
      { status: 201, body: '' },
      { status: 201, body: commentHtml(10) },
    )

    const harness = await mount()
    must<HTMLButtonElement>(
      must(harness.thread, '#charcha-comment-2'),
      '.charcha-reply-button',
    ).click()
    compose(harness)
    submitForm(harness)
    await settled(harness)

    // Keeping the reader's text while sending the composer home would silently
    // re-target it: the same words, posted a second time, would land as a root
    // comment answering nobody.
    expect(must(harness.thread, '#charcha-comment-2').contains(harness.form)).toBe(true)

    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.thread.querySelector('#charcha-comment-10')).not.toBeNull()
    })
    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(JSON.parse(posts[1]?.body ?? '{}')).toMatchObject({ parentId: 2 })
  })
})

describe('when the server sends back a comment, as it should', () => {
  // The path #93 must not cost anything. Both of these pass before the fix and
  // after it; they are here so that a guard written for the empty body cannot be
  // widened into one that swallows the normal case.

  it('still clears the box and says the comment is published', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { status: 201, body: commentHtml(3) })

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.thread.querySelector('#charcha-comment-3')).not.toBeNull()
    })

    expect(harness.body.value).toBe('')
    expect(harness.status.textContent).toBe(POSTED_PUBLISHED)
  })

  it('still says a held comment is awaiting review', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { status: 202, body: commentHtml(4) })

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.thread.querySelector('#charcha-comment-4')).not.toBeNull()
    })

    expect(harness.body.value).toBe('')
    expect(harness.status.textContent).toBe(POSTED_PENDING)
    expect(harness.thread.querySelector('.charcha-pending')).not.toBeNull()
  })
})
