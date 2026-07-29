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

import {
  messageForPreviewFailure,
  messageForWriteFailure,
  previewUrl,
  readUrl,
  submitUrl,
  submissionBody,
} from './api'
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
import { TURNSTILE_ONLOAD_GLOBAL, createTurnstileGate, turnstileScriptUrl } from './turnstile'
import type { TurnstileApi, TurnstileGate } from './turnstile'

const LOADING = 'Loading comments…'
const READ_FAILED = 'Comments could not be loaded.'
const POSTED_PENDING = 'Thanks — your comment is awaiting review. Only you can see it here.'
const POSTED_PUBLISHED = 'Thanks — your comment is published.'
/**
 * The third outcome of an accepted comment: the server took it, and sent back
 * nothing this widget can put on the page (#93).
 *
 * It claims exactly what the status code proves and no more. Not a failure — a 2xx
 * means the comment was accepted, and telling the reader it did not post would be
 * the same lie pointed the other way. Not a success either, because the sentence
 * "only you can see it here" is checkable, and on a thread still reading "Be the
 * first" the reader can see that it is false.
 *
 * It offers no reload, deliberately. A 201 would survive one and a 202 would not —
 * it is in the moderation queue and invisible to an ordinary read — so an
 * instruction to go and look would send half the readers who follow it to a page
 * that appears to confirm their comment was lost.
 *
 * Enforced by test/dom/embed/post-outcomes.test.ts.
 */
const POSTED_UNSHOWN =
  'Your comment was received, but it could not be shown here. ' +
  'Your text is still in the box below — posting it again would send it twice.'
const POSTING = 'Posting…'
const POST = 'Post comment'
const PREVIEW_LOADING = 'Rendering the preview…'
/**
 * What an empty Preview tab says, and why it is not the failure sentence.
 *
 * "Nothing written yet" and "we could not render what you wrote" look identical as a
 * blank panel, and only one of them is worth a retry — the same distinction the read
 * path draws between its empty state and its error.
 */
const PREVIEW_EMPTY = 'Nothing to preview yet — write your comment in the Write tab.'

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
  /**
   * The Write/Preview tabs and the two panels they select (#78).
   *
   * All four are *inside* the form, which is not incidental: the composer is one
   * live element that gets moved beneath the comment being replied to, and anything
   * built outside it would be left behind — so previewing inside a reply would
   * quietly drive a tablist belonging to a form that is somewhere else on the page.
   * Enforced by test/dom/embed/preview.test.ts.
   */
  writeTab: HTMLButtonElement
  previewTab: HTMLButtonElement
  write: HTMLElement
  preview: HTMLElement
  /**
   * The exact draft the preview panel is currently showing a rendering of, or null
   * when it is showing anything else — an error, the empty state, nothing yet.
   *
   * It is what stops a reader flicking between the tabs from spending a Worker
   * request per flick, and null is deliberately the value after a failure so that
   * the retry has something to retry.
   */
  previewed: string | null
  /**
   * Which preview request is the current one.
   *
   * Answers arrive in whatever order the network gives them back, and the reader
   * has usually edited the draft by then. Without a run number the slow answer to
   * an old draft overwrites the fast answer to the new one, and the reader is
   * reading a rendering of something they no longer have with no way to tell.
   */
  previewRun: number
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
  /**
   * The Turnstile widget's lifecycle, or null when the owner configured no sitekey.
   *
   * Null is the common case and costs nothing: with no sitekey, Cloudflare's script
   * is never fetched and this widget behaves exactly as it did before #79.
   */
  turnstile: TurnstileGate | null
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Replaces an element's contents with one sentence, and optionally a way to try
 * again.
 *
 * `textContent` first, which is what empties it: every string that reaches here has
 * been on the network, and both call sites are places a reader is told what went
 * wrong. The retry is the read path's own button, reused rather than reinvented —
 * two failure affordances that look different would read as two different kinds of
 * failure.
 */
function message(target: HTMLElement, text: string, retry: (() => void) | null): void {
  target.textContent = text
  if (retry === null) return
  target.appendChild(fragment(retryMarkup()))
  requireElement<HTMLButtonElement>(target, '.charcha-retry').addEventListener('click', retry)
}

function showStatus(widget: Widget, text: string, withRetry: boolean): void {
  message(
    widget.status,
    text,
    withRetry
      ? () => {
          void load(widget)
        }
      : null,
  )
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
 *
 * Returns whether anything was placed. The answer is false whenever the body holds
 * no rendered comment — an empty body, whitespace, a proxy's own page, an endpoint
 * that is not a Charcha deployment at all (src/embed/api.ts) — and the caller owes
 * the reader a different sentence when it is. Bailing quietly was #93: the composer
 * emptied, the status said the comment was on the page, and the page disagreed.
 */
function insertOwnComment(
  widget: Widget,
  html: string,
  pending: boolean,
  parentId: number | null,
): boolean {
  const comment = fragment(html).querySelector<HTMLElement>('.charcha-comment')
  if (comment === null) return false

  if (pending) {
    const header = comment.querySelector('.charcha-comment-header') ?? comment
    header.appendChild(fragment(pendingBadgeMarkup()))
  }

  // The `parentId` the submission was built with, not whatever the widget's is now:
  // the reader may have opened a different reply while the post was in flight.
  if (parentId !== null) {
    const parent = widget.thread.querySelector(`#charcha-comment-${parentId}`)
    // The parent can be gone: every read replaces the thread wholesale, and the
    // snapshot this was called with is from before the POST. Placing the reply
    // anyway would append it to a fragment attached to nothing, which is invisible
    // in exactly the way an empty body is — #93 through a second door.
    if (parent === null) return false

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
  return true
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
function readTurnstileToken(form: ParentNode): string | null {
  // This widget's own form first, then the page. The document-wide search is what
  // makes the arrangement that worked before #79 keep working — an owner who placed
  // Cloudflare's widget themselves put it *outside* Charcha's form, because until
  // now there was nowhere inside it to put one. The narrower search goes first so
  // that on a page with two widgets, a Charcha-rendered input is never read by the
  // other instance: a token sent twice is `timeout-or-duplicate`, which is a reject.
  const input =
    form.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]') ??
    document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')
  return input === null || input.value === '' ? null : input.value
}

/**
 * Cloudflare's script, fetched at most once per page and only when a sitekey is set.
 *
 * It is the only third-party request Charcha ever makes from a reader's browser, so
 * it is behind the owner's own configuration and nothing loads it speculatively
 * (#79). A page with two widgets shares the one script and the one promise.
 */
let turnstileScript: Promise<TurnstileApi> | null = null

function loadedTurnstile(): TurnstileApi | null {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile ?? null
}

function loadTurnstile(): Promise<TurnstileApi> {
  if (turnstileScript !== null) return turnstileScript

  turnstileScript = new Promise<TurnstileApi>((resolve, reject) => {
    // An owner who already placed Cloudflare's own script keeps it: `render` works
    // the same whether or not the script was asked for explicit rendering, and
    // loading a second copy is how two widgets end up fighting over one page.
    const already = loadedTurnstile()
    if (already !== null) {
      resolve(already)
      return
    }

    const host = window as unknown as Record<string, unknown>
    // Both exits drop the global first, including the failure exit — otherwise the
    // likeliest ending of all, a host CSP refusing the origin, is the one that
    // leaves a name of ours on somebody else's page forever.
    const done = (api: TurnstileApi): void => {
      delete host[TURNSTILE_ONLOAD_GLOBAL]
      resolve(api)
    }
    const failed = (reason: string): void => {
      delete host[TURNSTILE_ONLOAD_GLOBAL]
      reject(new Error(reason))
    }

    // Cloudflare's documented signal for an async script: api.js calls this once it
    // is initialised. It has to exist before the script does.
    host[TURNSTILE_ONLOAD_GLOBAL] = (): void => {
      const api = loadedTurnstile()
      if (api === null) failed('onload fired but defined no turnstile')
      else done(api)
    }

    const script = document.createElement('script')
    script.src = turnstileScriptUrl(TURNSTILE_ONLOAD_GLOBAL)
    script.async = true
    script.defer = true
    // A backstop, so a build of api.js that stopped calling `onload` would cost a
    // widget rather than leave the promise pending. It must **not** settle when the
    // API is not there yet: doing so would delete the callback api.js is about to
    // invoke and fail the load for a script that was working perfectly.
    script.addEventListener('load', () => {
      const api = loadedTurnstile()
      if (api !== null) done(api)
    })
    // Fires for a network failure and for a host CSP that refuses the origin, which
    // is the likeliest way this ends on a site careful enough to have one.
    script.addEventListener('error', () => {
      failed('script blocked or unreachable')
    })
    document.head.appendChild(script)
  })

  return turnstileScript
}

/**
 * Starts the widget for one composer, if the owner configured a sitekey.
 *
 * The rejection is handled rather than logged and forgotten: a promise that only
 * reaches the console leaves the gate waiting for a token that is never coming, and
 * every submission would then sit through the full wait before posting anyway.
 */
function startTurnstile(widget: Widget, sitekey: string): TurnstileGate {
  const container = requireElement<HTMLElement>(widget.form, '.charcha-turnstile')
  const gate = createTurnstileGate({ container, sitekey })
  loadTurnstile().then(
    (api) => {
      gate.start(api)
    },
    (error: unknown) => {
      gate.giveUp(String(error))
    },
  )
  return gate
}

/**
 * The token this submission should carry, or null for none.
 *
 * **Nothing here gates anything.** When Turnstile is configured this waits, briefly,
 * for a token that is on its way — which is the whole of #79's second half, because
 * a token that arrives a moment after the reader pressed Post is a real comment
 * refused as spam. When no token can be had it posts without one and lets the server
 * decide: src/spam/turnstile.ts rejects a token-less submission when the owner set a
 * secret and abstains entirely when they did not, so a half-configured deployment
 * still takes comments rather than being bricked by the embed's own opinion. The
 * gate's half of that is enforced by test/worker/embed/turnstile.test.ts; the branch
 * below is wiring, and is covered by driving it rather than by a test.
 */
async function turnstileToken(widget: Widget): Promise<string | null> {
  // No managed widget: the owner may still have placed one themselves, which is the
  // transport-only arrangement that worked before #79 and still does.
  if (widget.turnstile === null) return readTurnstileToken(widget.form)
  return widget.turnstile.token()
}

async function submit(widget: Widget): Promise<void> {
  // One in flight at a time. Without this, a double click or an impatient Enter
  // posts the comment twice and the moderator gets two of them.
  if (widget.submitting) return
  widget.submitting = true
  widget.submit.disabled = true
  widget.submit.textContent = POSTING
  clearWriteError(widget)

  // Everything the submission is made of, read in the same tick the reader pressed
  // Post — because the token wait below is the first `await` this function has ever
  // had, and the Reply listener stays live across it. Without the snapshot, a reader
  // who clicks Reply while their own comment is in flight has `parentId` change
  // underneath it, and a root comment silently becomes a reply to someone else.
  const submission = {
    body: widget.body.value,
    authorName: widget.name.value,
    authorEmail: widget.email.value,
    parentId: widget.parentId,
    pageUrl: location.href,
    thread: widget.config.thread,
    title: document.title,
  }

  try {
    // Before the POST, not inside it: a token that is seconds from arriving is worth
    // waiting for. The elapsed duration is measured after the wait, which can only
    // make `t` larger and so can only help against layer 2's floor.
    const token = await turnstileToken(widget)

    const response = await fetch(submitUrl(widget.config.api), {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        submissionBody({
          ...submission,
          elapsedMs: performance.now() - widget.openedAt,
          turnstileToken: token,
        }),
      ),
    })

    // Branch on the status, never on the body. src/submit/route.ts maps every
    // outcome onto one — 202 is held for review, which is a success and not a
    // failure — so the embed never has to guess what happened from prose.
    if (response.status === 201 || response.status === 202) {
      const pending = response.status === 202
      const shown = insertOwnComment(widget, await response.text(), pending, submission.parentId)

      if (!shown) {
        // Accepted, and nothing to show for it. The console gets the detail because
        // this is a deployment fault the reader cannot do anything about and the
        // site owner can.
        // One message for both causes — a body with no comment in it, and a parent
        // that left the page — because the status code is the half the owner needs
        // to tell a broken endpoint from a lost race, and it is right there.
        console.error('charcha: comment accepted but could not be shown', response.status)
        // Nothing else moves. The composer keeps the reader's text, because the two
        // ways of being wrong here are not symmetrical: a comment the server really
        // stored survives a reload, while text discarded on the word of an endpoint
        // that only *said* 201 is gone. It also stays mounted where it is, so a
        // reply that is posted again is still addressed to the same comment.
        showStatus(widget, POSTED_UNSHOWN, false)
        // The status line sits above the thread and the composer may be far below
        // it, mounted under the comment being replied to. `nearest` moves the page
        // only when the message is off screen, and this is the one path where the
        // reader has nothing else to look at that would explain itself.
        widget.status.scrollIntoView({ block: 'nearest' })
        return
      }

      // The body clears; the name and the email do not, so a reader posting twice
      // does not type them twice. Nothing is written anywhere — close the tab and
      // it is gone (card rule 8).
      widget.body.value = ''
      // And the composer goes back to Write. The draft that preview was a rendering
      // of has just been published, so leaving the reader on the Preview tab would
      // show them their own posted comment a second time, in the box they write in.
      // `moveFocus` is false: insertOwnComment has already taken focus to the
      // comment that was just placed, and that is where the reader should be.
      widget.previewed = null
      selectTab(widget, false, false)
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
/* Write and Preview                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Shows one of the composer's two panels.
 *
 * `hidden` on the panel the reader is not looking at, `aria-selected` and a roving
 * `tabindex` on the tabs. Nothing here touches the textarea's value, and nothing
 * rebuilds anything: the field is the same plain `<textarea>` in both states, which
 * is the whole of the "the toolbar is not an editor" decision on #5.
 *
 * Focus stays on the tab the reader pressed, which is what a tablist does. The one
 * exception is going back to Write, where the reader has asked to carry on writing.
 * Enforced by test/dom/embed/preview.test.ts.
 */
function selectTab(widget: Widget, preview: boolean, moveFocus: boolean): void {
  widget.writeTab.setAttribute('aria-selected', String(!preview))
  widget.previewTab.setAttribute('aria-selected', String(preview))
  widget.writeTab.tabIndex = preview ? -1 : 0
  widget.previewTab.tabIndex = preview ? 0 : -1
  widget.write.hidden = preview
  widget.preview.hidden = !preview

  if (preview) {
    void showPreview(widget)
  } else if (moveFocus) {
    widget.body.focus()
  }
}

/**
 * Renders the draft by asking the Worker, which is the only renderer there is.
 *
 * **No Markdown parser ships in the embed** — one is 10–40 KB against 10 KB for the
 * whole widget (card rule 4), and a second implementation disagrees with the first
 * exactly when it matters, which is after the reader has posted. So the preview is
 * the published output rather than an approximation of it, sanitising included:
 * src/preview/route.ts runs the same `renderMarkdown` the publish runs (#78, #1).
 *
 * The draft goes as the raw body with **no headers at all**. A `fetch` given a
 * string and no headers sends `text/plain`, which is a CORS-simple request no
 * browser preflights — one billable Worker request per preview rather than two.
 */
async function showPreview(widget: Widget): Promise<void> {
  const draft = widget.body.value

  if (draft.trim() === '') {
    // Nothing is sent. An empty draft is a 400 the reader would have waited for and
    // a request somebody would have paid for, and the panel can say so instantly.
    widget.previewed = null
    message(widget.preview, PREVIEW_EMPTY, null)
    return
  }

  // Already on screen. A reader flicking between the tabs is not a reason to spend
  // requests against the 100,000/day that bounds a site on the free tier.
  if (widget.previewed === draft) return

  const run = (widget.previewRun += 1)
  message(widget.preview, PREVIEW_LOADING, null)
  widget.preview.setAttribute('aria-busy', 'true')

  try {
    const response = await fetch(previewUrl(widget.config.api), {
      method: 'POST',
      credentials: 'omit',
      body: draft,
    })
    if (run !== widget.previewRun) return

    const html = await response.text()
    if (run !== widget.previewRun) return

    if (response.status !== 200) {
      // Not rendered comment HTML — a sentence, a proxy's error page, or whatever
      // an endpoint that is not this Worker chose to send. It reaches the DOM
      // through `message`, as text, and never through `innerHTML`.
      widget.previewed = null
      message(widget.preview, messageForPreviewFailure(response.status, html), () => {
        void showPreview(widget)
      })
      return
    }

    // The one place network HTML enters this panel, and only on a 200. It is the
    // same trust the read path places in src/render/, which escapes — there is no
    // second rendering path here and there must not be. The wrapper carries the
    // renderer's own class so the preview is styled exactly as the published
    // comment will be; the name is a literal for the same reason every other
    // renderer class name in this file is.
    const body = document.createElement('div')
    body.className = 'charcha-comment-body'
    body.innerHTML = html
    widget.preview.textContent = ''
    widget.preview.appendChild(body)
    widget.previewed = draft
  } catch (error) {
    if (run !== widget.previewRun) return
    // The catch owns a visible state, or the panel sits on "Rendering…" forever and
    // reports the failure to nobody (CLAUDE.md). `previewed` stays null so that the
    // retry has something to retry.
    console.error('charcha: could not render the preview', error)
    widget.previewed = null
    message(widget.preview, messageForPreviewFailure(0, ''), () => {
      void showPreview(widget)
    })
  } finally {
    // Only the current run may say the panel has stopped working; a stale one
    // clearing this would unset a flag a newer request had just set.
    if (run === widget.previewRun) widget.preview.removeAttribute('aria-busy')
  }
}

/**
 * Puts the reader in the composer, wherever the composer currently is.
 *
 * Focusing the textarea unconditionally is wrong once the panels exist: on the
 * Preview tab the field is hidden, `focus()` on it does nothing at all, and a reader
 * who pressed Reply is left standing wherever they were.
 */
function focusComposer(widget: Widget): void {
  if (widget.write.hidden) widget.previewTab.focus()
  else widget.body.focus()
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
  // button while the form they asked for is somewhere further down the page. Which
  // control that is depends on the tab the reader left the composer on — the tabs
  // travel with the form and their state is preserved across the move, so the
  // textarea may well be hidden right now.
  focusComposer(widget)
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
 * Arrow-key movement across a group that is one stop in the tab order.
 *
 * `role="toolbar"` and `role="tablist"` both promise exactly this to a screen-reader
 * user, so the alternative to implementing it is not "a simpler control" — it is a
 * control that lies about how it is operated. One implementation for both, because
 * two would be the same code twice with only one of them maintained.
 */
function wireRoving(
  container: HTMLElement,
  items: readonly HTMLElement[],
  onMove: (next: HTMLElement) => void,
): void {
  container.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    const current = items.findIndex((item) => item === document.activeElement)
    if (current === -1) return
    event.preventDefault()
    const next = items[(current + step + items.length) % items.length]
    if (next === undefined) return
    onMove(next)
    next.focus()
  })
}

/**
 * The tabs. Selecting is what activating one means — there is nothing further to
 * confirm, and a second keystroke to see your own comment would be a step for
 * nothing.
 */
function wireTabs(widget: Widget): void {
  const tabs = requireElement<HTMLElement>(widget.form, '.charcha-tabs')
  const show = (tab: Element): void => {
    selectTab(widget, tab === widget.previewTab, true)
  }
  wireRoving(tabs, [widget.writeTab, widget.previewTab], show)
  tabs.addEventListener('click', (event) => {
    const tab = (event.target as Element | null)?.closest('.charcha-tab')
    if (tab === null || tab === undefined) return
    show(tab)
  })
}

/**
 * The formatting toolbar. Six buttons would otherwise sit between the reader and the
 * field they are trying to reach.
 */
function wireToolbar(widget: Widget): void {
  const toolbar = requireElement<HTMLElement>(widget.form, '.charcha-toolbar')
  const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('.charcha-toolbar-button'))
  buttons.forEach((button, index) => {
    button.tabIndex = index === 0 ? 0 : -1
  })

  wireRoving(toolbar, buttons, (next) => {
    for (const button of buttons) button.tabIndex = button === next ? 0 : -1
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
  wireTabs(widget)
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
    writeTab: requireElement<HTMLButtonElement>(root, `#${id.writeTab}`),
    previewTab: requireElement<HTMLButtonElement>(root, `#${id.previewTab}`),
    write: requireElement<HTMLElement>(root, `#${id.write}`),
    preview: requireElement<HTMLElement>(root, `#${id.preview}`),
    previewed: null,
    previewRun: 0,
    home: root,
    config,
    parentId: null,
    openedAt: performance.now(),
    submitting: false,
    turnstile: null,
  }

  // Started before the comments are fetched, so the challenge is running while the
  // reader is still reading the thread. A token minted then is already waiting by
  // the time they have written anything.
  if (config.turnstileSitekey !== null) {
    widget.turnstile = startTurnstile(widget, config.turnstileSitekey)
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
