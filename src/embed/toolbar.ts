// The formatting toolbar, which is not an editor (#5).
//
// Each button wraps the reader's selection in Markdown inside a plain `<textarea>`.
// No `contenteditable`, no rich-text model, no paste handling — and, crucially, **no
// Markdown parser**. The only renderer in this project is the Worker's
// (src/render/markdown.ts), and a client-side one would be 10–40 KB against a 10 KB
// budget for the whole embed as well as a second implementation that disagrees with
// the first exactly when it matters.
//
// The whole of the behaviour is one pure string transform, so it is tested as one.
// Enforced by test/worker/embed/toolbar.test.ts.

export interface Wrap {
  /** Text placed before the selection, or the prefix put on each line. */
  before: string
  /** Text placed after the selection. Empty for a line-prefix item. */
  after: string
  /** Selected for the reader to type over when they had selected nothing. */
  placeholder: string
  /** Whether this marks up whole lines (`>`, `- `) rather than a span. */
  lines?: true
}

export interface ToolbarItem {
  /** Stable identifier, used as the button's `data-wrap` and by the tests. */
  name: string
  /** The visible text on the button. Words rather than icons: no glyph bytes. */
  label: string
  /** The accessible name and the tooltip. */
  title: string
  wrap: Wrap
}

/**
 * Exactly the Markdown src/render/markdown.ts renders, and nothing else.
 *
 * A button that emits syntax the Worker does not support shows the reader their own
 * asterisks back on a page they cannot edit — worse than the button not existing.
 * Headings, images, tables and underscores are all deliberately absent because the
 * renderer leaves them as literal text.
 */
export const TOOLBAR_ITEMS: readonly ToolbarItem[] = [
  {
    name: 'bold',
    label: 'B',
    title: 'Bold',
    wrap: { before: '**', after: '**', placeholder: 'bold text' },
  },
  {
    name: 'italic',
    label: 'I',
    title: 'Italic',
    wrap: { before: '*', after: '*', placeholder: 'italic text' },
  },
  {
    name: 'code',
    label: 'Code',
    title: 'Code',
    wrap: { before: '`', after: '`', placeholder: 'code' },
  },
  {
    name: 'link',
    label: 'Link',
    title: 'Link',
    wrap: { before: '[', after: '](https://)', placeholder: 'link text' },
  },
  {
    name: 'quote',
    label: 'Quote',
    title: 'Quote',
    wrap: { before: '> ', after: '', placeholder: 'quoted text', lines: true },
  },
  {
    name: 'list',
    label: 'List',
    title: 'Bulleted list',
    wrap: { before: '- ', after: '', placeholder: 'list item', lines: true },
  },
]

export interface WrapResult {
  value: string
  start: number
  end: number
}

/** The bounds of every whole line the selection touches. */
function lineBounds(value: string, from: number, to: number): { from: number; to: number } {
  const start = value.lastIndexOf('\n', from - 1) + 1
  const newline = value.indexOf('\n', to)
  return { from: start, to: newline === -1 ? value.length : newline }
}

function togglePrefix(block: string, prefix: string): string {
  const lines = block.split('\n')
  // Removed only when *every* line already carries it. A mixed selection is a
  // reader asking for all of it to be quoted, not for half of it to be unquoted.
  const allPrefixed = lines.every((line) => line.startsWith(prefix))
  return lines.map((line) => (allPrefixed ? line.slice(prefix.length) : prefix + line)).join('\n')
}

/**
 * Applies one toolbar item to a textarea's value and selection.
 *
 * Returns the new value and the selection to restore, because leaving the caret
 * where the browser left it puts it in the middle of the syntax the reader did not
 * type. The wrapped text stays selected: pressing Bold then Italic nests, which is
 * what a person expects, and pressing Bold twice removes it again.
 *
 * A selection that arrives back to front — some engines report
 * `selectionStart > selectionEnd` after a right-to-left drag — is normalised rather
 * than sliced, which would otherwise silently delete the body of the comment.
 */
export function applyWrap(value: string, start: number, end: number, wrap: Wrap): WrapResult {
  const from = Math.max(0, Math.min(value.length, Math.min(start, end)))
  const to = Math.max(0, Math.min(value.length, Math.max(start, end)))

  if (wrap.lines === true) {
    const bounds = lineBounds(value, from, to)
    const block = value.slice(bounds.from, bounds.to)
    const replaced = togglePrefix(block === '' ? wrap.placeholder : block, wrap.before)
    return {
      value: value.slice(0, bounds.from) + replaced + value.slice(bounds.to),
      start: bounds.from,
      end: bounds.from + replaced.length,
    }
  }

  const selected = value.slice(from, to)

  // Already wrapped: take the markers off rather than adding a second pair.
  const before = value.slice(Math.max(0, from - wrap.before.length), from)
  const after = value.slice(to, to + wrap.after.length)
  if (selected !== '' && before === wrap.before && after === wrap.after) {
    const unwrappedFrom = from - wrap.before.length
    return {
      value: value.slice(0, unwrappedFrom) + selected + value.slice(to + wrap.after.length),
      start: unwrappedFrom,
      end: unwrappedFrom + selected.length,
    }
  }

  const inner = selected === '' ? wrap.placeholder : selected
  return {
    value: value.slice(0, from) + wrap.before + inner + wrap.after + value.slice(to),
    start: from + wrap.before.length,
    end: from + wrap.before.length + inner.length,
  }
}
