# Theming

Charcha's design goal is to be invisible: the comment widget should look like part of
your site, not like something bolted onto it. It achieves that by owning as little of
the appearance as possible.

> **Status.** The class names and HTML structure below are **shipped and stable** — they
> are what the renderer emits today, and a test asserts the exact set so a rename cannot
> happen by accident. The styling *modes* and the CSS custom properties further down are
> **decided but not yet built** ([#6](https://github.com/withsetu/charcha/issues/6)),
> and are documented here so you can see the contract you would be styling against. They
> are marked where they appear.

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

All ten. This list is a **public API**: your stylesheet targets these directly, so
renaming one would silently break the appearance of every site that had styled it.
Changing this list is a breaking change, and a test asserts both that every name here is
emitted and that nothing outside it is.

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

Notes that will save you a surprise:

- **`charcha-comment` is on replies too.** A reply carries both `charcha-comment` and
  `charcha-reply`. Style the common case once, then use `.charcha-reply` for what
  differs. If you want *only* top-level comments, use
  `.charcha-comments > .charcha-comment`.
- **Threading stops at one level.** There is no third level to style; the database
  refuses it.
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

## Styling modes — decided, not yet built

> **Not implemented yet** — [#6](https://github.com/withsetu/charcha/issues/6). Written
> down because it is the agreed contract, not because you can use it today.

Charcha will ship three modes, chosen in the dashboard and mirrored as an attribute on
the embed so the setting can live in your site's repository rather than only in a
database:

```html
<div id="charcha" data-styles="bare"></div>
```

| Mode | What Charcha sends | Who owns the appearance |
|---|---|---|
| `inherit` *(default)* | A small default stylesheet | Charcha, deriving everything from your page |
| `tokens` | The default stylesheet plus your overrides | You, through a set of custom properties |
| `bare` | No CSS at all | You, entirely |

**The default stylesheet will name no colour and no typeface.** Every surface, rule and
muted label is mixed out of the host page's own `currentColor` and inherited font:

```css
--cc-muted:   color-mix(in oklab, currentColor 58%, transparent);
--cc-line:    color-mix(in oklab, currentColor 16%, transparent);
--cc-surface: color-mix(in oklab, currentColor  5%, transparent);
```

This is also how dark mode is handled: there is no widget theme to switch, no media
query, and nothing stored in the reader's browser — the widget is dark exactly when your
page is. That last point is a hard rule, not an implementation detail; Charcha stores
nothing on a reader's machine.

`bare` mode is why the class names above are a public API rather than an internal detail.

## Accessibility

Charcha targets WCAG 2.1 AA. Two parts of that are yours rather than ours, because they
depend on the page around the widget:

- **Contrast.** The default stylesheet derives from `currentColor`, which inherits your
  text colour — so it is legible wherever your body text is. If you override colours,
  check contrast yourself; Charcha cannot see the background it is sitting on.
- **Heading order.** Charcha emits no headings. If you put a "Comments" heading above the
  widget, give it the level that fits your page's outline.
