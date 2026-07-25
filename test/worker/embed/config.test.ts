// What the site owner writes in their HTML, and what the embed makes of it.
//
// Every value here arrives from the host page, so it is the owner's input rather
// than a reader's — but it still decides which origin the widget will talk to, and
// a base URL that is not http(s) is a way to point the widget somewhere it should
// not go. Parsed, not trusted.

import { describe, expect, it } from 'vitest'
import { readConfig } from '../../../src/embed/config'

function attrs(values: Record<string, string>): (name: string) => string | null {
  return (name) => values[name] ?? null
}

describe('where the widget talks to', () => {
  it('defaults to wherever embed.js was served from', () => {
    // The one-line snippet the owner pastes names the deployment once, in the
    // script src. Asking for it twice is a way for the two to disagree.
    const result = readConfig(attrs({}), 'https://charcha.example.workers.dev/embed.js')
    expect(result.ok && result.config.api).toBe('https://charcha.example.workers.dev')
  })

  it('keeps the path when the Worker is routed at a subpath', () => {
    const result = readConfig(attrs({}), 'https://maya.build/charcha/embed.js')
    expect(result.ok && result.config.api).toBe('https://maya.build/charcha')
  })

  it('ignores the cache-busting query a host may have added to the script src', () => {
    const result = readConfig(attrs({}), 'https://c.example/embed.js?v=3')
    expect(result.ok && result.config.api).toBe('https://c.example')
  })

  it('lets the owner name it explicitly', () => {
    const result = readConfig(attrs({ 'data-api': 'https://c.example/' }), null)
    expect(result.ok && result.config.api).toBe('https://c.example')
  })

  it('refuses a base that is not http or https', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'not a url']) {
      const result = readConfig(attrs({ 'data-api': bad }), null)
      expect(result.ok, bad).toBe(false)
    }
  })

  it('says so, rather than failing silently, when it cannot tell', () => {
    const result = readConfig(attrs({}), null)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message.length).toBeGreaterThan(10)
  })
})

describe('the styling mode', () => {
  it('is inherit unless the owner says otherwise', () => {
    const result = readConfig(attrs({}), 'https://c.example/embed.js')
    expect(result.ok && result.config.styles).toBe('inherit')
  })

  it('takes the three documented values', () => {
    for (const mode of ['inherit', 'tokens', 'bare'] as const) {
      const result = readConfig(attrs({ 'data-styles': mode }), 'https://c.example/embed.js')
      expect(result.ok && result.config.styles).toBe(mode)
    }
  })

  it('falls back to inherit on a value it does not know', () => {
    // A typo in `data-styles` should leave the widget styled, not naked. Bare has
    // to be asked for by name.
    const result = readConfig(attrs({ 'data-styles': 'bear' }), 'https://c.example/embed.js')
    expect(result.ok && result.config.styles).toBe('inherit')
  })
})

describe('how the widget learns that Turnstile is configured', () => {
  it('is off unless the owner named a sitekey, so the third-party script never loads', () => {
    // Cloudflare's script is a third-party script on somebody else's page, which is
    // the thing Charcha otherwise avoids entirely. Nothing speculative (#79).
    const result = readConfig(attrs({}), 'https://c.example/embed.js')
    expect(result.ok && result.config.turnstileSitekey).toBe(null)
  })

  it('takes the sitekey from the owner’s own attribute', () => {
    const result = readConfig(
      attrs({ 'data-turnstile-sitekey': ' 0x4AAAAAAADnPIDROrmt1Wwj ' }),
      'https://c.example/embed.js',
    )
    expect(result.ok && result.config.turnstileSitekey).toBe('0x4AAAAAAADnPIDROrmt1Wwj')
  })

  it('treats a blank attribute as not configured', () => {
    const result = readConfig(
      attrs({ 'data-turnstile-sitekey': '   ' }),
      'https://c.example/embed.js',
    )
    expect(result.ok && result.config.turnstileSitekey).toBe(null)
  })

  it('refuses an absurd value rather than handing it to a third party', () => {
    const result = readConfig(
      attrs({ 'data-turnstile-sitekey': 'x'.repeat(200) }),
      'https://c.example/embed.js',
    )
    expect(result.ok && result.config.turnstileSitekey).toBe(null)
  })

  it('does not stop the widget loading when the sitekey is unusable', () => {
    // Comments are the point; the spam layer is configuration. A bad attribute must
    // leave a working conversation, not a blank space where one was.
    const result = readConfig(
      attrs({ 'data-turnstile-sitekey': 'x'.repeat(200) }),
      'https://c.example/embed.js',
    )
    expect(result.ok).toBe(true)
  })
})

describe('the thread override', () => {
  it('is absent by default, so the page address is identity', () => {
    const result = readConfig(attrs({}), 'https://c.example/embed.js')
    expect(result.ok && result.config.thread).toBe(null)
  })

  it('is passed along untouched, because the Worker is what validates it', () => {
    // src/page-key.ts is the only thing that turns this into a key, and it
    // re-validates. The embed narrowing it here would be a second, weaker copy of
    // that rule that the two could drift apart on.
    const result = readConfig(attrs({ 'data-thread': ' leaving ' }), 'https://c.example/embed.js')
    expect(result.ok && result.config.thread).toBe('leaving')
  })

  it('treats an empty override as no override', () => {
    const result = readConfig(attrs({ 'data-thread': '  ' }), 'https://c.example/embed.js')
    expect(result.ok && result.config.thread).toBe(null)
  })
})
