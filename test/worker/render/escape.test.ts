import { describe, expect, it } from 'vitest'
import { escapeHtml } from '../../../src/render'

describe('escapeHtml', () => {
  it('turns the characters that open a tag into text', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('turns both attribute delimiters into text, so no value can be closed early', () => {
    expect(escapeHtml(`" onerror='alert(1)'`)).toBe('&quot; onerror=&#39;alert(1)&#39;')
  })

  it('escapes the ampersand, so an escape cannot be smuggled in already-written form', () => {
    expect(escapeHtml('&lt;img src=x onerror=alert(1)&gt;')).toBe(
      '&amp;lt;img src=x onerror=alert(1)&amp;gt;',
    )
  })

  it('escapes the ampersand first, so nothing is escaped twice', () => {
    // '&' -> '&amp;' must not then have its own '&' rewritten. A single pass
    // over the source is what guarantees escapeHtml(x) decodes back to x.
    expect(escapeHtml('&amp;')).toBe('&amp;amp;')
  })

  it('leaves text that needs no escaping exactly as it was', () => {
    expect(escapeHtml('Ordinary text — with an em dash, ünïcödé and 中文.')).toBe(
      'Ordinary text — with an em dash, ünïcödé and 中文.',
    )
  })

  it('escapes every occurrence, not only the first', () => {
    expect(escapeHtml('<<<')).toBe('&lt;&lt;&lt;')
  })
})
