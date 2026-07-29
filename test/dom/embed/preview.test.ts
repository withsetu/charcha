// The composer's Write/Preview tabs, driven the way a reader drives them (#78).
//
// The server half of this issue has been live and unreachable since it merged: no
// call site existed. These tests are the call site's contract, and three of them are
// kill-shotted in the PR — the guard is disabled, the test is confirmed red, the
// guard is restored (card rule 6).
//
// Two properties carry the security weight and neither is visible at a call site:
//
//  1. **The rendered preview reaches the DOM through one path and only on a 200.**
//     It is `innerHTML` for the same reason the read path is — the string came from
//     src/render/, which escapes (#1) — and that reasoning does not extend one inch
//     past a 200. An error body is not rendered comment HTML, and the base address
//     is owner configuration that can point at anything at all.
//  2. **Everything else the network says arrives as text.** The failure message is
//     the mirror of the write error mount.test.ts already pins: `textContent` and
//     `innerHTML` look interchangeable at a call site, and only one of them is safe.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmbedConfig } from '../../../src/embed/config'
import { fieldIds } from '../../../src/embed/markup'
import { mountWidget } from '../../../src/embed/mount'
import type { RenderableComment } from '../../../src/render'
import { COMMENT_CLASS_NAMES, renderComments, renderMarkdown } from '../../../src/render'

const API = 'https://comments.example.com'
const CONFIG: EmbedConfig = { api: API, thread: null, styles: 'inherit', turnstileSitekey: null }

/** The whole of the preview contract's happy path (src/preview/route.ts). */
const PREVIEW_URL = `${API}/comments/preview`

const EMPTY_THREAD = renderComments([])

/* -------------------------------------------------------------------------- */
/* A network the test owns                                                     */
/* -------------------------------------------------------------------------- */

type Outcome = { status: number; body: string } | { networkError: string } | { pending: true }

interface Call {
  url: string
  method: string
  body: string | null
  headers: unknown
  credentials: unknown
}

/**
 * Answers the widget's fetches in order and records what it asked for.
 *
 * Headers are recorded as well as the body, because "no header at all" is load
 * bearing on this path: a `fetch` given a string body and no headers sends
 * `text/plain`, which is a CORS-simple request no browser preflights — one billable
 * Worker request per preview instead of two (#78).
 */
function serve(...outcomes: readonly Outcome[]): { calls: Call[]; settle: (body: string) => void } {
  const calls: Call[] = []
  let next = 0
  let release: ((body: string) => void) | null = null

  vi.stubGlobal(
    'fetch',
    vi.fn(
      (
        input: unknown,
        init?: { method?: string; body?: unknown; headers?: unknown; credentials?: unknown },
      ) => {
        calls.push({
          url: String(input),
          method: init?.method ?? 'GET',
          body: typeof init?.body === 'string' ? init.body : null,
          headers: init?.headers,
          credentials: init?.credentials,
        })

        const outcome = outcomes[next]
        next += 1
        if (outcome === undefined) {
          return Promise.reject(new Error(`unexpected request ${calls.length}: ${String(input)}`))
        }
        if ('pending' in outcome) {
          return new Promise<Response>((resolve) => {
            release = (body: string) => {
              resolve(new Response(body, { status: 200 }))
            }
          })
        }
        if ('networkError' in outcome) return Promise.reject(new Error(outcome.networkError))
        return Promise.resolve(new Response(outcome.body, { status: outcome.status }))
      },
    ),
  )

  return {
    calls,
    settle: (body: string) => {
      if (release === null) throw new Error('nothing is pending')
      release(body)
    },
  }
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
  root: HTMLElement
  thread: HTMLElement
  form: HTMLFormElement
  body: HTMLTextAreaElement
  writeTab: HTMLButtonElement
  previewTab: HTMLButtonElement
  writePanel: HTMLElement
  preview: HTMLElement
  submit: HTMLButtonElement
}

async function mount(): Promise<Harness> {
  const host = document.createElement('div')
  host.id = 'charcha'
  document.body.appendChild(host)

  mountWidget(host, CONFIG, 1)

  const root = must<HTMLElement>(host, '.charcha-root')
  const id = fieldIds('charcha-1')
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
  const harness: Harness = {
    root,
    thread: must<HTMLElement>(root, '.charcha-thread'),
    form: must<HTMLFormElement>(root, '.charcha-form'),
    body: must<HTMLTextAreaElement>(root, `#${id.body}`),
    writeTab: tabs[0] as HTMLButtonElement,
    previewTab: tabs[1] as HTMLButtonElement,
    writePanel: must<HTMLElement>(root, '.charcha-write'),
    preview: must<HTMLElement>(root, '.charcha-preview'),
    submit: must<HTMLButtonElement>(root, '.charcha-submit'),
  }

  await vi.waitFor(() => {
    expect(harness.thread.hasAttribute('aria-busy')).toBe(false)
  })
  return harness
}

/**
 * Lets everything pending run to completion.
 *
 * Deliberately generous. A fixed two `await Promise.resolve()` happens to be exactly
 * the number `showPreview` needs today, which makes any test that relies on it pass
 * for the wrong reason the moment one more `await` is added to the function under
 * test — a stale-response test that can no longer see the stale response is a test
 * that passes with its guard removed.
 */
async function settleAll(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

/** What the reader sees rendered, once the preview has landed. */
async function previewed(harness: Harness): Promise<HTMLElement> {
  await vi.waitFor(() => {
    expect(harness.preview.querySelector('.charcha-comment-body')).not.toBeNull()
  })
  return must<HTMLElement>(harness.preview, '.charcha-comment-body')
}

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  document.body.innerHTML = ''
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/* -------------------------------------------------------------------------- */

describe('asking the Worker for a preview', () => {
  it('sends the draft to the preview path, as a body no browser will preflight', async () => {
    const { calls } = serve({ status: 200, body: EMPTY_THREAD }, { status: 200, body: '<p>hi</p>' })

    const harness = await mount()
    harness.body.value = '**hi**'
    harness.previewTab.click()
    await previewed(harness)

    const request = calls[1]
    expect(request?.url).toBe(PREVIEW_URL)
    expect(request?.method).toBe('POST')
    // The raw draft, not a JSON envelope: the endpoint has one input and it is a
    // string, so an envelope would put JSON.parse on the untrusted path for nothing.
    expect(request?.body).toBe('**hi**')
    // No header at all. Setting one — even `content-type: text/plain` — is what
    // makes the request non-simple and costs a preflight.
    expect(request?.headers).toBeUndefined()
    // Card rule 8, at the one place the embed could break it without meaning to.
    // The default is `same-origin`, so a deployment on the site's own domain would
    // send the reader's cookies to the Worker on every keystroke-ful of draft they
    // previewed. Charcha never wants them and must never ask for them.
    expect(request?.credentials).toBe('omit')
  })

  it('shows the published output, in the renderer’s own wrapper', async () => {
    // Rendered by the Worker's renderer, which is the whole point: the preview is
    // the published output rather than an approximation of it, because there is no
    // second implementation anywhere in this project (#1, #5).
    const draft = '**bold** and `code`'
    serve({ status: 200, body: EMPTY_THREAD }, { status: 200, body: renderMarkdown(draft) })

    const harness = await mount()
    harness.body.value = draft
    harness.previewTab.click()
    const body = await previewed(harness)

    expect(body.querySelector('strong')?.textContent).toBe('bold')
    expect(body.querySelector('code')?.textContent).toBe('code')
    // The renderer's own class, so the preview inherits exactly the styling the
    // published comment gets. Read from the renderer rather than written out, so a
    // rename there fails here instead of silently unstyling the preview.
    expect(COMMENT_CLASS_NAMES).toContain('charcha-comment-body')
  })

  it('shows what the sanitiser stripped, because it is the same sanitiser', async () => {
    const draft = 'hello <img src=x onerror=alert(1)>'
    serve({ status: 200, body: EMPTY_THREAD }, { status: 200, body: renderMarkdown(draft) })

    const harness = await mount()
    harness.body.value = draft
    harness.previewTab.click()
    const body = await previewed(harness)

    // The escaping is src/render/'s and it happened before this string was sent.
    // The reader sees the angle brackets they typed, exactly as the published
    // comment will show them — and no element is created.
    expect(body.querySelector('img')).toBeNull()
    expect(body.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('asks for nothing at all when there is nothing to preview', async () => {
    // The guard: an empty draft is a 400 the reader did not need to wait for, and a
    // request nobody had to pay for.
    const { calls } = serve({ status: 200, body: EMPTY_THREAD })

    const harness = await mount()
    harness.body.value = '   \n  '
    harness.previewTab.click()

    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
    expect(harness.preview.textContent).not.toBe('')
    // Distinguishable from a failure: nothing went wrong, there is just nothing
    // written yet.
    expect(harness.preview.querySelector('.charcha-retry')).toBeNull()
  })

  it('does not ask twice for a draft it is already waiting on', async () => {
    // The dedupe has to cover the in-flight window, not only the shown one. A
    // reader who presses Preview twice, or goes Preview → Write → Preview before
    // the first answer arrives, is one reader asking one question.
    const { calls } = serve({ status: 200, body: EMPTY_THREAD }, { pending: true })

    const harness = await mount()
    harness.body.value = 'hi'
    harness.previewTab.click()
    harness.previewTab.click()
    harness.writeTab.click()
    harness.previewTab.click()
    await settleAll()

    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('drops an answer to a draft the reader has since deleted', async () => {
    // The empty branch returns early, so it is the one path that could skip
    // invalidating what is in flight. If it does, the reader empties the box, is
    // correctly told there is nothing to preview, and is then shown a rendering of
    // the very text they just deleted.
    const { settle } = serve({ status: 200, body: EMPTY_THREAD }, { pending: true })

    const harness = await mount()
    harness.body.value = 'delete me'
    harness.previewTab.click()

    harness.writeTab.click()
    harness.body.value = ''
    harness.previewTab.click()

    settle('<p>delete me</p>')
    await settleAll()

    expect(harness.preview.textContent).not.toContain('delete me')
    expect(harness.preview.textContent).toContain('Nothing to preview')
    expect(harness.preview.querySelector('.charcha-comment-body')).toBeNull()
    // And it does not sit there claiming to be working on something.
    expect(harness.preview.hasAttribute('aria-busy')).toBe(false)
  })

  it('does not ask twice for a draft it is already showing', async () => {
    const { calls } = serve({ status: 200, body: EMPTY_THREAD }, { status: 200, body: '<p>hi</p>' })

    const harness = await mount()
    harness.body.value = 'hi'
    harness.previewTab.click()
    await previewed(harness)
    harness.writeTab.click()
    harness.previewTab.click()

    // Every page view is one billable Worker request against 100,000 a day; a
    // reader flicking between the tabs must not be spending them.
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('asks again once the reader has changed what they wrote', async () => {
    const { calls } = serve(
      { status: 200, body: EMPTY_THREAD },
      { status: 200, body: '<p>one</p>' },
      { status: 200, body: '<p>two</p>' },
    )

    const harness = await mount()
    harness.body.value = 'one'
    harness.previewTab.click()
    await previewed(harness)

    harness.writeTab.click()
    harness.body.value = 'two'
    harness.previewTab.click()
    await vi.waitFor(() => {
      expect(harness.preview.textContent).toContain('two')
    })

    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2)
  })

  it('says it is working, and stops saying it', async () => {
    const { calls, settle } = serve({ status: 200, body: EMPTY_THREAD }, { pending: true })

    const harness = await mount()
    harness.body.value = 'hi'
    harness.previewTab.click()

    // A blank panel is indistinguishable from a comment that renders to nothing.
    expect(harness.preview.textContent).not.toBe('')
    expect(harness.preview.getAttribute('aria-busy')).toBe('true')
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)

    settle('<p>hi</p>')
    await previewed(harness)
    expect(harness.preview.hasAttribute('aria-busy')).toBe(false)
  })
})

describe('when the preview fails', () => {
  it('says so on the page, offers a retry, and keeps the draft', async () => {
    serve(
      { status: 200, body: EMPTY_THREAD },
      { networkError: 'connection refused' },
      { status: 200, body: '<p>hi</p>' },
    )

    const harness = await mount()
    harness.body.value = 'hi'
    harness.previewTab.click()
    await vi.waitFor(() => {
      expect(harness.preview.querySelector('.charcha-retry')).not.toBeNull()
    })

    // Never a panel that sits on "Rendering…" forever — CLAUDE.md counts that as an
    // unreported failure rather than as a loading state.
    expect(harness.preview.hasAttribute('aria-busy')).toBe(false)
    // The reader's words are untouched. A preview is a read of the draft; a failed
    // read of it must not cost them the draft.
    expect(harness.body.value).toBe('hi')
    expect(consoleError).toHaveBeenCalledWith(
      'charcha: could not render the preview',
      expect.anything(),
    )

    must<HTMLButtonElement>(harness.preview, '.charcha-retry').click()
    const body = await previewed(harness)
    expect(body.textContent).toBe('hi')
  })

  it('leaves the reader able to post, because preview was never a prerequisite', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { networkError: 'connection refused' })

    const harness = await mount()
    harness.body.value = 'hi'
    harness.previewTab.click()
    await vi.waitFor(() => {
      expect(harness.preview.querySelector('.charcha-retry')).not.toBeNull()
    })

    expect(harness.submit.disabled).toBe(false)
    expect(harness.preview.textContent?.toLowerCase()).toContain('post')
  })

  it('inserts the server’s refusal as text, never as markup', async () => {
    // The security test on this file, and the one a refactor would flip. No literal
    // angle brackets, so it survives the src/embed/api.ts filter and actually
    // reaches the DOM — which makes this an assertion about *this* guard rather
    // than the one upstream of it. Entities are the tell: written as text they stay
    // written out, and `innerHTML` would decode them.
    const refusal = 'Rejected: your draft contains &lt;script&gt; and 5 &amp; 6 links.'
    serve({ status: 200, body: EMPTY_THREAD }, { status: 400, body: refusal })

    const harness = await mount()
    harness.body.value = 'hi'
    harness.previewTab.click()
    await vi.waitFor(() => {
      expect(harness.preview.textContent).toContain('Rejected')
    })

    expect(harness.preview.textContent).toContain(refusal)
    expect(harness.preview.querySelector('.charcha-comment-body')).toBeNull()
  })

  it('never renders a body that did not come back as a 200', async () => {
    // The other half of the same guard. `innerHTML` is safe here only because the
    // string came from src/render/, and a 403 body did not: it is a sentence, or a
    // proxy's own error page, or whatever an endpoint that is not this Worker chose
    // to send. Rendering it would be a second rendering path with no escaping in it.
    serve(
      { status: 200, body: EMPTY_THREAD },
      { status: 403, body: '<img src=x onerror=alert(1)>' },
    )

    const harness = await mount()
    harness.body.value = 'hi'
    harness.previewTab.click()
    await vi.waitFor(() => {
      expect(harness.preview.textContent).not.toContain('Rendering')
    })

    expect(harness.preview.querySelector('img')).toBeNull()
    expect(harness.preview.childElementCount).toBeLessThanOrEqual(1)
    // A body full of markup is not the plain sentence the contract promises, so
    // src/embed/api.ts refuses to repeat it and the reader gets our own words.
    expect(harness.preview.textContent).not.toContain('onerror')
  })

  it('says so when a 200 carries nothing it can render', async () => {
    // The write path already learned this (#93): an endpoint that answers 2xx and
    // sends nothing showable leaves the reader looking at a blank panel that reads
    // exactly like a comment which renders to nothing. Worse here, because a blank
    // panel accepted as the answer would be *cached* against this draft, so leaving
    // the tab and coming back would never ask again.
    serve(
      { status: 200, body: EMPTY_THREAD },
      { status: 200, body: '   ' },
      { status: 200, body: '<p>second time lucky</p>' },
    )

    const harness = await mount()
    harness.body.value = 'hi'
    harness.previewTab.click()
    await vi.waitFor(() => {
      expect(harness.preview.querySelector('.charcha-retry')).not.toBeNull()
    })

    expect(harness.preview.hasAttribute('aria-busy')).toBe(false)
    expect(consoleError).toHaveBeenCalledWith(
      'charcha: the preview endpoint returned nothing renderable',
    )

    // Not cached: the same unchanged draft is asked for again.
    harness.writeTab.click()
    harness.previewTab.click()
    const body = await previewed(harness)
    expect(body.textContent).toBe('second time lucky')
  })

  it('stops saying it is working when the server refuses the draft', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { status: 400, body: 'Your comment is too long.' })

    const harness = await mount()
    harness.body.value = 'hi'
    harness.previewTab.click()
    await vi.waitFor(() => {
      expect(harness.preview.textContent).toContain('too long')
    })

    // The refusal branch returns early, so it is the one that could leave the panel
    // announcing itself as busy while displaying a finished answer.
    expect(harness.preview.hasAttribute('aria-busy')).toBe(false)
  })

  it('does not let a slow answer overwrite the one the reader is looking at', async () => {
    // Preview 1 never settles until after preview 2 has landed. Without the run
    // guard the reader ends up reading a rendering of a draft they have already
    // moved on from, with no way to tell.
    const { settle } = serve(
      { status: 200, body: EMPTY_THREAD },
      { pending: true },
      { status: 200, body: '<p>second</p>' },
    )

    const harness = await mount()
    harness.body.value = 'first'
    harness.previewTab.click()

    harness.writeTab.click()
    harness.body.value = 'second'
    harness.previewTab.click()
    await vi.waitFor(() => {
      expect(harness.preview.textContent).toContain('second')
    })

    settle('<p>first</p>')
    await settleAll()
    expect(harness.preview.textContent).toContain('second')
    expect(harness.preview.textContent).not.toContain('first')
  })
})

describe('the tabs themselves', () => {
  it('starts on Write and switches what is shown, not what the field is', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { status: 200, body: '<p>hi</p>' })

    const harness = await mount()
    expect(harness.writePanel.hidden).toBe(false)
    expect(harness.preview.hidden).toBe(true)

    harness.body.value = 'hi'
    harness.previewTab.click()

    expect(harness.writePanel.hidden).toBe(true)
    expect(harness.preview.hidden).toBe(false)
    expect(harness.previewTab.getAttribute('aria-selected')).toBe('true')
    expect(harness.writeTab.getAttribute('aria-selected')).toBe('false')
    // Roving tabindex: the tablist is one stop, not two.
    expect(harness.previewTab.tabIndex).toBe(0)
    expect(harness.writeTab.tabIndex).toBe(-1)
    // The field is still a textarea holding exactly what the reader typed. Nothing
    // was reparented, re-created, or turned into a rich-text model.
    expect(harness.body.value).toBe('hi')
  })

  it('gives the reader their text back, unchanged, when they switch back', async () => {
    serve({ status: 200, body: EMPTY_THREAD }, { status: 200, body: '<p>hi</p>' })

    const harness = await mount()
    harness.body.value = 'half a thought'
    harness.previewTab.click()
    harness.writeTab.click()

    expect(harness.body.value).toBe('half a thought')
    expect(harness.writePanel.hidden).toBe(false)
    // Focus goes back to where the reader was writing, not left on a hidden panel.
    expect(document.activeElement).toBe(harness.body)
  })

  it('moves between the tabs with the arrow keys, as role="tablist" promises', async () => {
    serve({ status: 200, body: EMPTY_THREAD })

    const harness = await mount()
    harness.writeTab.focus()
    const tablist = must<HTMLElement>(harness.form, '.charcha-tabs')
    tablist.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))

    // Focus lands on the *tab*, not inside the panel: APG is explicit that arrowing
    // along a tablist leaves the reader on the tablist. Landing in the textarea
    // would also flash the soft keyboard on a phone for a reader who was browsing.
    expect(document.activeElement).toBe(harness.previewTab)
    expect(harness.preview.hidden).toBe(false)
    expect(harness.previewTab.getAttribute('aria-selected')).toBe('true')
    expect(harness.writeTab.getAttribute('aria-selected')).toBe('false')
    expect(harness.previewTab.tabIndex).toBe(0)
    expect(harness.writeTab.tabIndex).toBe(-1)

    tablist.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(document.activeElement).toBe(harness.writeTab)
    expect(harness.writePanel.hidden).toBe(false)
    expect(harness.writeTab.getAttribute('aria-selected')).toBe('true')
    expect(harness.writeTab.tabIndex).toBe(0)
    expect(harness.previewTab.tabIndex).toBe(-1)
  })

  it('returns to Write once the comment has been posted', async () => {
    serve(
      { status: 200, body: EMPTY_THREAD },
      { status: 200, body: '<p>hi</p>' },
      { status: 201, body: renderComments([postedComment()]) },
    )

    const harness = await mount()
    harness.body.value = 'hi'
    must<HTMLInputElement>(harness.form, '.charcha-input').value = 'Reader'
    harness.previewTab.click()
    await previewed(harness)

    harness.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => {
      expect(harness.thread.querySelector('#charcha-comment-3')).not.toBeNull()
    })

    // The body is empty now, so a preview of it would be a rendering of nothing
    // sitting where the reader's comment used to be.
    expect(harness.writePanel.hidden).toBe(false)
    expect(harness.preview.hidden).toBe(true)
    expect(harness.writeTab.getAttribute('aria-selected')).toBe('true')
    // The tab order comes back with it. Left at two stops, the tablist would be
    // announcing one selected tab while offering both to Tab.
    expect(harness.writeTab.tabIndex).toBe(0)
    expect(harness.previewTab.tabIndex).toBe(-1)
  })

  it('drops a preview still in flight when the comment is posted', async () => {
    // The reader pressed Preview and then Post without waiting. The answer to the
    // preview arrives after the comment is published — into a panel nobody is
    // looking at, cached against a box that is now empty.
    const { settle } = serve(
      { status: 200, body: EMPTY_THREAD },
      { pending: true },
      { status: 201, body: renderComments([postedComment()]) },
    )

    const harness = await mount()
    harness.body.value = 'hi'
    must<HTMLInputElement>(harness.form, '.charcha-input').value = 'Reader'
    harness.previewTab.click()
    harness.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => {
      expect(harness.thread.querySelector('#charcha-comment-3')).not.toBeNull()
    })

    settle('<p>hi</p>')
    await settleAll()

    expect(harness.preview.querySelector('.charcha-comment-body')).toBeNull()
    expect(harness.preview.hasAttribute('aria-busy')).toBe(false)
  })
})

describe('previewing inside a reply', () => {
  // The composer is one live element that is *moved* under the comment being
  // replied to (#5). Everything the tabs hold is DOM state on elements inside that
  // form, so it travels — but only as long as the tabs stay inside the form, which
  // is the thing this describes and nothing else asserts.

  async function mountWithComment(...outcomes: readonly Outcome[]): Promise<Harness> {
    serve({ status: 200, body: renderComments([rootComment()]) }, ...outcomes)
    return mount()
  }

  it('keeps the whole composer, tabs included, when it becomes a reply', async () => {
    const harness = await mountWithComment({ status: 200, body: '<p>hi</p>' })

    harness.body.value = 'hi'
    harness.previewTab.click()
    await previewed(harness)

    must<HTMLButtonElement>(harness.thread, '.charcha-reply-button').click()

    const comment = must<HTMLElement>(harness.thread, '#charcha-comment-1')
    expect(comment.contains(harness.form)).toBe(true)
    // The tabs moved with the form, which is the only reason the state below is
    // still true. A tablist built outside the form would have been left behind.
    expect(comment.contains(harness.previewTab)).toBe(true)
    expect(harness.preview.hidden).toBe(false)
    expect(harness.previewTab.getAttribute('aria-selected')).toBe('true')
    expect(must(harness.preview, '.charcha-comment-body').textContent).toBe('hi')
    expect(harness.body.value).toBe('hi')
    // The reader pressed Reply and must land somewhere they can act. The textarea
    // is hidden, so the tab they are on is where focus belongs.
    expect(document.activeElement).toBe(harness.previewTab)
  })

  it('previews a reply that was written after the composer moved', async () => {
    const { calls } = serve(
      { status: 200, body: renderComments([rootComment()]) },
      { status: 200, body: '<p>a reply</p>' },
    )
    const harness = await mount()

    must<HTMLButtonElement>(harness.thread, '.charcha-reply-button').click()
    expect(document.activeElement).toBe(harness.body)

    harness.body.value = 'a reply'
    harness.previewTab.click()
    const body = await previewed(harness)

    expect(body.textContent).toBe('a reply')
    expect(calls[1]?.url).toBe(PREVIEW_URL)
    expect(calls[1]?.body).toBe('a reply')
  })
})

/* -------------------------------------------------------------------------- */

/** One fixed instant, so a rendered fixture is the same string on every run. */
const CREATED_AT = Date.UTC(2026, 6, 24, 10, 0, 0) / 1000

function rootComment(): RenderableComment {
  return {
    id: 1,
    parentId: null,
    depth: 0,
    authorName: 'Ada',
    body: 'Hello.',
    byOwner: false,
    createdAt: CREATED_AT,
  }
}

function postedComment(): RenderableComment {
  return { ...rootComment(), id: 3, authorName: 'Reader' }
}
