// The toolbar is not an editor (#5). Each button wraps the selection in Markdown
// inside a plain textarea — no contenteditable, no rich-text model, and no Markdown
// parser anywhere in the embed. So the whole of its behaviour is this one pure
// string transform, and it is tested as one.

import { describe, expect, it } from 'vitest'
import { TOOLBAR_ITEMS, applyWrap } from '../../../src/embed/toolbar'

function itemNamed(name: string) {
  const item = TOOLBAR_ITEMS.find((candidate) => candidate.name === name)
  if (item === undefined) throw new Error(`no toolbar item named ${name}`)
  return item
}

describe('wrapping a selection', () => {
  it('wraps what the reader selected', () => {
    const result = applyWrap('hello world', 6, 11, itemNamed('bold').wrap)
    expect(result.value).toBe('hello **world**')
  })

  it('leaves the wrapped text selected, so the next click nests instead of undoing', () => {
    const result = applyWrap('hello world', 6, 11, itemNamed('bold').wrap)
    expect(result.value.slice(result.start, result.end)).toBe('world')
  })

  it('inserts a placeholder when nothing is selected, and selects it', () => {
    // An empty **|** leaves the reader looking at four asterisks wondering what
    // happened. A selected placeholder is a prompt they can type straight over.
    const result = applyWrap('', 0, 0, itemNamed('link').wrap)
    expect(result.value).toContain('](https://)')
    expect(result.value.slice(result.start, result.end).length).toBeGreaterThan(0)
  })

  it('unwraps a selection that is already wrapped', () => {
    // Bold on bold text is how a person expects a toolbar to behave, and without
    // it the only way back is to hunt the asterisks down by hand.
    // "world" sits at 8..13, inside the markers the reader is asking to remove.
    const result = applyWrap('hello **world**', 8, 13, itemNamed('bold').wrap)
    expect(result.value).toBe('hello world')
    expect(result.value.slice(result.start, result.end)).toBe('world')
  })

  it('handles a selection given back to front', () => {
    // Dragging right-to-left in a textarea can report selectionStart > selectionEnd
    // in some engines; a naive slice then silently drops the body of the comment.
    const result = applyWrap('hello world', 11, 6, itemNamed('italic').wrap)
    expect(result.value).toBe('hello *world*')
  })

  it('clamps a selection that runs past the end of the text', () => {
    const result = applyWrap('hi', 0, 99, itemNamed('code').wrap)
    expect(result.value).toBe('`hi`')
  })
})

describe('line-prefix items', () => {
  it('prefixes every selected line rather than wrapping the block once', () => {
    const result = applyWrap('one\ntwo', 0, 7, itemNamed('quote').wrap)
    expect(result.value).toBe('> one\n> two')
  })

  it('prefixes the line the cursor is on when nothing is selected', () => {
    const result = applyWrap('one\ntwo', 5, 5, itemNamed('list').wrap)
    expect(result.value).toBe('one\n- two')
  })

  it('removes the prefix from lines that already carry it', () => {
    const result = applyWrap('- one\n- two', 0, 11, itemNamed('list').wrap)
    expect(result.value).toBe('one\ntwo')
  })
})

describe('the toolbar contract', () => {
  it('only emits Markdown the Worker actually renders', () => {
    // src/render/markdown.ts supports exactly: **bold**, *italic*, `code`,
    // > quote, - list and [text](url). A button that emits anything else is a
    // button that shows the reader their own asterisks back.
    const emitted = TOOLBAR_ITEMS.map((item) => item.wrap.before + item.wrap.after).join('')
    expect(emitted).not.toMatch(/[#_~|]/)
  })

  it('gives every button a name a screen reader can read out', () => {
    for (const item of TOOLBAR_ITEMS) {
      expect(item.label.length, item.name).toBeGreaterThan(0)
      expect(item.title.length, item.name).toBeGreaterThan(2)
    }
  })

  it('has no two buttons with the same name', () => {
    expect(new Set(TOOLBAR_ITEMS.map((item) => item.name)).size).toBe(TOOLBAR_ITEMS.length)
  })
})
