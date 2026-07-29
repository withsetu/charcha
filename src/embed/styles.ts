// The default stylesheet. Designed on issue #6.
//
// **It names no colour and no typeface.** Every surface, rule and muted label is
// mixed out of the host page's own `currentColor`, and every size is relative to the
// host's own font. That is what closes the dark-mode requirement without a toggle:
// there is no widget theme to switch, so the widget is dark exactly when the host
// is — no media query, no stored preference, and nothing at all on the reader's
// machine (card rule 8).
//
// Two consequences worth stating, because they read as omissions otherwise:
//
// - **The primary button is outlined, not filled.** A filled button needs a label
//   colour that contrasts with its fill, and the widget cannot see the host's
//   background to pick one. An outlined button reuses the host's own text-on-
//   background pair, which the host has already made readable — so it is the only
//   button that is provably AA in both a light and a dark host rather than
//   accidentally so.
// - **No state is signalled by colour.** The error is a rule and a weight, the
//   pending badge is a bordered pill with the word "Pending" in it. WCAG 1.4.1, and
//   also the only thing that can work when the palette is somebody else's.
//
// Enforced by test/worker/embed/styles.test.ts.

import type { StylesMode } from './config'

/**
 * The custom properties an owner may override in `tokens` mode (#6).
 *
 * A published contract, like the class names: an owner's stylesheet sets these by
 * name, so removing or renaming one breaks their site on their next deploy. The
 * internal `--cc-*` properties the sheet actually reads are deliberately *not* this
 * list — they are free to move.
 *
 * **Thirteen, where #6's design note said twelve.** The thirteenth is
 * `--charcha-control-line`, and it exists because measuring the rendered widget
 * found a real WCAG 2.1 AA failure: a single line token cannot serve both jobs. A
 * rule between two comments is decoration and looks right at 20% of the host's
 * colour, while the border of a text input is what identifies the control, which
 * WCAG 1.4.11 requires at 3:1 — and 20% measured 1.52:1 against a light host.
 * Collapsing the two either fails 1.4.11 or drags the separators up to a weight
 * they should not have.
 * Enforced by test/worker/embed/styles.test.ts.
 */
export const OVERRIDABLE_TOKENS = [
  '--charcha-muted',
  '--charcha-line',
  '--charcha-control-line',
  '--charcha-surface',
  '--charcha-surface-strong',
  '--charcha-radius',
  '--charcha-gap',
  '--charcha-pad',
  '--charcha-indent',
  '--charcha-font-size',
  '--charcha-line-height',
  '--charcha-focus',
  '--charcha-focus-width',
] as const

/**
 * The derived value of each token, keyed by the internal property the sheet reads.
 *
 * One table, used twice: the base sheet declares these directly, and the `tokens`
 * overlay declares them again behind `var(--charcha-*, …)`. Written once so the two
 * cannot drift into disagreeing about what the default is.
 *
 * Every ratio below is a measurement rather than a taste, because mixing
 * currentColor toward transparent always *reduces* the host's own text contrast and
 * the widget cannot see the background it will land on. The two that carry a
 * requirement were measured in a real browser against a light host
 * (#1f1d1b on #fdfcfa) and a dark one (#e6e8ea on #0f1216):
 *
 *   - 70% muted — 6.17:1 light, 7.85:1 dark. WCAG 1.4.3 needs 4.5:1, and muted is
 *     used only for supplementary text (timestamp, hint, status) that is never the
 *     sole carrier of meaning.
 *   - 55% control line — 3.81:1 light, 5.13:1 dark. WCAG 1.4.11 needs 3:1 for the
 *     boundary that identifies a control.
 *
 * A host whose own text sits at the 4.5:1 floor cannot yield an AA muted colour by
 * any ratio; that is arithmetic rather than a bug, and `tokens` mode is the answer
 * for an owner in that position.
 */
const TOKEN_DEFAULTS: readonly (readonly [string, string, string])[] = [
  ['--cc-muted', '--charcha-muted', 'color-mix(in oklab, currentColor 70%, transparent)'],
  // Decoration: the rules between comments and beside a blockquote. Not governed by
  // 1.4.11 — they identify no control and carry no state.
  ['--cc-line', '--charcha-line', 'color-mix(in oklab, currentColor 20%, transparent)'],
  // The boundary of every input, textarea and button. This is the one 1.4.11 governs.
  [
    '--cc-control-line',
    '--charcha-control-line',
    'color-mix(in oklab, currentColor 55%, transparent)',
  ],
  ['--cc-surface', '--charcha-surface', 'color-mix(in oklab, currentColor 5%, transparent)'],
  [
    '--cc-surface-strong',
    '--charcha-surface-strong',
    'color-mix(in oklab, currentColor 11%, transparent)',
  ],
  ['--cc-radius', '--charcha-radius', '0.5em'],
  ['--cc-gap', '--charcha-gap', '1.25em'],
  ['--cc-pad', '--charcha-pad', '0.75em'],
  ['--cc-indent', '--charcha-indent', '1.25em'],
  ['--cc-font-size', '--charcha-font-size', '1em'],
  ['--cc-line-height', '--charcha-line-height', '1.55'],
  ['--cc-focus', '--charcha-focus', 'currentColor'],
  ['--cc-focus-width', '--charcha-focus-width', '2px'],
]

function declarations(): string {
  return TOKEN_DEFAULTS.map(([internal, , value]) => `${internal}:${value}`).join(';')
}

/**
 * The overlay that makes `tokens` mode mean something.
 *
 * Appended after the base sheet, so it wins on the cascade, and it redeclares each
 * internal property as the owner's token with the derived value as its fallback. An
 * owner who sets nothing therefore gets exactly `inherit`; an owner who sets one
 * property changes one thing, with no `!important` and no specificity fight.
 */
function overrides(): string {
  const body = TOKEN_DEFAULTS.map(
    ([internal, token, value]) => `${internal}:var(${token},${value})`,
  ).join(';')
  return `.charcha-root{${body}}`
}

/**
 * The base sheet.
 *
 * Written as one string rather than assembled, because it is read far more often
 * than it is changed and a builder would make it harder to see what a host page
 * actually receives.
 */
function base(): string {
  return `
.charcha-root,.charcha-root *{box-sizing:border-box}
.charcha-root{${declarations()};font-size:var(--cc-font-size);line-height:var(--cc-line-height);text-align:start}
.charcha-root :focus-visible{outline:var(--cc-focus-width) solid var(--cc-focus);outline-offset:2px;border-radius:2px}

.charcha-status{margin:0 0 var(--cc-gap);color:var(--cc-muted)}
.charcha-status:empty{display:none}
.charcha-retry{margin-inline-start:.5em}

.charcha-comments{list-style:none;margin:0 0 var(--cc-gap);padding:0}
.charcha-comment{margin:0;padding:var(--cc-gap) 0;border-top:1px solid var(--cc-line)}
.charcha-comments>.charcha-comment:first-child{border-top:0;padding-top:0}
.charcha-comment-header{display:flex;flex-wrap:wrap;align-items:baseline;gap:.5em;margin-bottom:.35em}
.charcha-comment-author{font-weight:600}
.charcha-comment-time{font-size:.8125em;color:var(--cc-muted)}
.charcha-comment-body>*{margin:.5em 0}
.charcha-comment-body>:first-child{margin-top:0}
.charcha-comment-body>:last-child{margin-bottom:0}
.charcha-comment-body pre{overflow-x:auto;padding:var(--cc-pad);border-radius:var(--cc-radius);background:var(--cc-surface)}
.charcha-comment-body blockquote{margin-inline:0;padding-inline-start:var(--cc-pad);border-inline-start:2px solid var(--cc-line);color:var(--cc-muted)}
.charcha-replies{list-style:none;margin:var(--cc-gap) 0 0;padding-inline-start:var(--cc-indent);border-inline-start:1px solid var(--cc-line)}
.charcha-replies>.charcha-comment{border-top:0;padding-bottom:0}
.charcha-replies>.charcha-comment+.charcha-comment{padding-top:var(--cc-gap)}
.charcha-empty,.charcha-truncated{margin:0 0 var(--cc-gap);color:var(--cc-muted)}
.charcha-truncated{padding-top:var(--cc-gap);border-top:1px solid var(--cc-line)}

.charcha-comment-actions{margin-top:.5em}
.charcha-pending{display:inline-block;padding:.05em .5em;border:1px solid var(--cc-control-line);border-radius:99em;font-size:.75em;font-weight:600;letter-spacing:.02em;text-transform:uppercase}

.charcha-form{display:block;margin:0;padding:var(--cc-pad);border:1px solid var(--cc-line);border-radius:var(--cc-radius)}
.charcha-reply-header{display:flex;align-items:baseline;justify-content:space-between;gap:.5em;margin-bottom:var(--cc-pad);padding-bottom:var(--cc-pad);border-bottom:1px solid var(--cc-line)}
.charcha-reply-to{font-weight:600}

.charcha-tabs{display:flex;gap:.25em;margin-bottom:var(--cc-pad);border-bottom:1px solid var(--cc-line)}
/* The selected tab is drawn by [aria-selected], not by a class of its own: the state
   is already in the DOM for assistive technology, and a second copy of it is a
   second thing to keep in step. It is a border and a surface rather than a colour —
   the widget cannot see the host's palette to pick one (#6). */
.charcha-tab{margin-bottom:-1px;padding:.35em .7em;border:1px solid transparent;border-bottom-color:transparent;border-radius:var(--cc-radius) var(--cc-radius) 0 0;background:transparent;color:inherit;font:inherit;font-size:.8125em;font-weight:600;line-height:1.4;cursor:pointer}
.charcha-tab[aria-selected="true"]{border-color:var(--cc-control-line);border-bottom-color:transparent;background:var(--cc-surface)}
/* Matched to the textarea's own min-height, so switching tabs does not move the
   Post button out from under the reader's pointer. */
.charcha-preview{min-height:7em;padding:.5em .6em}
.charcha-toolbar{display:flex;flex-wrap:wrap;gap:.25em;margin-bottom:.5em}
.charcha-field{display:block;margin-bottom:var(--cc-pad)}
.charcha-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:var(--cc-pad)}
.charcha-fields .charcha-field{margin-bottom:0}
.charcha-label{display:block;margin-bottom:.3em;font-size:.8125em;font-weight:600}
.charcha-input,.charcha-textarea{display:block;width:100%;padding:.5em .6em;border:1px solid var(--cc-control-line);border-radius:var(--cc-radius);background:transparent;color:inherit;font:inherit}
.charcha-textarea{min-height:7em;resize:vertical}
.charcha-hint{margin:.35em 0 0;font-size:.75em;color:var(--cc-muted)}

.charcha-toolbar-button,.charcha-retry,.charcha-reply-button,.charcha-cancel-reply,.charcha-submit{padding:.35em .7em;border:1px solid var(--cc-control-line);border-radius:var(--cc-radius);background:var(--cc-surface);color:inherit;font:inherit;font-size:.8125em;line-height:1.4;cursor:pointer;transition:background-color .12s}
.charcha-toolbar-button:hover,.charcha-retry:hover,.charcha-reply-button:hover,.charcha-cancel-reply:hover,.charcha-submit:hover{background:var(--cc-surface-strong)}
.charcha-toolbar-button{min-width:2.25em;font-weight:600}
.charcha-submit{padding:.55em 1.1em;border-color:currentColor;font-size:1em;font-weight:600}
.charcha-submit[disabled]{cursor:default;opacity:.6}

/* Styled on the iframe rather than on the container, so that the space exists only
   when there is a widget to occupy it. With appearance:interaction-only the common
   case is a container holding nothing a reader can see, and a permanent margin there
   would be a gap in every composer on every page. */
.charcha-turnstile iframe{margin-top:var(--cc-pad);max-width:100%}
.charcha-error{margin:var(--cc-pad) 0 0;padding-inline-start:var(--cc-pad);border-inline-start:3px solid currentColor;font-weight:600}
.charcha-actions{display:flex;justify-content:flex-end;margin-top:var(--cc-pad)}
`.trim()
}

/**
 * The CSS for a styling mode.
 *
 * `bare` is an empty string and not a reset: bare is permission to drop Charcha's
 * CSS entirely, and a "minimal" sheet would be Charcha still styling the page while
 * claiming not to.
 */
export function stylesheet(mode: StylesMode): string {
  if (mode === 'bare') return ''
  return mode === 'tokens' ? base() + overrides() : base()
}
