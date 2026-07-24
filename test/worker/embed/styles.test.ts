// The default stylesheet names no colour and no typeface (#6). That is not a
// stylistic preference — it is what makes the widget dark exactly when the host is,
// with no toggle, no media query and nothing stored on the reader's machine
// (card rule 8). These tests are what stop a single convenient hex value from
// quietly ending that property.

import { describe, expect, it } from 'vitest'
import { OVERRIDABLE_TOKENS, stylesheet } from '../../../src/embed/styles'

const INHERIT = stylesheet('inherit')
const TOKENS = stylesheet('tokens')

/**
 * The CSS named colours a stylesheet is most likely to reach for, plus the two
 * that would look deliberate. Not the full 148: this is a tripwire on the habit,
 * and the hex/function assertions below cover the rest of the space.
 */
const NAMED_COLOURS = [
  'white',
  'black',
  'red',
  'blue',
  'green',
  'grey',
  'gray',
  'silver',
  'orange',
  'crimson',
  'tomato',
  'navy',
  'teal',
]

describe('the default stylesheet names no colour', () => {
  it('contains no hex colour', () => {
    expect(INHERIT).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  it('contains no colour function that carries a value of its own', () => {
    // `color-mix(in oklab, currentColor …)` is allowed and is the whole design:
    // it mixes the host's colour, it does not name one. A literal rgb()/hsl()/
    // oklch() does name one.
    expect(INHERIT).not.toMatch(/\b(rgba?|hsla?|hwb|lab|lch|oklch)\s*\(/)
  })

  it('contains no named colour keyword', () => {
    for (const colour of NAMED_COLOURS) {
      expect(INHERIT, `named colour ${colour}`).not.toMatch(
        new RegExp(`:\\s*${colour}\\b|,\\s*${colour}\\b`, 'i'),
      )
    }
  })

  it('mixes every surface out of the host page currentColor', () => {
    expect(INHERIT).toContain('currentColor')
    expect(INHERIT).toContain('color-mix(')
  })
})

describe('the default stylesheet names no typeface', () => {
  it('declares no font-family of its own', () => {
    // A widget that picks a font is a foreign object on the page. `font: inherit`
    // on the controls is the opposite: form controls otherwise fall back to the
    // UA's own font, which is the one place a host's typography does not reach.
    expect(INHERIT).not.toMatch(/font-family\s*:\s*(?!inherit)/)
    expect(INHERIT).not.toMatch(/\bfont-family\s*:\s*["']/)
  })

  it('sets no absolute font size', () => {
    expect(INHERIT).not.toMatch(/font-size\s*:\s*\d+px/)
    expect(INHERIT).not.toMatch(/font-size\s*:\s*\d+pt/)
  })
})

describe('box-sizing', () => {
  it('is set on the widget subtree, because the host may not have set it', () => {
    // Found by rendering it (#5): with the default content-box, an input at
    // width:100% plus padding overflows its grid column and the name and email
    // fields visibly overlap. The widget cannot inherit an assumption about this.
    expect(INHERIT).toMatch(
      /\.charcha-root\s*,\s*\.charcha-root\s*\*\s*\{[^}]*box-sizing\s*:\s*border-box/,
    )
  })
})

describe('the three styling modes', () => {
  it('bare sends no CSS at all', () => {
    // Bare is permission to drop Charcha's CSS entirely. An empty string, not a
    // reset and not a "minimal" sheet — either of those is Charcha still styling.
    expect(stylesheet('bare')).toBe('')
  })

  it('inherit and tokens both ship the default sheet', () => {
    expect(INHERIT.length).toBeGreaterThan(200)
    expect(TOKENS.startsWith(INHERIT)).toBe(true)
  })

  it('tokens adds an override hook for each of the twelve properties, and no more', () => {
    const overrides = TOKENS.slice(INHERIT.length)
    for (const token of OVERRIDABLE_TOKENS) {
      expect(overrides, `missing hook for ${token}`).toContain(`var(${token}`)
    }
    const hooks = overrides.match(/var\(--charcha-[a-z-]+/g) ?? []
    expect(new Set(hooks).size).toBe(OVERRIDABLE_TOKENS.length)
  })

  it('names twelve tokens, all prefixed', () => {
    expect(OVERRIDABLE_TOKENS.length).toBe(12)
    for (const token of OVERRIDABLE_TOKENS) expect(token.startsWith('--charcha-')).toBe(true)
  })

  it('leaves inherit unoverridable, which is what makes the mode mean something', () => {
    // #6's table: in `inherit` Charcha owns appearance; in `tokens` the owner does,
    // through twelve properties. If the base sheet already read var(--charcha-*),
    // the two modes would be the same CSS and the choice would be decorative.
    expect(INHERIT).not.toContain('var(--charcha-')
  })
})

describe('the stylesheet cannot be used to hide the honeypot', () => {
  it('never names the honeypot field', () => {
    // A spam guard a setting can switch off is not a guard (#6, #8) — bare mode
    // drops this sheet, so the hiding lives inline with the markup instead.
    for (const mode of ['inherit', 'tokens', 'bare'] as const) {
      expect(stylesheet(mode)).not.toContain('subject')
    }
  })
})
