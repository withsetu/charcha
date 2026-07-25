// The key handler, and the first thing in this surface that was written.
//
// The brief on #13 settles that the keyboard is the primary interface and the mouse
// is the fallback, which inverts the usual build order: the layout serves the key
// map rather than the other way round. So the map is a pure function over a
// structural subset of `KeyboardEvent`, testable with no DOM and no React, and the
// component that listens does nothing but dispatch what this returns.
//
// Enforced by test/dashboard/keys.test.ts.

/** Every command a single keystroke can produce. */
export type Command =
  | { kind: 'move'; delta: 1 | -1 }
  | { kind: 'decide'; status: 'approved' | 'spam' | 'deleted' }
  | { kind: 'undo' }
  | { kind: 'help' }
  | { kind: 'dismiss' }
  | { kind: 'view'; index: 0 | 1 | 2 }

/**
 * The subset of `KeyboardEvent` the map reads.
 *
 * A structural type rather than the DOM interface so the map can be exercised
 * directly — a test that has to build a real `KeyboardEvent` to ask "does `s` inside
 * a textarea mark this spam" ends up testing the DOM's event constructor as much as
 * the guard. The integration path is covered separately, on a real element, in
 * test/dashboard/shortcuts.test.tsx.
 */
export interface KeyStroke {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** True mid-IME composition. Absent on some synthetic events; treated as false. */
  isComposing?: boolean
  target: EventTarget | null
}

/** The element names whose whole purpose is to receive keystrokes. */
const EDITABLE_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * Whether a keystroke aimed at this target belongs to the target rather than to the
 * queue.
 *
 * **This is the guard the brief names as the commonest bug in this class of UI: `s`
 * typed into a reply box marking the comment spam.** It is not a nicety and it is
 * not only about the reply box — the login form's password field is a text input on
 * this same surface, reachable before any comment has been loaded, and `?` typed
 * into it must not open the shortcut sheet either.
 *
 * Three ways a target can own its keys, and all three are needed:
 *   - it is an `input`, `textarea` or `select`;
 *   - it is `contenteditable`, or sits inside something that is — the property is
 *     inherited by descendants, and `isContentEditable` is the only reliable way to
 *     read that, because the attribute is on an ancestor;
 *   - it declares `role="textbox"`, which is how a custom editor says the same
 *     thing to assistive technology and must be believed here too.
 *
 * A non-element target — `document`, `window`, a text node — owns nothing.
 * Enforced by test/dashboard/keys.test.ts.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof Element)) return false
  if (EDITABLE_TAGS.has(target.tagName)) return true
  if (target instanceof HTMLElement && target.isContentEditable) return true
  return target.getAttribute('role') === 'textbox'
}

/**
 * The command a keystroke means, or null when it means nothing here.
 *
 * The four refusals come before the map is consulted, and their order is the design
 * — each is cheaper and broader than the next:
 *
 *   1. **A modifier the map does not use.** `Cmd`/`Ctrl`/`Alt` belong to the browser
 *      and the operating system: without this, `Cmd+A` would approve a comment
 *      instead of selecting the page's text, and `Ctrl+S` would mark it spam instead
 *      of being the browser's save. Shift is handled at 4 rather than here, because
 *      one binding needs it.
 *   2. **Mid-composition.** An IME composing `sa` into kana emits keystrokes whose
 *      `key` is a Latin letter; acting on them would have a Japanese commenter's
 *      moderator approve a comment while typing. Browsers set `isComposing` for
 *      exactly this, and it is checked before the map because no command should ever
 *      fire during composition.
 *   3. **The target owns its keys.** See isEditableTarget.
 *   4. **Shift.** Allowed only for `?`, which is `Shift+/` on the layouts most of
 *      this project's users have. Every other binding is a bare key, so `Shift+A`
 *      is a capital A somebody meant to type, not an approval.
 *
 * Comparison is on the lower-cased `key`, so Caps Lock does not silently disarm the
 * whole map — with Caps Lock on the browser reports `A` and `shiftKey: false`, which
 * a case-sensitive map would drop at rule 4 with nothing to show the owner.
 * Enforced by test/dashboard/keys.test.ts.
 */
export function resolveCommand(stroke: KeyStroke): Command | null {
  if (stroke.ctrlKey || stroke.metaKey || stroke.altKey) return null
  if (stroke.isComposing === true) return null
  if (isEditableTarget(stroke.target)) return null

  const key = stroke.key.toLowerCase()
  if (stroke.shiftKey && key !== '?') return null

  switch (key) {
    case 'j':
    case 'arrowdown':
      return { kind: 'move', delta: 1 }
    case 'k':
    case 'arrowup':
      return { kind: 'move', delta: -1 }
    case 'a':
      return { kind: 'decide', status: 'approved' }
    case 's':
      return { kind: 'decide', status: 'spam' }
    case 'd':
      return { kind: 'decide', status: 'deleted' }
    case 'z':
      return { kind: 'undo' }
    case '?':
      return { kind: 'help' }
    case 'escape':
      return { kind: 'dismiss' }
    case '1':
      return { kind: 'view', index: 0 }
    case '2':
      return { kind: 'view', index: 1 }
    case '3':
      return { kind: 'view', index: 2 }
    default:
      return null
  }
}

/** One row of the shortcut sheet. The sheet is generated from this, never retyped. */
export interface ShortcutHelp {
  keys: string
  description: string
}

/**
 * The shortcut sheet's contents, beside the map rather than in the component, so a
 * binding cannot be added above without the sheet that documents it going stale in
 * the same file. It is not asserted to match `resolveCommand` — a list and a switch
 * cannot be compared without an enumeration neither of them has — so this is
 * **intended** to stay in step, and the review prompt is that they are adjacent.
 */
export const SHORTCUTS: readonly ShortcutHelp[] = [
  { keys: 'J  or  ↓', description: 'Next comment' },
  { keys: 'K  or  ↑', description: 'Previous comment' },
  { keys: 'A', description: 'Approve — publishes it' },
  { keys: 'S', description: 'Spam — hides it, and its replies' },
  { keys: 'D', description: 'Delete — hides it, and its replies' },
  { keys: 'Z', description: 'Undo the last decision' },
  { keys: '1  2  3', description: 'Pending, spam, approved' },
  { keys: 'Esc', description: 'Dismiss the message bar' },
  { keys: '?', description: 'This sheet' },
]
