// Every piece of markup the embed puts on a page, as pure functions returning
// strings. Designed on issues #5 and #6.
//
// **Nothing in this file is built from anything a reader typed.** It is entirely
// literal, which is what makes it safe for mount.ts to write with `innerHTML`. The
// comment bodies that *are* untrusted arrive already rendered and escaped from the
// Worker (src/render/), and the one place a name reaches this widget — the
// "Replying to …" header — is filled through `textContent` afterwards, never here.
// There is no second rendering path in this project and there must not be one (#1).
//
// The class names are a public API. `bare` mode is permission to drop Charcha's CSS
// and style these directly (#6), so renaming one breaks somebody's site on their
// next deploy with nothing failing on ours — hence EMBED_CLASS_NAMES and the test
// that freezes it.
// Enforced by test/worker/embed/markup.test.ts.

import { TOOLBAR_ITEMS } from './toolbar'

/**
 * Every class name the embed emits, in one list.
 *
 * Changing this array is the review prompt: it is a breaking change for every
 * deployment in `bare` mode. The renderer's own names are a separate contract in
 * src/render/comments.ts and are deliberately not repeated here — two owners for one
 * name is how a rename in one file breaks the other silently.
 *
 * `charcha-form-replying` is the only one no builder emits: JavaScript toggles it on
 * the form while the composer is mounted as a reply.
 */
export const EMBED_CLASS_NAMES = [
  'charcha-root',
  'charcha-status',
  'charcha-retry',
  'charcha-thread',
  'charcha-comment-actions',
  'charcha-reply-button',
  'charcha-pending',
  'charcha-form',
  'charcha-form-replying',
  'charcha-reply-header',
  'charcha-reply-to',
  'charcha-cancel-reply',
  'charcha-tabs',
  'charcha-tab',
  'charcha-write',
  'charcha-toolbar',
  'charcha-toolbar-button',
  'charcha-fields',
  'charcha-field',
  'charcha-label',
  'charcha-input',
  'charcha-textarea',
  'charcha-preview',
  'charcha-hint',
  'charcha-error',
  'charcha-turnstile',
  'charcha-actions',
  'charcha-submit',
] as const

/** Toggled on the form by mount.ts while the composer is mounted as a reply. */
export const REPLYING_CLASS = 'charcha-form-replying'

/**
 * The one privacy line the design allows, and it sits on the field it is about
 * rather than in a banner or a footer (#5). Saying it here, at the moment the reader
 * is deciding whether to type an address, is the only place it does any work.
 */
const EMAIL_HINT =
  'Optional — for reply notifications, never shown publicly. No account, no cookies.'

/** The ids of the controls in one instance's composer. */
export function fieldIds(prefix: string) {
  return {
    body: `${prefix}-body`,
    name: `${prefix}-name`,
    email: `${prefix}-email`,
    hint: `${prefix}-hint`,
    error: `${prefix}-error`,
    write: `${prefix}-write`,
    writeTab: `${prefix}-write-tab`,
    preview: `${prefix}-preview`,
    previewTab: `${prefix}-preview-tab`,
  }
}

/**
 * The honeypot (#8, layer 1).
 *
 * Named `subject` because the name has to satisfy two opposing constraints: a
 * self-describing name (`hp`, `honeypot`) is skipped by the spam frameworks that
 * pattern-match field names, and `website`/`url`/`homepage` are exactly the names a
 * browser's autofill recognises — an autofilled honeypot rejects a real person's
 * comment, which is the worst failure this layer has.
 *
 * The hiding does **not** live in the stylesheet, because `bare` mode is permission
 * to drop that stylesheet and a spam guard a setting can switch off is not a guard
 * (#6). Two mechanisms, because either alone has a hole: `hidden` comes from the UA
 * stylesheet and survives both bare mode and a host CSP that blocks inline `style`
 * attributes, and the off-screen position survives a host stylesheet that has
 * redefined `[hidden]`.
 */
function honeypotMarkup(): string {
  return (
    '<input type="text" name="subject" value="" hidden' +
    ' style="position:absolute;left:-9999px" tabindex="-1"' +
    ' autocomplete="off" aria-hidden="true">'
  )
}

function toolbarMarkup(bodyId: string): string {
  const buttons = TOOLBAR_ITEMS.map(
    (item) =>
      // type="button" on every one of them. A button inside a form defaults to
      // type=submit, and one left as the default posts a half-written comment the
      // moment the reader clicks Bold.
      `<button type="button" class="charcha-toolbar-button" data-wrap="${item.name}"` +
      ` title="${item.title}" aria-label="${item.title}">${item.label}</button>`,
  ).join('')

  return (
    `<div class="charcha-toolbar" role="toolbar" aria-label="Formatting"` +
    ` aria-controls="${bodyId}">${buttons}</div>`
  )
}

/**
 * The Write and Preview tabs (#78).
 *
 * A real tablist, because `role="tablist"` is a promise about how the control is
 * operated — arrow keys, one stop in the tab order, a selected state a screen reader
 * can read — and the alternative to implementing it is not a simpler control but one
 * that lies about itself. mount.ts holds up the other end.
 *
 * `type="button"` on both, for the same reason the toolbar has it: a button inside a
 * form defaults to submit, and one left as the default posts a half-written comment
 * the moment the reader asks to look at it.
 *
 * The shipped state is Write selected and Preview hidden, so the composer is a plain
 * `<textarea>` in a plain `<form>` before a single listener has been attached.
 * Preview is the enhancement; it is never the way to post.
 * Enforced by test/worker/embed/markup.test.ts.
 */
function tabsMarkup(id: ReturnType<typeof fieldIds>): string {
  const tab = (name: string, panel: string, label: string, selected: boolean): string =>
    `<button type="button" class="charcha-tab" id="${name}" role="tab"` +
    ` aria-controls="${panel}" aria-selected="${String(selected)}"` +
    // Roving tabindex: the whole tablist is one stop in the tab order, so the tabs
    // do not sit between the reader and the field they are trying to reach.
    `${selected ? '' : ' tabindex="-1"'}>${label}</button>`

  return (
    `<div class="charcha-tabs" role="tablist" aria-label="Comment">` +
    tab(id.writeTab, id.write, 'Write', true) +
    tab(id.previewTab, id.preview, 'Preview', false) +
    `</div>`
  )
}

/**
 * The composer.
 *
 * A real `<form>` with real `<label>`s and a real submit button, so that Enter
 * submits, the browser's own validation runs, a screen reader announces each field
 * by name, and the whole thing is reachable with a keyboard without the embed
 * implementing any of that itself.
 *
 * Ids are scoped to the instance because a page may mount the widget twice, and two
 * elements sharing an id break the label association for both of them.
 *
 * `maxlength` mirrors src/submit/schema.ts. It is a courtesy, not a check — the
 * browser stopping the reader at the limit is kinder than a 400 after they wrote it,
 * and the server's cap remains the only thing that decides.
 */
export function composerMarkup(prefix: string): string {
  const id = fieldIds(prefix)

  return (
    `<form class="charcha-form" novalidate>` +
    honeypotMarkup() +
    tabsMarkup(id) +
    // The Write panel holds the toolbar and the field, and nothing else. The tabs
    // switch what is *displayed*, never what the field is — it stays a plain
    // textarea, which is what keeps the toolbar from becoming an editor (#5).
    `<div class="charcha-write" id="${id.write}" role="tabpanel"` +
    ` aria-labelledby="${id.writeTab}">` +
    toolbarMarkup(id.body) +
    `<div class="charcha-field">` +
    `<label class="charcha-label" for="${id.body}">Comment</label>` +
    `<textarea class="charcha-textarea" id="${id.body}" name="body" rows="5"` +
    ` maxlength="10000" required aria-describedby="${id.error}"></textarea>` +
    `</div>` +
    `</div>` +
    // Where the Worker's rendering of the draft lands. Empty in the markup and
    // filled by mount.ts, because its contents are the one thing in this file that
    // is not literal — and it is HTML from src/render/, exactly as the read path's
    // is (#1).
    //
    // `aria-live` because the rendering arrives after the reader has stopped
    // pressing the tab, so nothing announces it otherwise; `tabindex="0"` because
    // the panel is mostly non-interactive text, which is unreachable from the
    // keyboard without its own stop.
    `<div class="charcha-preview" id="${id.preview}" role="tabpanel"` +
    ` aria-labelledby="${id.previewTab}" aria-live="polite" tabindex="0" hidden></div>` +
    `<div class="charcha-fields">` +
    `<div class="charcha-field">` +
    `<label class="charcha-label" for="${id.name}">Name</label>` +
    `<input class="charcha-input" id="${id.name}" name="authorName" type="text"` +
    ` maxlength="80" required autocomplete="name">` +
    `</div>` +
    `<div class="charcha-field">` +
    `<label class="charcha-label" for="${id.email}">Email</label>` +
    `<input class="charcha-input" id="${id.email}" name="authorEmail" type="email"` +
    ` maxlength="254" autocomplete="email" aria-describedby="${id.hint}">` +
    `<p class="charcha-hint" id="${id.hint}">${EMAIL_HINT}</p>` +
    `</div>` +
    `</div>` +
    // Hidden until there is something to say. An empty alert region announced on
    // load is noise, and an always-present empty node reads as a rendering bug.
    `<p class="charcha-error" id="${id.error}" role="alert" hidden></p>` +
    // Where Cloudflare's widget is rendered, when the owner configured one (#79).
    // Always present and almost always empty: it costs one element, and building it
    // conditionally would put a second markup path in the file whose whole value is
    // that it has none. It is inside the form so that it travels with the composer
    // when the composer moves under a comment to become a reply.
    `<div class="charcha-turnstile"></div>` +
    `<div class="charcha-actions">` +
    `<button type="submit" class="charcha-submit">Post comment</button>` +
    `</div>` +
    `</form>`
  )
}

/**
 * The shell: a live region for what the read is doing, and somewhere for the
 * Worker's HTML to land.
 *
 * `role="status"` with `aria-live="polite"` rather than an alert, because the two
 * things it says — "loading" and "that did not work, here is a retry" — should reach
 * a screen-reader user without interrupting what they were reading.
 */
export function widgetMarkup(prefix: string): string {
  return (
    `<div class="charcha-root">` +
    `<p class="charcha-status" id="${prefix}-status" role="status" aria-live="polite"></p>` +
    `<div class="charcha-thread"></div>` +
    `</div>`
  )
}

/**
 * The retry, offered whenever the read failed.
 *
 * A read error is deliberately not the empty state: "nobody has commented" and "we
 * could not find out" look identical without this, and only one of them is worth the
 * reader's second attempt. CLAUDE.md — a loading state that never resolves is an
 * unreported failure, and this is what the `catch` owes the reader.
 */
export function retryMarkup(): string {
  return '<button type="button" class="charcha-retry">Try again</button>'
}

/** The Reply affordance, appended to each root comment by mount.ts. */
export function replyButtonMarkup(): string {
  return (
    '<div class="charcha-comment-actions">' +
    '<button type="button" class="charcha-reply-button">Reply</button>' +
    '</div>'
  )
}

/**
 * The badge on the reader's own just-posted comment.
 *
 * The word, not a colour: the widget cannot see the host's palette, and a state
 * carried by colour alone fails WCAG 1.4.1 anyway. It is honest about what happened
 * — the comment is in the moderation queue and nobody else can see it — while the
 * reader's words still land where they wrote them.
 */
export function pendingBadgeMarkup(): string {
  return '<span class="charcha-pending">Pending review</span>'
}

/** The header the composer grows when it is mounted beneath a comment as a reply. */
export function replyHeaderMarkup(): string {
  return (
    '<div class="charcha-reply-header">' +
    '<span class="charcha-reply-to"></span>' +
    '<button type="button" class="charcha-cancel-reply">Cancel reply</button>' +
    '</div>'
  )
}

/**
 * Every builder above, so a test can assert over all of them at once.
 *
 * A new builder that is not added here is not covered by the class-name and
 * vocabulary assertions — which is why the test also checks the length of this list
 * rather than only iterating it.
 */
export const EVERY_FRAGMENT: readonly ((prefix: string) => string)[] = [
  widgetMarkup,
  composerMarkup,
  replyButtonMarkup,
  pendingBadgeMarkup,
  replyHeaderMarkup,
  retryMarkup,
]
