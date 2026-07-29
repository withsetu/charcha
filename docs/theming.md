# Theming

Charcha's design goal is to be invisible: the comment widget should look like part of
your site, not like something bolted onto it. It achieves that by owning as little of
the appearance as possible.

> **Status.** Everything on this page is **built**: the class names and HTML structure,
> the three styling modes, and the custom properties. A test asserts the exact set of
> class names and the exact list of properties, so a rename cannot happen by accident.
> Nobody has deployed Charcha to production yet
> ([#16](https://github.com/withsetu/charcha/issues/16)).

## Adding Charcha to a page

Two lines. The `<script>` names your deployment once, and the widget takes the address
from there.

```html
<div id="charcha"></div>
<script src="https://your-worker.example.workers.dev/embed.js" defer></script>
```

| Attribute | On | What it does |
|---|---|---|
| `data-styles` | the mount element | `inherit` *(default)*, `tokens` or `bare` — see below |
| `data-thread` | the mount element | Pins the conversation to a slug of your choosing instead of the page's path. Use it when the same conversation appears at more than one address, or when your CDN rewrites paths |
| `data-api` | the mount element | The deployment address, if it is not where `embed.js` was served from |
| `data-charcha` | any element | An alternative to `id="charcha"`, for pages that mount more than one widget |
| `data-turnstile-sitekey` | the mount element | Your [Turnstile](https://developers.cloudflare.com/turnstile/) sitekey. Set it **only** if you also set `TURNSTILE_SECRET_KEY` on the Worker — see below |

`embed.js` is served as a **static asset**, so fetching it costs your deployment nothing
against the Cloudflare request budget — only the comment read does. It is
[under 7 KB gzipped](https://github.com/withsetu/charcha/issues/5) and enforced at 10 KB.

## Turnstile

Turnstile is optional and off. With no `TURNSTILE_SECRET_KEY` on the Worker, Charcha
never checks a token and never makes the call; with no `data-turnstile-sitekey` on the
page, Cloudflare's script is never fetched. Nothing loads speculatively.

**Set both or neither.** They are two halves of one switch, and setting only the secret
stops every comment reaching the page: the Worker wants a token that nothing on the page
is producing. Those comments are **held for review** rather than refused, until one real
token has verified on the deployment — after that a comment with no token is refused. So
the symptom of a missing sitekey is a moderation queue filling with comments that look
perfectly fine, which is why your dashboard's **Setup** tab names the sitekey explicitly
([#104](https://github.com/withsetu/charcha/issues/104)). The sitekey is public by design
— it appears in the page HTML of every site that uses Turnstile — so putting it in an
attribute discloses nothing.

The Worker's half is **not** collected by the deploy form, deliberately: that form
requires a value in every field it shows, and an invented Turnstile secret matches no
widget and refuses every comment. Set it afterwards, with
`pnpm wrangler secret put TURNSTILE_SECRET_KEY` —
[the README has the whole step](../README.md#turning-on-the-optional-features).

When it is on, Charcha renders the widget inside its own composer, in
`interaction-only` mode: most readers never see it, and one who is challenged sees it
appear directly above the Post button. Tokens are valid for
[300 seconds and can be used once](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/),
so the widget refreshes before a comment is posted and again after — a form left open
for an hour still posts.

**Charcha itself stores nothing in the reader's browser**, with or without this turned
on — no cookie, no `localStorage`, no `sessionStorage`. That is a claim about Charcha,
and it is the only one we are in a position to make: Cloudflare's widget is a
third-party script running in an iframe on `challenges.cloudflare.com`, and what it
does there is covered by the
[Turnstile Privacy Addendum](https://www.cloudflare.com/turnstile-privacy-policy/),
which you should read before turning this on.

One part of it is worth naming because it would land on **your** domain rather than
Cloudflare's: Turnstile's **pre-clearance** issues a `cf_clearance` cookie.
[Every widget has it off by default](https://developers.cloudflare.com/turnstile/get-started/pre-clearance/)
and you would have to switch it on yourself in the Cloudflare dashboard. Charcha's
no-cookies promise cannot cover a cookie you asked Cloudflare to set. Leave it off, or
disclose it.

Your deployment must be told which origins may use it, or the browser will refuse every
response ([#57](https://github.com/withsetu/charcha/issues/57)).

## The markup Charcha produces

This is the whole vocabulary. There is no shadow DOM and no iframe — the comments are
ordinary elements in your page, which is what lets your own stylesheet reach them.

```html
<ol class="charcha-comments">
  <li class="charcha-comment" id="charcha-comment-1">
    <div class="charcha-comment-header">
      <span class="charcha-comment-author">Rahul</span>
      <time class="charcha-comment-time" datetime="2026-07-23T19:46:40.000Z">
        2026-07-23 19:46 UTC
      </time>
    </div>
    <div class="charcha-comment-body"><p>The part people underestimate is the export.</p></div>

    <ol class="charcha-replies">
      <li class="charcha-comment charcha-reply" id="charcha-comment-2">
        <div class="charcha-comment-header">
          <span class="charcha-comment-author">Maya</span>
          <time class="charcha-comment-time" datetime="2026-07-23T20:02:11.000Z">
            2026-07-23 20:02 UTC
          </time>
        </div>
        <div class="charcha-comment-body"><p>Agreed — and it is the part nobody tests.</p></div>
      </li>
    </ol>
  </li>
</ol>
```

A page with no comments yet renders one element instead:

```html
<p class="charcha-empty">Be the first to comment</p>
```

## The class names

Two lists, because two things emit markup: the **renderer**, which produces the comments
themselves and also runs on the server-rendering paths, and the **embed**, which produces
the widget around them. Both are a **public API**: your stylesheet targets these
directly, so renaming one would silently break the appearance of every site that had
styled it. Changing either list is a breaking change, and a test asserts both that every
name here is emitted and that nothing outside it is.

### From the renderer — the comments

| Class | Where |
|---|---|
| `charcha-comments` | The outer `<ol>` holding every top-level comment |
| `charcha-comment` | One comment. On **every** comment, including replies |
| `charcha-reply` | Added alongside `charcha-comment` on a reply |
| `charcha-comment-by-owner` | Added when the comment was written by the site owner |
| `charcha-comment-header` | The author-and-time row |
| `charcha-comment-author` | The author's name |
| `charcha-comment-time` | The timestamp — a real `<time>` with a machine-readable `datetime` |
| `charcha-comment-body` | The rendered comment text |
| `charcha-replies` | The nested `<ol>` holding one comment's replies |
| `charcha-empty` | Shown instead of the list when there are no comments |
| `charcha-truncated` | A notice below the list when the page holds more comments than one read returns |

### From the embed — the widget

| Class | Where |
|---|---|
| `charcha-root` | The widget's outer element. `box-sizing: border-box` is set on it and everything inside |
| `charcha-status` | A live region: loading, a read failure, or the confirmation after you post |
| `charcha-retry` | The button offered when the comments could not be loaded |
| `charcha-thread` | The element the rendered comments are placed into |
| `charcha-comment-actions` | The row holding one comment's Reply button |
| `charcha-reply-button` | Reply. Only on top-level comments — there is no third level |
| `charcha-pending` | The badge on your own just-posted comment, awaiting review |
| `charcha-form` | The composer |
| `charcha-form-replying` | Added to the composer while it is mounted under a comment as a reply |
| `charcha-reply-header` | The "Replying to …" row inside the composer |
| `charcha-reply-to` | The "Replying to …" text |
| `charcha-cancel-reply` | The button that dismisses the reply |
| `charcha-tabs` | The Write/Preview tablist, a real `role="tablist"` |
| `charcha-tab` | One tab. The selected one carries `aria-selected="true"` — style that, there is no separate class |
| `charcha-write` | The Write panel: the toolbar and the comment field |
| `charcha-toolbar` | The formatting toolbar, a real `role="toolbar"` |
| `charcha-toolbar-button` | One formatting button |
| `charcha-fields` | The name-and-email row |
| `charcha-field` | One labelled field |
| `charcha-label` | A field's `<label>` |
| `charcha-input` | The name and email `<input>`s |
| `charcha-textarea` | The comment `<textarea>` |
| `charcha-preview` | The Preview panel. Holds a `charcha-comment-body` once the Worker has rendered the draft |
| `charcha-hint` | The line under the email field |
| `charcha-error` | The message shown when a comment was not accepted |
| `charcha-actions` | The row holding the submit button |
| `charcha-submit` | Post comment |

Notes that will save you a surprise:

- **`charcha-comment` is on replies too.** A reply carries both `charcha-comment` and
  `charcha-reply`. Style the common case once, then use `.charcha-reply` for what
  differs. If you want *only* top-level comments, use
  `.charcha-comments > .charcha-comment`.
- **Threading stops at one level.** There is no third level to style; the database
  refuses it.
- **The preview is the published comment.** Its contents are wrapped in
  `charcha-comment-body` — the renderer's own class, the same one a posted comment
  carries — so anything you style there shows up in the preview without a second
  rule. That is the point: the preview is rendered by the Worker, by the same
  function that renders the published page.
- **Each comment has a stable `id`** (`charcha-comment-<id>`), so links to individual
  comments work.
- **The timestamp is UTC**, and says so in the visible text. The `datetime` attribute
  carries full precision, which is the hook for showing it differently later.

## Styling it yourself

Because the markup is plain elements in your page, your own stylesheet can target it
with no special mechanism:

```css
.charcha-comment {
  padding-block: 1rem;
  border-top: 1px solid color-mix(in oklab, currentColor 16%, transparent);
}

.charcha-comment-author { font-weight: 600; }

.charcha-comment-time {
  font-size: 0.875em;
  opacity: 0.7;
}

.charcha-replies {
  margin-inline-start: 1.5rem;
  list-style: none;
}

.charcha-comment-by-owner {
  /* mark the site owner's own replies */
}
```

One thing worth copying: deriving colours from `currentColor` rather than naming them.
`color-mix(in oklab, currentColor 16%, transparent)` produces a border that is legible on
a light background and on a dark one, without a media query and without knowing anything
about the surrounding page. That is the same technique Charcha's own default stylesheet
uses, for the same reason.

## Styling modes

Three, chosen with an attribute on the mount element so the setting lives in your site's
repository rather than only in a database:

```html
<div id="charcha" data-styles="bare"></div>
```

| Mode | What Charcha sends | Who owns the appearance |
|---|---|---|
| `inherit` *(default)* | A small default stylesheet | Charcha, deriving everything from your page |
| `tokens` | The default stylesheet, with thirteen properties open to you | You, through those properties |
| `bare` | No CSS at all | You, entirely |

`inherit` is deliberately **not** overridable: in that mode Charcha owns the appearance,
and if you want to change something you ask for `tokens`. That is what makes the choice
between them mean something rather than being two names for one stylesheet.

**The default stylesheet names no colour and no typeface.** Every surface, rule and muted
label is mixed out of your page's own `currentColor`, and every size is relative to your
own font:

```css
--cc-muted:        color-mix(in oklab, currentColor 70%, transparent);
--cc-line:         color-mix(in oklab, currentColor 20%, transparent);
--cc-control-line: color-mix(in oklab, currentColor 55%, transparent);
--cc-surface:      color-mix(in oklab, currentColor  5%, transparent);
```

This is also how dark mode is handled: there is no widget theme to switch, no media
query, and nothing stored in the reader's browser — the widget is dark exactly when your
page is. That last point is a hard rule, not an implementation detail; Charcha stores
nothing on a reader's machine.

`bare` mode is why the class names above are a public API rather than an internal detail.

### The thirteen properties

In `tokens` mode, set any of these anywhere they will be inherited — `:root`, or the
element around the widget. Setting none of them is identical to `inherit`.

| Property | Default | What it is |
|---|---|---|
| `--charcha-muted` | `currentColor` at 70% | Timestamps, hints, status text |
| `--charcha-line` | `currentColor` at 20% | Rules between comments, and beside a quote |
| `--charcha-control-line` | `currentColor` at 55% | The border of every input and button |
| `--charcha-surface` | `currentColor` at 5% | Button and code-block fills |
| `--charcha-surface-strong` | `currentColor` at 11% | The same, on hover |
| `--charcha-radius` | `0.5em` | Corner radius |
| `--charcha-gap` | `1.25em` | The vertical rhythm between comments |
| `--charcha-pad` | `0.75em` | Inner padding |
| `--charcha-indent` | `1.25em` | How far a reply is indented |
| `--charcha-font-size` | `1em` | The widget's base size, relative to yours |
| `--charcha-line-height` | `1.55` | |
| `--charcha-focus` | `currentColor` | The focus ring |
| `--charcha-focus-width` | `2px` | |

`--charcha-line` and `--charcha-control-line` are separate on purpose. A rule between two
comments is decoration and looks right when it is faint; the border of a text input is
what tells a reader the control is there, and WCAG requires it at 3:1 against the
background. One property cannot be both without failing one of the two jobs.

## Accessibility

Charcha targets WCAG 2.1 AA, and the widget is built to it: a real `<form>` with real
`<label>`s, a real `role="toolbar"` you can drive with the arrow keys, focus that moves
into the reply composer when you open it and onto your comment when you post it, and
errors associated with their field rather than signalled by colour. **No state in the
widget is carried by colour alone** — which is both a WCAG requirement and the only thing
that can work when the palette belongs to somebody else.

Measured in a browser against a light host (`#1f1d1b` on `#fdfcfa`) and a dark one
(`#e6e8ea` on `#0f1216`), with the same stylesheet and nothing telling it which was
which:

| | light | dark | needs |
|---|---|---|---|
| Comment text | 16.4:1 | 15.3:1 | 4.5:1 |
| Timestamps, hints, status | 6.2:1 | 7.9:1 | 4.5:1 |
| Input and button borders | 3.7:1 | 5.2:1 | 3:1 |

Two parts are yours rather than ours, because they depend on the page around the widget:

- **Contrast, if your own is marginal.** Everything above is mixed from your text colour,
  so it is as legible as your body text is — but mixing toward transparent can only
  *reduce* contrast. If your own text sits near the 4.5:1 floor, no ratio Charcha picks
  can keep the muted labels above it; `tokens` mode is the answer there.
- **Heading order.** Charcha emits no headings. If you put a "Comments" heading above the
  widget, give it the level that fits your page's outline.

## If your site sets a Content-Security-Policy

The default stylesheet is written into the page as a `<style>` element, so a policy with
`style-src 'self'` and no `'unsafe-inline'` will block it. The widget still works — you
get the markup with no CSS, which is `bare` mode — but you will want to either allow the
style or choose `bare` deliberately and ship your own. You will also need `connect-src`
to include your Charcha deployment, and `script-src` to allow it to serve `embed.js`.
