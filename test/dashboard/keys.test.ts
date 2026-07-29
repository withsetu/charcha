// The shortcut map, and the guard the brief names as the commonest bug in this class
// of UI.
//
// The guard is exercised twice on purpose: here against every kind of target, because
// this is the only place `role="textbox"` and a `contenteditable` descendant can be
// constructed at all, and again in shortcuts.test.tsx against the real password field
// on the real surface — because a guard tested only in isolation cannot show that
// anything is wired to it.

import { describe, expect, it } from 'vitest'

import { SHORTCUTS, isEditableTarget, resolveCommand } from '../../src/dashboard/keys'
import type { KeyStroke } from '../../src/dashboard/keys'
import { TAB_VALUES } from '../../src/dashboard/queue'

function stroke(key: string, overrides: Partial<KeyStroke> = {}): KeyStroke {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    ...overrides,
  }
}

describe('isEditableTarget', () => {
  it('is false for a non-element target, which owns no keys', () => {
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(document)).toBe(false)
  })

  it.each(['input', 'textarea', 'select'])('is true for a <%s>', (tag) => {
    expect(isEditableTarget(document.createElement(tag))).toBe(true)
  })

  it('is true for a password field, which is the editable this surface has today', () => {
    const field = document.createElement('input')
    field.type = 'password'
    expect(isEditableTarget(field)).toBe(true)
  })

  it('is false for a button, which is focusable but not editable', () => {
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
  })

  it('is true for a contenteditable element', () => {
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    document.body.append(editor)
    try {
      expect(isEditableTarget(editor)).toBe(true)
    } finally {
      editor.remove()
    }
  })

  it('is true inside a contenteditable ancestor, where the attribute is not on the target', () => {
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    const inner = document.createElement('span')
    editor.append(inner)
    document.body.append(editor)
    try {
      expect(inner.hasAttribute('contenteditable')).toBe(false)
      expect(isEditableTarget(inner)).toBe(true)
    } finally {
      editor.remove()
    }
  })

  it('is true for role="textbox", which is how a custom editor says the same thing', () => {
    const editor = document.createElement('div')
    editor.setAttribute('role', 'textbox')
    expect(isEditableTarget(editor)).toBe(true)
  })
})

describe('resolveCommand', () => {
  it('maps movement to both the letter and the arrow', () => {
    expect(resolveCommand(stroke('j'))).toEqual({ kind: 'move', delta: 1 })
    expect(resolveCommand(stroke('ArrowDown'))).toEqual({ kind: 'move', delta: 1 })
    expect(resolveCommand(stroke('k'))).toEqual({ kind: 'move', delta: -1 })
    expect(resolveCommand(stroke('ArrowUp'))).toEqual({ kind: 'move', delta: -1 })
  })

  it('maps the three decisions', () => {
    expect(resolveCommand(stroke('a'))).toEqual({ kind: 'decide', status: 'approved' })
    expect(resolveCommand(stroke('s'))).toEqual({ kind: 'decide', status: 'spam' })
    expect(resolveCommand(stroke('d'))).toEqual({ kind: 'decide', status: 'deleted' })
  })

  it('maps undo, help, dismiss and the four tabs', () => {
    expect(resolveCommand(stroke('z'))).toEqual({ kind: 'undo' })
    expect(resolveCommand(stroke('?', { shiftKey: true }))).toEqual({ kind: 'help' })
    expect(resolveCommand(stroke('Escape'))).toEqual({ kind: 'dismiss' })
    expect(resolveCommand(stroke('1'))).toEqual({ kind: 'tab', index: 0 })
    expect(resolveCommand(stroke('2'))).toEqual({ kind: 'tab', index: 1 })
    expect(resolveCommand(stroke('3'))).toEqual({ kind: 'tab', index: 2 })
    // Setup (#158). By index, into TAB_VALUES in src/dashboard/queue.ts — this map is
    // pure and knows nothing about which tab that is.
    expect(resolveCommand(stroke('4'))).toEqual({ kind: 'tab', index: 3 })
  })

  it('gives every tab a key, so none of them is reachable only by mouse', () => {
    // The pairing #13's brief asks for, asserted rather than assumed: a fifth tab added
    // without a digit for it fails here instead of being quietly mouse-only.
    for (const [index] of TAB_VALUES.entries()) {
      expect(resolveCommand(stroke(String(index + 1))), String(index + 1)).toEqual({
        kind: 'tab',
        index,
      })
    }
  })

  it('ignores a key it has no binding for', () => {
    for (const key of ['q', 'x', 'r', 'Enter', ' ', 'F5', '9']) {
      expect(resolveCommand(stroke(key)), key).toBeNull()
    }
  })

  // The guard, at the level the map owns it.
  it('refuses every binding when the target is a textarea', () => {
    const box = document.createElement('textarea')
    for (const key of ['a', 's', 'd', 'j', 'k', 'z', '1', 'Escape', '?']) {
      expect(resolveCommand(stroke(key, { target: box, shiftKey: key === '?' })), key).toBeNull()
    }
  })

  it('refuses every binding when the target is the password field', () => {
    const field = document.createElement('input')
    field.type = 'password'
    // The password most likely to catch this: it is made only of bound keys.
    for (const key of [...'sadjkz123']) {
      expect(resolveCommand(stroke(key, { target: field })), key).toBeNull()
    }
  })

  it('leaves the browser and the operating system their modifiers', () => {
    // Without this, Cmd+A approves instead of selecting the page and Ctrl+S marks
    // spam instead of saving.
    expect(resolveCommand(stroke('a', { metaKey: true }))).toBeNull()
    expect(resolveCommand(stroke('s', { ctrlKey: true }))).toBeNull()
    expect(resolveCommand(stroke('d', { altKey: true }))).toBeNull()
    expect(resolveCommand(stroke('j', { ctrlKey: true }))).toBeNull()
  })

  it('refuses a keystroke that is part of an IME composition', () => {
    // An IME composing kana emits Latin `key` values; acting on them would approve a
    // comment while somebody types Japanese.
    expect(resolveCommand(stroke('s', { isComposing: true }))).toBeNull()
    expect(resolveCommand(stroke('a', { isComposing: true }))).toBeNull()
  })

  it('refuses Shift for everything except ?', () => {
    expect(resolveCommand(stroke('A', { shiftKey: true }))).toBeNull()
    expect(resolveCommand(stroke('S', { shiftKey: true }))).toBeNull()
    expect(resolveCommand(stroke('?', { shiftKey: true }))).toEqual({ kind: 'help' })
  })

  it('still works with Caps Lock on, where the key is upper case and Shift is not held', () => {
    // A case-sensitive map would drop these and the whole surface would look broken to
    // anyone with Caps Lock on, with nothing reporting why.
    expect(resolveCommand(stroke('A'))).toEqual({ kind: 'decide', status: 'approved' })
    expect(resolveCommand(stroke('J'))).toEqual({ kind: 'move', delta: 1 })
  })
})

describe('SHORTCUTS', () => {
  it('documents a description for every row and repeats no key', () => {
    const keys = SHORTCUTS.map((shortcut) => shortcut.keys)
    expect(new Set(keys).size).toBe(keys.length)
    for (const shortcut of SHORTCUTS) expect(shortcut.description).not.toBe('')
  })

  it('does not advertise a binding the map does not have', () => {
    // The sheet is the contract the owner learns. A row for `X` or `R` here would be
    // a promise nothing keeps — both are deferred, and neither is listed.
    const advertised = SHORTCUTS.map((shortcut) => shortcut.keys).join(' ')
    expect(advertised).not.toMatch(/\bX\b/)
    expect(advertised).not.toMatch(/\bR\b/)
  })
})
