// The only file in the embed that touches the DOM. Designed on issues #5, #6, #59.
//
// Everything with a decision in it lives in the pure modules beside this one and is
// tested in workerd; what is left here is wiring, and it is verified by driving the
// real widget in a real browser against the real endpoints (card rule 3).
//
// Two rules hold this file together:
//
//  1. **`innerHTML` is only ever given a string this project wrote.** The comment
//     HTML comes from the Worker's renderer, which escapes (src/render/) — that is
//     the HTML-not-JSON design from #1, and it is the reason the embed needs no
//     Markdown parser and fits the budget. Everything a reader typed that reaches
//     this file — an author's name, a server message — is written with
//     `textContent`. There is no second rendering path here and there must not be.
//  2. **Every `fetch` owes the reader a visible failure.** A promise whose rejection
//     only reaches the console is a spinner that never stops, and CLAUDE.md counts
//     that as an unreported failure rather than as a loading state.

import { messageForWriteFailure, readUrl, submitUrl, submissionBody } from './api'
import type { EmbedConfig, StylesMode } from './config'
import {
  REPLYING_CLASS,
  composerMarkup,
  fieldIds,
  pendingBadgeMarkup,
  replyButtonMarkup,
  replyHeaderMarkup,
  retryMarkup,
  widgetMarkup,
} from './markup'
import { stylesheet } from './styles'
import { TOOLBAR_ITEMS, applyWrap } from './toolbar'

const LOADING = 'Loading comments…'
const READ_FAILED = 'Comments could not be loaded.'
const POSTED_PENDING = 'Thanks — your comment is awaiting review. Only you can see it here.'
const POSTED_PUBLISHED = 'Thanks — your comment is published.'
const POSTING = 'Posting…'
const POST = 'Post comment'

/**
 * The stylesheet is written into the document once per mode, not once per widget.
 *
 * A `<style>` element rather than a linked file: a second request would cost the
 * site a Worker invocation on the read path's budget for something that is under two
 * kilobytes, and a cross-origin stylesheet is the one thing a host CSP is most
 * likely to refuse. A host whose CSP blocks inline styles gets no CSS — which is
 * `bare` mode, and is a documented, survivable outcome rather than a broken widget.
 */
function installStyles(mode: StylesMode): void {
  const css = stylesheet(mode)
  if (css === '') return
  const marker = `charcha-${mode}`
  if (document.querySelector(`style[data-charcha="${marker}"]`) !== null) return

  const element = document.createElement('style')
  element.setAttribute('data-charcha', marker)
  element.textContent = css
  document.head.appendChild(element)
}

/** Builds one element out of markup this project wrote. Never reader input. */
function fragment(html: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content
}

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (found === null) throw new Error(`charcha: ${selector} is missing from its own markup`)
  return found
}

interface Widget {
  status: HTMLElement
  thread: HTMLElement
  form: HTMLFormElement
  body: HTMLTextAreaElement
  name: HTMLInputElement
  email: HTMLInputElement
  error: HTMLElement
  submit: HTMLButtonElement
  /** Where the composer lives when it is not mounted under a comment. */
  home: HTMLElement
  config: EmbedConfig
  /** The comment being replied to, or null. One level only — the DB forbids more. */
  parentId: number | null
  /**
   * When the form became available, from `performance.now()`. The submission sends
   * the elapsed duration and never a timestamp, so no clock has to agree with the
   * server's (#8, layer 2).
   */
  openedAt: number
  submitting: boolean
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

function showStatus(widget: Widget, text: string, withRetry: boolean): void {
  widget.status.textContent = text
  if (withRetry) {
    widget.status.appendChild(fragment(retryMarkup()))
    requireElement<HTMLButtonElement>(widget.status, '.charcha-retry').addEventListener(
      'click',
      () => {
        void load(widget)
      },
    )
  }
}

/**
 * Adds the Reply affordance to each root comment.
 *
 * Done here rather than in the renderer because replying is an embed capability: the
 * v1.1 server-rendering paths and the build-time API emit the same comment HTML for
 * pages that have no JavaScript at all, and a Reply button there would do nothing.
 *
 * Roots only. The schema stops at two levels (migrations/0001_initial.sql) and the
 * renderer drops anything deeper, so a Reply on a reply would offer the reader
 * something the server will refuse.
 *
 * It goes directly beneath the comment's own body and *above* that comment's
 * replies. Found by looking at a render: appended to the end of the element, it
 * lands under the last reply and reads as belonging to the reply rather than to the
 * comment it actually answers — which is the one thing a reader must not be wrong
 * about before they start typing.
 */
function addReplyButtons(widget: Widget): void {
  const list = widget.thread.querySelector('.charcha-comments')
  if (list === null) return
  for (const comment of Array.from(list.children)) {
    if (!comment.classList.contains('charcha-comment')) continue
    if (comment.querySelector(':scope > .charcha-comment-actions') !== null) continue
    const replies = comment.querySelector(':scope > .charcha-replies')
    const actions = fragment(replyButtonMarkup())
    if (replies === null) comment.appendChild(actions)
    else comment.insertBefore(actions, replies)
  }
}

/**
 * Loads the page's comments.
 *
 * The three outcomes are deliberately distinguishable, because two of them look
 * identical if they are not built apart: a page with nothing on it, and a page whose
 * comments could not be fetched. The empty state is the Worker's own markup
 * (`charcha-empty`); the failure is this function's, and it carries a retry.
 *
 * `truncated` is not decided here. The Worker already knows whether the page holds
 * more comments than the read returned and says so in the HTML it sends
 * (`charcha-truncated`, #27/#59) — the embed inferring it from a row count would be
 * a second, weaker copy of a rule the read already owns, and one that cannot tell a
 * page that exactly fills the cap from one that overflows it.
 */
async function load(widget: Widget): Promise<void> {
  // The composer is a live element that gets *moved* into the thread while the
  // reader is replying, and both branches below replace the thread's contents. Send
  // it home first, or a read that runs while a reply is open detaches the one form
  // this widget has and every later reference to it points at nothing. No path
  // reaches that today — the retry only exists after a read has already failed — but
  // it is one added refresh button away from being a live bug, and the cost of not
  // having it is the whole widget.
  endReply(widget)

  widget.thread.setAttribute('aria-busy', 'true')
  showStatus(widget, LOADING, false)

  try {
    const response = await fetch(readUrl(widget.config.api, location.href, widget.config.thread), {
      credentials: 'omit',
    })
    if (!response.ok) throw new Error(`read failed: ${response.status}`)

    // The Worker's own rendered HTML, escaped by src/render/. This is the whole of
    // the read path and most of how the 10 KB budget is met (#1).
    widget.thread.innerHTML = await response.text()
    addReplyButtons(widget)
    widget.status.textContent = ''
  } catch (error) {
    // The catch owns a visible state. Without it the reader is left looking at
    // "Loading comments…" forever, which is indistinguishable from a slow network
    // and reports nothing to anybody.
    console.error('charcha: could not load comments', error)
    widget.thread.innerHTML = ''
    showStatus(widget, READ_FAILED, true)
  } finally {
    widget.thread.removeAttribute('aria-busy')
  }
}

/* -------------------------------------------------------------------------- */
/* The composer                                                                */
/* -------------------------------------------------------------------------- */

function showWriteError(widget: Widget, message: string): void {
  // textContent, never innerHTML: this string came off the network.
  widget.error.textContent = message
  widget.error.hidden = false
  widget.error.scrollIntoView({ block: 'nearest' })
}

function clearWriteError(widget: Widget): void {
  widget.error.textContent = ''
  widget.error.hidden = true
}

/**
 * Puts the reader's own comment on the page immediately, with a badge saying it is
 * not published yet (owner decision, #5).
 *
 * It renders unmoderated content to exactly one screen — the screen of the person
 * who wrote it — and never to anybody else, because the server still holds it in the
 * queue. Honest, because of the badge; frictionless, because their words land where
 * they wrote them instead of vanishing behind a promise.
 *
 * The markup inserted here is the Worker's answer to the POST: the same renderer,
 * the same escaping, the same output the page will show once it is approved.
 */
function insertOwnComment(widget: Widget, html: string, pending: boolean): void {
  const comment = fragment(html).querySelector<HTMLElement>('.charcha-comment')
  if (comment === null) return

  if (pending) {
    const header = comment.querySelector('.charcha-comment-header') ?? comment
    header.appendChild(fragment(pendingBadgeMarkup()))
  }

  if (widget.parentId !== null) {
    const parent = widget.thread.querySelector(`#charcha-comment-${widget.parentId}`)
    if (parent !== null) {
      let replies = parent.querySelector(':scope > .charcha-replies')
      if (replies === null) {
        replies = document.createElement('ol')
        replies.className = 'charcha-replies'
        // Directly after the Reply button, matching addReplyButtons — and never
        // simply appended, because the composer is itself mounted inside this
        // element right now and the first reply would land underneath it.
        const actions = parent.querySelector(':scope > .charcha-comment-actions')
        if (actions === null) parent.appendChild(replies)
        else actions.after(replies)
      }
      replies.appendChild(comment)
    }
  } else {
    let list = widget.thread.querySelector('.charcha-comments')
    if (list === null) {
      // The page was empty. Replace the invitation rather than leaving it above the
      // first comment, where it would be telling the reader to be the first.
      widget.thread.innerHTML = '<ol class="charcha-comments"></ol>'
      list = widget.thread.firstElementChild
    }
    list?.appendChild(comment)
    comment.appendChild(fragment(replyButtonMarkup()))
  }

  // Focus follows the reader's own action, so a keyboard or screen-reader user is
  // taken to what just happened rather than left at a button that emptied itself.
  comment.tabIndex = -1
  comment.focus()
}

/**
 * The Turnstile token, if the owner put a Turnstile widget on the page.
 *
 * Turnstile is optional configuration: with no secret key on the Worker the layer
 * abstains entirely and makes no network call (#8), so the embed has to work with no
 * widget present at all. When the owner has placed one, Cloudflare's own script
 * injects an input under this exact name — the name is theirs, not ours, which is
 * why the form can be serialised without renaming anything.
 */
function readTurnstileToken(): string | null {
  const input = document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')
  return input === null || input.value === '' ? null : input.value
}

async function submit(widget: Widget): Promise<void> {
  // One in flight at a time. Without this, a double click or an impatient Enter
  // posts the comment twice and the moderator gets two of them.
  if (widget.submitting) return
  widget.submitting = true
  widget.submit.disabled = true
  widget.submit.textContent = POSTING
  clearWriteError(widget)

  try {
    const response = await fetch(submitUrl(widget.config.api), {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        submissionBody({
          body: widget.body.value,
          authorName: widget.name.value,
          authorEmail: widget.email.value,
          parentId: widget.parentId,
          pageUrl: location.href,
          thread: widget.config.thread,
          title: document.title,
          elapsedMs: performance.now() - widget.openedAt,
          turnstileToken: readTurnstileToken(),
        }),
      ),
    })

    // Branch on the status, never on the body. src/submit/route.ts maps every
    // outcome onto one — 202 is held for review, which is a success and not a
    // failure — so the embed never has to guess what happened from prose.
    if (response.status === 201 || response.status === 202) {
      const pending = response.status === 202
      insertOwnComment(widget, await response.text(), pending)
      // The body clears; the name and the email do not, so a reader posting twice
      // does not type them twice. Nothing is written anywhere — close the tab and
      // it is gone (card rule 8).
      widget.body.value = ''
      endReply(widget)
      showStatus(widget, pending ? POSTED_PENDING : POSTED_PUBLISHED, false)
      return
    }

    showWriteError(widget, messageForWriteFailure(response.status, await response.text()))
  } catch (error) {
    // A network failure, a blocked origin (#57), a Worker that is not there. The
    // reader is told; the console gets the detail the site owner needs.
    console.error('charcha: could not post comment', error)
    showWriteError(widget, messageForWriteFailure(0, ''))
  } finally {
    widget.submitting = false
    widget.submit.disabled = false
    widget.submit.textContent = POST
  }
}

/* -------------------------------------------------------------------------- */
/* Replying                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Moves the one composer beneath the comment being replied to.
 *
 * Moving the live element rather than building a second one keeps whatever the
 * reader had already typed, keeps every listener attached, and keeps the embed to
 * one form — which is most of why an inline reply composer fits the budget at all.
 */
function startReply(widget: Widget, comment: HTMLElement): void {
  const id = Number(comment.id.replace('charcha-comment-', ''))
  if (!Number.isInteger(id) || id <= 0) return

  endReply(widget)
  widget.parentId = id

  const header = fragment(replyHeaderMarkup())
  const label = requireElement<HTMLElement>(header, '.charcha-reply-to')
  const author = comment.querySelector('.charcha-comment-author')?.textContent ?? ''
  // textContent: this is another reader's name, rendered by the Worker and read back
  // out of the DOM. It never goes near innerHTML.
  label.textContent = `Replying to ${author}`
  requireElement<HTMLButtonElement>(header, '.charcha-cancel-reply').addEventListener(
    'click',
    () => {
      endReply(widget)
      comment.querySelector<HTMLButtonElement>(':scope > .charcha-comment-actions button')?.focus()
    },
  )

  widget.form.classList.add(REPLYING_CLASS)
  widget.form.insertBefore(header, widget.form.firstChild)
  comment.appendChild(widget.form)
  // Focus moves into the mounted composer, or a keyboard user is left at a Reply
  // button while the form they asked for is somewhere further down the page.
  widget.body.focus()
}

function endReply(widget: Widget): void {
  if (widget.parentId === null) return
  widget.parentId = null
  widget.form.classList.remove(REPLYING_CLASS)
  widget.form.querySelector('.charcha-reply-header')?.remove()
  widget.home.appendChild(widget.form)
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Arrow-key movement across the toolbar, with one stop in the tab order.
 *
 * `role="toolbar"` promises this to a screen-reader user, so the alternative to
 * implementing it is not "a simpler toolbar" — it is a toolbar that lies about how
 * it is operated. Six buttons would otherwise sit between the reader and the field
 * they are trying to reach.
 */
function wireToolbar(widget: Widget): void {
  const toolbar = requireElement<HTMLElement>(widget.form, '.charcha-toolbar')
  const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('.charcha-toolbar-button'))
  buttons.forEach((button, index) => {
    button.tabIndex = index === 0 ? 0 : -1
  })

  toolbar.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    const current = buttons.findIndex((button) => button === document.activeElement)
    if (current === -1) return
    event.preventDefault()
    const next = buttons[(current + step + buttons.length) % buttons.length]
    for (const button of buttons) button.tabIndex = button === next ? 0 : -1
    next?.focus()
  })

  toolbar.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>('[data-wrap]')
    if (button === null || button === undefined) return
    const item = TOOLBAR_ITEMS.find((candidate) => candidate.name === button.dataset['wrap'])
    if (item === undefined) return

    const result = applyWrap(
      widget.body.value,
      widget.body.selectionStart,
      widget.body.selectionEnd,
      item.wrap,
    )
    widget.body.value = result.value
    // Focus and selection are restored together: leaving the caret where the browser
    // put it drops the reader into the middle of syntax they did not type.
    widget.body.focus()
    widget.body.setSelectionRange(result.start, result.end)
  })
}

function wire(widget: Widget): void {
  wireToolbar(widget)

  widget.form.addEventListener('submit', (event) => {
    // The floor this replaces is a native POST, which this deployment's endpoint
    // cannot accept — it reads JSON. See the README and issue on the no-JavaScript
    // path; preventing the default here is what stops a form-encoded body reaching
    // an endpoint that would answer 400 to it.
    event.preventDefault()
    void submit(widget)
  })

  widget.thread.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest('.charcha-reply-button')
    if (button === null || button === undefined) return
    const comment = button.closest<HTMLElement>('.charcha-comment')
    if (comment !== null) startReply(widget, comment)
  })
}

/**
 * Builds one widget into one mount element.
 *
 * The mount's own content is replaced, so a site owner may leave a message inside
 * `<div id="charcha">` for readers whose browser never runs this script — it is what
 * they see until the widget takes over.
 */
export function mountWidget(element: HTMLElement, config: EmbedConfig, index: number): void {
  installStyles(config.styles)

  const prefix = `charcha-${index}`
  element.innerHTML = ''
  element.appendChild(fragment(widgetMarkup(prefix)))

  const root = requireElement<HTMLElement>(element, '.charcha-root')
  root.appendChild(fragment(composerMarkup(prefix)))

  const id = fieldIds(prefix)
  const widget: Widget = {
    status: requireElement<HTMLElement>(root, '.charcha-status'),
    thread: requireElement<HTMLElement>(root, '.charcha-thread'),
    form: requireElement<HTMLFormElement>(root, '.charcha-form'),
    body: requireElement<HTMLTextAreaElement>(root, `#${id.body}`),
    name: requireElement<HTMLInputElement>(root, `#${id.name}`),
    email: requireElement<HTMLInputElement>(root, `#${id.email}`),
    error: requireElement<HTMLElement>(root, `#${id.error}`),
    submit: requireElement<HTMLButtonElement>(root, '.charcha-submit'),
    home: root,
    config,
    parentId: null,
    openedAt: performance.now(),
    submitting: false,
  }

  wire(widget)
  void load(widget)
}

/**
 * The message a site owner sees when the widget cannot tell which deployment to
 * talk to.
 *
 * On the page rather than only in the console, because a widget that renders nothing
 * looks exactly like a widget that has not loaded yet, and this failure happens on
 * every page or on none — the first time they paste the snippet.
 */
export function mountConfigError(element: HTMLElement, message: string): void {
  element.textContent = message
}
