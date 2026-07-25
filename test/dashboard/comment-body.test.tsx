// The XSS test for the one place this dashboard inserts HTML.
//
// A moderation queue puts attacker-chosen text in front of the one authenticated
// session on the deployment — the session that can delete every comment on the site.
// So this file is the security test for #13, and it is written against the DOM the
// browser actually built rather than against the string the renderer returned: the
// question is not "did escaping happen" but "is there a script element on this page".
//
// Kill-shot: replace `renderMarkdown(body)` in src/dashboard/components/comment-body.tsx
// with `body` and every test below fails. Recorded on the PR for #13.

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CommentBody } from '../../src/dashboard/components/comment-body'
import './harness'

function renderBody(body: string): HTMLElement {
  const { container } = render(<CommentBody body={body} />)
  return container
}

describe('CommentBody', () => {
  it('renders the Markdown subset src/render supports', () => {
    const container = renderBody('Hello **world**\n\n- one\n- two')
    expect(container.querySelector('strong')?.textContent).toBe('world')
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })

  it('puts no script element on the page, whatever the body says', () => {
    const container = renderBody('<script>alert(1)</script>')
    expect(container.querySelector('script')).toBeNull()
    // The tag survives as text, which is the correct outcome: the commenter typed it.
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('puts no img element on the page, so there is no onerror to fire', () => {
    const container = renderBody('<img src=x onerror=alert(1)>')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('onerror')
  })

  it('emits no element with an inline event handler', () => {
    const container = renderBody('<div onmouseover="alert(1)">hover</div>')
    for (const element of container.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        expect(attribute.name.toLowerCase().startsWith('on')).toBe(false)
      }
    }
  })

  it('refuses a javascript: link, leaving the syntax as text', () => {
    const container = renderBody('[click](javascript:alert(1))')
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('javascript:alert(1)')
  })

  it('refuses a data: link', () => {
    const container = renderBody('[x](data:text/html,<script>alert(1)</script>)')
    expect(container.querySelector('a')).toBeNull()
  })

  it('allows an http link, and marks it up the way the reader-facing page does', () => {
    const container = renderBody('[docs](https://example.com/a)')
    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com/a')
    expect(link?.getAttribute('rel')).toBe('nofollow ugc noopener noreferrer')
  })

  it('cannot be made to break out of an attribute', () => {
    const container = renderBody('[x](https://example.com/" onmouseover="alert(1))')
    // Either the URL is refused or the quote is an entity — never a second attribute.
    const link = container.querySelector('a')
    expect(link?.getAttribute('onmouseover') ?? null).toBeNull()
  })

  it('emits nothing outside the vocabulary src/render declares', () => {
    // The same list test/worker/render/vocabulary.test.ts asserts on the server. It is
    // repeated here because this component is a *second* consumer of that renderer, and
    // the property that matters is about the DOM this page ends up with.
    const allowed = new Set([
      'DIV',
      'P',
      'BR',
      'STRONG',
      'EM',
      'CODE',
      'PRE',
      'BLOCKQUOTE',
      'UL',
      'LI',
      'A',
    ])
    const container = renderBody(
      [
        '<script>x</script>',
        '<iframe src="https://evil.test"></iframe>',
        '# heading',
        '> quoted',
        '- item',
        '```',
        'code',
        '```',
        '`inline`',
        '**bold** *italic*',
        '[link](https://example.com)',
        '<svg onload=alert(1)>',
        '<style>body{display:none}</style>',
      ].join('\n'),
    )
    for (const element of container.querySelectorAll('*')) {
      expect(allowed.has(element.tagName), element.tagName).toBe(true)
    }
  })
})
