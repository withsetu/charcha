// src/embed/mount.ts is the only file in this project that puts network data into a
// page, and until #91 there was no environment it could run in — so every guard in
// it was enforced by a comment and by one person's memory of a manual drive.
//
// These tests exist to fail. Each one is kill-shotted in the PR on #91: the guard is
// disabled, the test is confirmed red, the guard is restored (card rule 6). The two
// that matter most are the ones a refactor would flip without noticing — the write
// error and the reply-to label, both of which take a string that came off the
// network and must reach the DOM as *text*.
//
// The widget is driven the way a reader drives it: mount it, answer its fetches,
// click its buttons. Nothing here reaches inside mount.ts for a private function,
// because the module's exports are its whole surface and a test that knows more than
// that stops noticing when the wiring breaks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmbedConfig } from '../../../src/embed/config'
import { REPLYING_CLASS, fieldIds } from '../../../src/embed/markup'
import { mountWidget } from '../../../src/embed/mount'

const API = 'https://comments.example.com'
// No sitekey: the deployment has not configured Turnstile (#79), which is the
// default and the case every test here is about. The widget renders and posts
// without a token, and the server layer abstains rather than rejecting.
const CONFIG: EmbedConfig = { api: API, thread: null, styles: 'inherit', turnstileSitekey: null }

const LOADING = 'Loading comments…'
const READ_FAILED = 'Comments could not be loaded.'
const POSTED_PENDING = 'Thanks — your comment is awaiting review. Only you can see it here.'
const POSTED_PUBLISHED = 'Thanks — your comment is published.'

/* -------------------------------------------------------------------------- */
/* The Worker's side of the wire                                               */
/* -------------------------------------------------------------------------- */

/**
 * The comment HTML the Worker sends, mirroring src/render/comments.ts.
 *
 * Written out here rather than imported: the renderer's module reaches the data
 * layer for a type, and the data layer is typed against Cloudflare's ambient
 * globals, which this program deliberately does not have (test/dom/tsconfig.json).
 * The class names below are the renderer's public contract, frozen by
 * test/worker/render/comments.test.ts — this file consumes them, it does not own
 * them. That the copy is uncoupled from the original is a real gap and is tracked
 * on #94: a rename made consistently across the renderer and its own test would
 * leave these fixtures, and mount.ts's selectors, out of step with nothing red.
 *
 * `author` is given already escaped, because that is what arrives over the wire.
 */
function commentHtml(options: {
  id: number
  author: string
  body?: string
  replies?: readonly { id: number; author: string }[]
}): string {
  const replies = options.replies ?? []
  return (
    `<li class="charcha-comment" id="charcha-comment-${options.id}">` +
    `<div class="charcha-comment-header">` +
    `<span class="charcha-comment-author">${options.author}</span>` +
    `<time class="charcha-comment-time" datetime="2026-07-24T10:00:00.000Z">2026-07-24 10:00 UTC</time>` +
    `</div>` +
    `<div class="charcha-comment-body"><p>${options.body ?? 'Hello.'}</p></div>` +
    (replies.length === 0
      ? ''
      : `<ol class="charcha-replies">` +
        replies
          .map(
            (reply) =>
              `<li class="charcha-comment charcha-reply" id="charcha-comment-${reply.id}">` +
              `<div class="charcha-comment-header">` +
              `<span class="charcha-comment-author">${reply.author}</span>` +
              `</div>` +
              `<div class="charcha-comment-body"><p>A reply.</p></div>` +
              `</li>`,
          )
          .join('') +
        `</ol>`) +
    `</li>`
  )
}

function threadHtml(...comments: string[]): string {
  return `<ol class="charcha-comments">${comments.join('')}</ol>`
}

const EMPTY_THREAD = '<p class="charcha-empty">Be the first to comment.</p>'

/* -------------------------------------------------------------------------- */
/* A network the test owns                                                     */
/* -------------------------------------------------------------------------- */

/** What the fake network does when the widget calls it. */
type Outcome =
  | { status: number; body: string }
  /** The rejection branch: no server, a blocked origin, a dropped connection. */
  | { networkError: string }
  /** A request that never settles, so the in-flight state can be observed. */
  | { pending: true }

interface Call {
  url: string
  method: string
  body: string | null
}

/**
 * Answers the widget's fetches in order, and records what it asked for.
 *
 * Outcomes are consumed rather than repeated: a widget that makes one more request
 * than the test expected gets a loud rejection instead of quietly being handed the
 * previous answer again, which is how a double-submit bug would hide from the very
 * test written to catch it.
 */
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
      if ('pending' in outcome) return new Promise<Response>(() => {})
      if ('networkError' in outcome) return Promise.reject(new Error(outcome.networkError))
      return Promise.resolve(new Response(outcome.body, { status: outcome.status }))
    }),
  )

  return { calls }
}

/* -------------------------------------------------------------------------- */
/* The widget under test                                                       */
/* -------------------------------------------------------------------------- */

function must<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (found === null) throw new Error(`the widget has no ${selector}`)
  return found
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

/** Fires the event the composer's own submit button fires, bypassing `disabled`. */
function submitForm(harness: Harness): void {
  harness.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

/**
 * Mounts one widget and waits for its opening read to settle.
 *
 * `aria-busy` is the signal because mount.ts sets it before the fetch and clears it
 * in a `finally`, so it is true for exactly as long as a read is outstanding — on
 * both the success and the failure path.
 */
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

  await vi.waitFor(() => {
    expect(harness.thread.hasAttribute('aria-busy')).toBe(false)
  })
  return harness
}

/** Fills the composer in, as a reader would before pressing Post. */
function compose(harness: Harness, body = 'A comment.'): void {
  harness.body.value = body
  harness.name.value = 'Reader'
  harness.email.value = ''
}

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  document.body.innerHTML = ''
  document.title = 'Hello, world'
  // mount.ts logs the detail a site owner needs on every failure path. Swallowed
  // here so a passing suite is quiet, and asserted where the failure is the subject.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/* -------------------------------------------------------------------------- */

describe('mounting the widget', () => {
  it('reads the page it is on, and shows what came back', async () => {
    const { calls } = serve({
      status: 200,
      body: threadHtml(commentHtml({ id: 1, author: 'Ada' })),
    })

    const harness = await mount()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain(`${API}/comments`)
    // The address of the page the widget is on, not one the embed was told — the
    // page key is derived by the Worker from this (src/page-key.ts). Written out
    // rather than compared to `location.href`, which would pass against any page
    // address at all, including the environment's default.
    expect(calls[0]?.url).toContain(encodeURIComponent('https://example.com/posts/hello/'))
    expect(harness.thread.querySelector('#charcha-comment-1')).not.toBeNull()
    expect(harness.status.textContent).toBe('')
  })

  it('offers a Reply on every root comment, and on no reply', async () => {
    serve({
      status: 200,
      body: threadHtml(
        commentHtml({ id: 1, author: 'Ada', replies: [{ id: 2, author: 'Grace' }] }),
      ),
    })

    const harness = await mount()

    // One level only: the schema stops at two, so a Reply on a reply would offer
    // the reader something the server refuses.
    expect(
      must(harness.thread, '#charcha-comment-1').querySelector(':scope > .charcha-comment-actions'),
    ).not.toBeNull()
    expect(
      must(harness.thread, '#charcha-comment-2').querySelector('.charcha-comment-actions'),
    ).toBeNull()
  })

  it('replaces whatever the site owner left inside the mount element', async () => {
    serve({ status: 200, body: EMPTY_THREAD })
    const host = document.createElement('div')
    host.textContent = 'Comments need JavaScript.'
    document.body.appendChild(host)

    mountWidget(host, CONFIG, 1)
    await vi.waitFor(() => {
      expect(must(host, '.charcha-thread').hasAttribute('aria-busy')).toBe(false)
    })

    expect(host.textContent).not.toContain('Comments need JavaScript.')
    expect(host.querySelector('.charcha-root')).not.toBeNull()
  })
})

describe('when the read fails', () => {
  // CLAUDE.md: a loading skeleton that never resolves is an unreported failure. The
  // `catch` in load() owes the reader a state they can see and act on, and these are
  // the assertions that say so — the console alone is not a report to anybody.

  it('says so on the page instead of leaving the reader on "Loading"', async () => {
    serve({ networkError: 'connection refused' })

    const harness = await mount()

    expect(harness.status.textContent).toContain(READ_FAILED)
    expect(harness.status.textContent).not.toContain(LOADING)
  })

  it('offers a retry, because a failed read is not an empty page', async () => {
    serve({ status: 500, body: 'boom' })

    const harness = await mount()

    expect(harness.status.querySelector('.charcha-retry')).not.toBeNull()
    // Nothing half-rendered left underneath the message.
    expect(harness.thread.innerHTML).toBe('')
  })

  it('reads again when the retry is pressed, and renders what arrives', async () => {
    const { calls } = serve(
      { networkError: 'connection refused' },
      { status: 200, body: threadHtml(commentHtml({ id: 7, author: 'Ada' })) },
    )

    const harness = await mount()
    must<HTMLButtonElement>(harness.status, '.charcha-retry').click()
    await vi.waitFor(() => {
      expect(harness.thread.querySelector('#charcha-comment-7')).not.toBeNull()
    })

    expect(calls).toHaveLength(2)
    expect(harness.status.textContent).toBe('')
  })

  it('stops telling assistive technology that it is busy', async () => {
    serve({ networkError: 'connection refused' })

    const harness = await mount()

    // Set before the fetch and cleared in a `finally`. Left behind on the failure
    // path, a screen reader is told the region is still updating, forever.
    expect(harness.thread.hasAttribute('aria-busy')).toBe(false)
  })

  it('still gives the site owner the detail, in the console', async () => {
    serve({ networkError: 'connection refused' })

    await mount()

    expect(consoleError).toHaveBeenCalledWith('charcha: could not load comments', expect.anything())
  })
})

describe('what the server says about a rejected comment', () => {
  // The security test on this file. The message is a string that came off the
  // network, and the base address is owner configuration — it can point anywhere,
  // including at something that is not a Charcha deployment. src/embed/api.ts
  // normalises and refuses markup; this is the second lock, and the one a refactor
  // would flip: `textContent` and `innerHTML` look interchangeable at a call site.

  it('inserts the server message as text, never as markup', async () => {
    // No literal angle brackets, so it survives the api.ts filter and actually
    // reaches the DOM — which is what makes this an assertion about *this* guard
    // rather than about the one upstream of it. Entities are the tell: written as
    // text they stay written out, and `innerHTML` would decode them.
    const message = 'Rejected: your comment contains &lt;script&gt; and 5 &amp; 6 links.'
    serve({ status: 200, body: EMPTY_THREAD }, { status: 403, body: message })

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.error.hidden).toBe(false)
    })

    expect(harness.error.textContent).toBe(message)
    expect(harness.error.childElementCount).toBe(0)
  })

  it('shows the error rather than hiding it in an aria-hidden node', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { status: 400, body: 'Your comment is empty.' })

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.error.textContent).toBe('Your comment is empty.')
    })

    // `hidden` is what the composer ships with, and it has to come off or the
    // message is in the DOM and on nobody's screen.
    expect(harness.error.hidden).toBe(false)
  })

  it('tells the reader something when there is no server at all', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { networkError: 'connection refused' })

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.error.hidden).toBe(false)
    })

    expect(harness.error.textContent).not.toBe('')
    expect(consoleError).toHaveBeenCalledWith('charcha: could not post comment', expect.anything())
  })

  it('clears the previous error before the next attempt', async () => {
    serve(
      { status: 200, body: EMPTY_THREAD },
      { status: 400, body: 'Your comment is empty.' },
      { status: 201, body: commentHtml({ id: 3, author: 'Reader' }) },
    )

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.error.hidden).toBe(false)
    })

    compose(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.thread.querySelector('#charcha-comment-3')).not.toBeNull()
    })

    // A stale refusal sitting above a comment that was just accepted is a widget
    // telling the reader two contradictory things at once.
    expect(harness.error.hidden).toBe(true)
    expect(harness.error.textContent).toBe('')
  })
})

describe('posting a comment', () => {
  it('puts the reader’s own comment on the page, badged as pending', async () => {
    serve(
      { status: 200, body: EMPTY_THREAD },
      // 202 is the moderation queue: a success, and the reader is told the truth
      // about it rather than watching their words vanish behind a promise (#5).
      { status: 202, body: commentHtml({ id: 4, author: 'Reader' }) },
    )

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.thread.querySelector('#charcha-comment-4')).not.toBeNull()
    })

    const posted = must<HTMLElement>(harness.thread, '#charcha-comment-4')
    expect(posted.querySelector('.charcha-pending')?.textContent).toBe('Pending review')
    expect(harness.status.textContent).toContain(POSTED_PENDING)
  })

  it('posts when the reader presses the composer’s own button', async () => {
    // Every other test here dispatches the submit event directly, so that a
    // disabled button cannot mask the guard being tested. That leaves one thing
    // unasserted, and it is the first thing a reader does: this is the test that
    // the button is wired to the form at all, and that the handler prevents the
    // native POST an endpoint reading JSON would answer 400 to.
    const { calls } = serve(
      { status: 200, body: EMPTY_THREAD },
      { status: 201, body: commentHtml({ id: 11, author: 'Reader' }) },
    )

    const harness = await mount()
    compose(harness)
    harness.submit.click()
    await vi.waitFor(() => {
      expect(harness.thread.querySelector('#charcha-comment-11')).not.toBeNull()
    })

    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('badges nothing when the comment was published outright', async () => {
    serve(
      { status: 200, body: EMPTY_THREAD },
      { status: 201, body: commentHtml({ id: 5, author: 'Reader' }) },
    )

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.thread.querySelector('#charcha-comment-5')).not.toBeNull()
    })

    expect(harness.thread.querySelector('.charcha-pending')).toBeNull()
    expect(harness.status.textContent).toContain(POSTED_PUBLISHED)
  })

  it('replaces the invitation rather than commenting underneath it', async () => {
    serve(
      { status: 200, body: EMPTY_THREAD },
      { status: 202, body: commentHtml({ id: 6, author: 'Reader' }) },
    )

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.thread.querySelector('#charcha-comment-6')).not.toBeNull()
    })

    // "Be the first to comment" left above the first comment is the widget telling
    // the reader to do the thing they just did.
    expect(harness.thread.querySelector('.charcha-empty')).toBeNull()
    expect(
      must(harness.thread, '.charcha-comments').contains(
        must(harness.thread, '#charcha-comment-6'),
      ),
    ).toBe(true)
  })

  it('moves focus to the comment it just placed', async () => {
    serve(
      { status: 200, body: EMPTY_THREAD },
      { status: 202, body: commentHtml({ id: 8, author: 'Reader' }) },
    )

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.thread.querySelector('#charcha-comment-8')).not.toBeNull()
    })

    // A keyboard or screen-reader reader is taken to what just happened, rather
    // than left standing at a button that emptied itself.
    expect(document.activeElement).toBe(harness.thread.querySelector('#charcha-comment-8'))
  })

  it('empties the body but keeps the name, so a second comment is not retyped', async () => {
    serve(
      { status: 200, body: EMPTY_THREAD },
      { status: 201, body: commentHtml({ id: 9, author: 'Reader' }) },
    )

    const harness = await mount()
    compose(harness, 'Something worth saying.')
    harness.email.value = 'reader@example.com'
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.thread.querySelector('#charcha-comment-9')).not.toBeNull()
    })

    expect(harness.body.value).toBe('')
    expect(harness.name.value).toBe('Reader')
    expect(harness.email.value).toBe('reader@example.com')
  })
})

describe('double submission', () => {
  it('posts once when the reader submits twice before the first finishes', async () => {
    // The second outcome never settles, so the first POST is still in flight when
    // the second submit arrives — the exact window an impatient Enter falls into.
    // Only one outcome is queued after it: a second POST would be answered with a
    // rejection, and the call count below is what names the bug either way.
    const { calls } = serve({ status: 200, body: EMPTY_THREAD }, { pending: true })

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    submitForm(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.submit.disabled).toBe(true)
    })

    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(1)
  })

  it('disables the button and says what it is doing while the post is in flight', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { pending: true })

    const harness = await mount()
    compose(harness)
    submitForm(harness)

    await vi.waitFor(() => {
      expect(harness.submit.disabled).toBe(true)
    })
    expect(harness.submit.textContent).toBe('Posting…')
  })

  it('gives the button back after a refusal, so the reader can fix and retry', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { status: 400, body: 'Your comment is empty.' })

    const harness = await mount()
    compose(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.error.hidden).toBe(false)
    })

    // The `finally` is what restores this. Without it a single 400 ends the
    // conversation for that reader with no way back.
    expect(harness.submit.disabled).toBe(false)
    expect(harness.submit.textContent).toBe('Post comment')
  })
})

describe('replying to a comment', () => {
  async function mountWithComments(): Promise<Harness> {
    serve(
      {
        status: 200,
        body: threadHtml(
          commentHtml({ id: 1, author: 'Ada' }),
          commentHtml({ id: 2, author: 'Grace' }),
        ),
      },
      { status: 202, body: commentHtml({ id: 10, author: 'Reader' }) },
    )
    return mount()
  }

  function replyButtonOn(harness: Harness, id: number): HTMLButtonElement {
    return must<HTMLButtonElement>(
      must(harness.thread, `#charcha-comment-${id}`),
      '.charcha-reply-button',
    )
  }

  it('moves focus into the composer, not just the composer to the comment', async () => {
    const harness = await mountWithComments()

    replyButtonOn(harness, 2).click()

    // A keyboard reader who pressed Reply is otherwise left at the button while the
    // form they asked for is somewhere further down the page.
    expect(document.activeElement).toBe(harness.body)
  })

  it('mounts the one composer beneath the comment being answered', async () => {
    const harness = await mountWithComments()

    replyButtonOn(harness, 2).click()

    expect(must(harness.thread, '#charcha-comment-2').contains(harness.form)).toBe(true)
    expect(harness.form.classList.contains(REPLYING_CLASS)).toBe(true)
  })

  it('keeps what the reader had already typed when the composer moves', async () => {
    const harness = await mountWithComments()
    harness.body.value = 'Half a thought'

    replyButtonOn(harness, 1).click()

    // Moving the live element rather than building a second one is the design; a
    // rebuild would silently discard this.
    expect(harness.body.value).toBe('Half a thought')
  })

  it('names the author as text, so a name that looks like markup stays a name', async () => {
    // The other end of the same guard as the write error, and the one with teeth:
    // this string is read back out of the DOM with `textContent`, so the Worker's
    // escaping is already undone by the time it gets here. `&lt;img&gt;` on the
    // wire is `<img …>` in hand — written with `innerHTML` it becomes an element
    // that loads a URL of the attacker's choosing from the reader's browser.
    serve({
      status: 200,
      body: threadHtml(commentHtml({ id: 1, author: '&lt;img src=x onerror=alert(1)&gt;' })),
    })

    const harness = await mount()
    replyButtonOn(harness, 1).click()

    const label = must<HTMLElement>(harness.form, '.charcha-reply-to')
    expect(label.textContent).toBe('Replying to <img src=x onerror=alert(1)>')
    expect(label.querySelector('img')).toBeNull()
    expect(label.childElementCount).toBe(0)
  })

  it('sends the reply with the parent it was written under', async () => {
    const { calls } = serve(
      { status: 200, body: threadHtml(commentHtml({ id: 2, author: 'Grace' })) },
      { status: 202, body: commentHtml({ id: 10, author: 'Reader' }) },
    )

    const harness = await mount()
    replyButtonOn(harness, 2).click()
    compose(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    })

    const posted: unknown = JSON.parse(calls[1]?.body ?? '{}')
    expect((posted as { parentId?: number }).parentId).toBe(2)
  })

  it('nests the reply under its parent and sends the composer home', async () => {
    const harness = await mountWithComments()
    replyButtonOn(harness, 2).click()
    compose(harness)
    submitForm(harness)
    await vi.waitFor(() => {
      expect(harness.thread.querySelector('#charcha-comment-10')).not.toBeNull()
    })

    const parent = must<HTMLElement>(harness.thread, '#charcha-comment-2')
    expect(
      must(parent, ':scope > .charcha-replies').contains(
        must(harness.thread, '#charcha-comment-10'),
      ),
    ).toBe(true)
    // The composer is one element. Left mounted under the comment it would be
    // answering a comment the reader has finished answering.
    expect(parent.contains(harness.form)).toBe(false)
    expect(harness.form.classList.contains(REPLYING_CLASS)).toBe(false)
  })

  it('returns focus to the Reply button when the reply is cancelled', async () => {
    const harness = await mountWithComments()
    const button = replyButtonOn(harness, 1)
    button.click()

    must<HTMLButtonElement>(harness.form, '.charcha-cancel-reply').click()

    expect(harness.form.classList.contains(REPLYING_CLASS)).toBe(false)
    expect(document.activeElement).toBe(button)
    expect(harness.form.querySelector('.charcha-reply-header')).toBeNull()
  })
})
