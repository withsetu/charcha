// The embed's half of layer 3 (#79). The server half is test/worker/spam/turnstile.test.ts.
//
// Everything with a decision in it lives in src/embed/turnstile.ts as a gate that is
// handed Cloudflare's API rather than reaching for `window`, so the whole lifecycle —
// render, expiry, refresh, single use, failure — is exercised here in workerd against
// a fake API, with no DOM and no network.
//
// What is left in mount.ts is the script tag and the wiring, which no test here
// reaches: it has no DOM environment until #91. It is covered by driving the real
// widget in a real browser against real endpoints instead (card rule 3), and that is
// how the `turnstile.ready()` regression pinned below was found.

import { describe, expect, it, vi } from 'vitest'
import {
  TOKEN_LIFETIME_MS,
  TOKEN_REFRESH_AFTER_MS,
  TURNSTILE_ONLOAD_GLOBAL,
  createTurnstileGate,
  renderParameters,
  tokenAction,
  turnstileScriptUrl,
} from '../../../src/embed/turnstile'
import type { TurnstileApi } from '../../../src/embed/turnstile'

/**
 * A stand-in for `window.turnstile`, which hands the widget's callbacks straight
 * back to the test so a token, an expiry or an error can be delivered on demand.
 */
function fakeTurnstile() {
  const state = {
    rendered: 0,
    resets: 0,
    parameters: {} as Record<string, unknown>,
    expired: false,
  }

  const api: TurnstileApi = {
    render(_container, parameters) {
      state.rendered += 1
      state.parameters = parameters
      return `widget-${state.rendered}`
    },
    reset() {
      state.resets += 1
      state.expired = false
    },
    isExpired() {
      return state.expired
    },
  }

  function fire(name: string, argument?: string): void {
    const handler = state.parameters[name]
    if (typeof handler === 'function') (handler as (value?: string) => void)(argument)
  }

  return { api, state, fire }
}

/** A gate wired to a clock the test controls and a wait short enough to sit through. */
function gateWith(options: { now?: () => number; waitMs?: number } = {}) {
  const container = { id: 'container' }
  const gate = createTurnstileGate({
    container,
    sitekey: '0x4AAAAAAADnPIDROrmt1Wwj',
    now: options.now ?? (() => 0),
    waitMs: options.waitMs ?? 25,
  })
  return { gate, container }
}

describe('what Cloudflare documents, frozen', () => {
  it('asks for the explicit-rendering build of Cloudflare’s own script', () => {
    // https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
    // Explicit rendering is what lets the widget be created inside the composer at
    // the moment the owner has configured it, rather than by a class name Cloudflare
    // scans the whole page for.
    expect(turnstileScriptUrl(TURNSTILE_ONLOAD_GLOBAL)).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit' +
        '&onload=__charchaTurnstileOnload',
    )
  })

  it('waits for onload rather than turnstile.ready(), which throws on an async tag', () => {
    // A regression, found by driving it: `turnstile.ready()` against an async/defer
    // script tag throws `TurnstileError: [Cloudflare Turnstile] Remove async/defer
    // from the Turnstile api.js script tag before using turnstile.ready()`. Thrown
    // inside a load listener it rejects nothing — the widget silently never renders
    // and every comment goes out with no token. `onload` is Cloudflare's documented
    // answer for an async script, and this is what stops a future edit going back.
    expect(turnstileScriptUrl(TURNSTILE_ONLOAD_GLOBAL)).toContain('onload=')
    // The name is prefixed, because it is a global on somebody else's page.
    expect(TURNSTILE_ONLOAD_GLOBAL.startsWith('__charcha')).toBe(true)
  })

  it('records the documented 300-second token lifetime and refreshes inside it', () => {
    // "Each token is valid for 300 seconds (5 minutes) after generation."
    // https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
    expect(TOKEN_LIFETIME_MS).toBe(300_000)
    // The margin is the whole point: a token handed over at 299 s is still valid
    // here and expired by the time siteverify sees it.
    expect(TOKEN_REFRESH_AFTER_MS).toBeLessThan(TOKEN_LIFETIME_MS)
    expect(TOKEN_REFRESH_AFTER_MS).toBeGreaterThan(TOKEN_LIFETIME_MS / 2)
  })

  it('spells every render option the way Cloudflare spells it', () => {
    // A typo in one of these is silent: the widget renders, the callback never
    // fires, and the whole expiry story is gone with nothing failing. The names are
    // from the widget-configurations reference, verified 2026-07-25.
    const parameters = renderParameters('sitekey-1', {
      onToken: () => {},
      onExpired: () => {},
      onError: () => {},
      onUnsupported: () => {},
    })

    expect(Object.keys(parameters).sort()).toEqual(
      [
        'appearance',
        'callback',
        'error-callback',
        'execution',
        'expired-callback',
        'refresh-expired',
        'retry',
        'sitekey',
        'size',
        'timeout-callback',
        'unsupported-callback',
      ].sort(),
    )
    expect(parameters['sitekey']).toBe('sitekey-1')
  })

  it('pins the three defaults the lifecycle actually leans on', () => {
    // Each of these is already Cloudflare's default, and each is load-bearing here:
    // the widget refreshing itself is what survives a form left open, the retry is
    // why an error-callback is not fatal, and running at render time is what puts a
    // token in hand before the reader finishes typing. A default is a third party's
    // to change, and all three would change behaviour silently.
    const parameters = renderParameters('sitekey-1', {
      onToken: () => {},
      onExpired: () => {},
      onError: () => {},
      onUnsupported: () => {},
    })
    expect(parameters['refresh-expired']).toBe('auto')
    expect(parameters['retry']).toBe('auto')
    expect(parameters['execution']).toBe('render')
  })
})

describe('the token decision', () => {
  it('waits when the widget has not produced a token yet', () => {
    expect(tokenAction({ token: null, issuedAt: 0, failed: false }, 0)).toBe('wait')
  })

  it('sends a fresh token', () => {
    expect(tokenAction({ token: 'abc', issuedAt: 0, failed: false }, 1_000)).toBe('send')
  })

  it('refreshes a token old enough to expire in flight', () => {
    const state = { token: 'abc', issuedAt: 0, failed: false }
    expect(tokenAction(state, TOKEN_REFRESH_AFTER_MS - 1)).toBe('send')
    expect(tokenAction(state, TOKEN_REFRESH_AFTER_MS)).toBe('refresh')
  })

  it('gives up rather than waiting when the widget cannot work at all', () => {
    // Not a security decision — the server still refuses a submission with no token
    // when the owner configured a secret (src/spam/turnstile.ts). This only decides
    // whether the reader is made to wait for something that is never coming.
    expect(tokenAction({ token: 'abc', issuedAt: 0, failed: true }, 0)).toBe('give-up')
  })
})

describe('the gate', () => {
  it('renders nothing until the script has actually loaded', () => {
    const { gate } = gateWith()
    const turnstile = fakeTurnstile()
    expect(turnstile.state.rendered).toBe(0)
    gate.start(turnstile.api)
    expect(turnstile.state.rendered).toBe(1)
  })

  it('renders into the container it was given, with the owner’s sitekey', () => {
    const { gate, container } = gateWith()
    const turnstile = fakeTurnstile()
    let seen: unknown = null
    gate.start({
      ...turnstile.api,
      render(target, parameters) {
        seen = target
        return turnstile.api.render(target, parameters)
      },
    })
    expect(seen).toBe(container)
    expect(turnstile.state.parameters['sitekey']).toBe('0x4AAAAAAADnPIDROrmt1Wwj')
  })

  it('holds the submission until the widget produces a token', async () => {
    const { gate } = gateWith()
    const turnstile = fakeTurnstile()
    gate.start(turnstile.api)

    const pending = gate.token()
    turnstile.fire('callback', 'token-1')
    await expect(pending).resolves.toBe('token-1')
  })

  it('never hands the same token over twice', async () => {
    // "Each token can only be validated once. A replayed token will be rejected with
    // the timeout-or-duplicate error code." Reusing one turns a second real comment
    // into a spam rejection.
    const { gate } = gateWith()
    const turnstile = fakeTurnstile()
    gate.start(turnstile.api)

    turnstile.fire('callback', 'token-1')
    await expect(gate.token()).resolves.toBe('token-1')
    expect(turnstile.state.resets).toBe(1)

    const second = gate.token()
    turnstile.fire('callback', 'token-2')
    await expect(second).resolves.toBe('token-2')
  })

  it('refreshes a stale token instead of posting it', async () => {
    let clock = 0
    const { gate } = gateWith({ now: () => clock })
    const turnstile = fakeTurnstile()
    gate.start(turnstile.api)
    turnstile.fire('callback', 'stale')

    clock = TOKEN_REFRESH_AFTER_MS
    const pending = gate.token()
    expect(turnstile.state.resets).toBe(1)
    turnstile.fire('callback', 'minted')
    await expect(pending).resolves.toBe('minted')
  })

  it('treats the widget’s own expiry as no token, and waits for the next one', async () => {
    const { gate } = gateWith()
    const turnstile = fakeTurnstile()
    gate.start(turnstile.api)
    turnstile.fire('callback', 'token-1')
    turnstile.fire('expired-callback')

    const pending = gate.token()
    turnstile.fire('callback', 'token-2')
    await expect(pending).resolves.toBe('token-2')
  })

  it('believes the widget over its own clock when it says the token is gone', async () => {
    const { gate } = gateWith()
    const turnstile = fakeTurnstile()
    gate.start(turnstile.api)
    turnstile.fire('callback', 'token-1')
    turnstile.state.expired = true

    const pending = gate.token()
    turnstile.fire('callback', 'token-2')
    await expect(pending).resolves.toBe('token-2')
  })

  it('does not write off a widget that is only retrying', async () => {
    // `retry` defaults to auto and the widget retries every 8 s, so an
    // error-callback is a setback rather than the end. Treating it as fatal would
    // stop asking for the token that was about to arrive.
    const { gate } = gateWith()
    const turnstile = fakeTurnstile()
    gate.start(turnstile.api)
    turnstile.fire('error-callback')

    const pending = gate.token()
    turnstile.fire('callback', 'recovered')
    await expect(pending).resolves.toBe('recovered')
  })

  it('stops waiting eventually, rather than hanging the Post button', async () => {
    const { gate } = gateWith({ waitMs: 10 })
    const turnstile = fakeTurnstile()
    gate.start(turnstile.api)
    await expect(gate.token()).resolves.toBe(null)
  })

  it('answers immediately, without a wait, once it has given up', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // A blocked challenges.cloudflare.com is the common case here, and it is
      // permanent for the life of the page: making the reader sit through the full
      // wait on every attempt buys nothing.
      const { gate } = gateWith({ waitMs: 10_000 })
      gate.giveUp('script blocked')
      await expect(gate.token()).resolves.toBe(null)
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('gives up rather than throwing when the widget cannot be created', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { gate } = gateWith({ waitMs: 10_000 })
      gate.start({
        render() {
          throw new Error('sitekey rejected')
        },
        reset() {},
      })
      // An exception escaping here would reach submit()'s catch and tell the reader
      // their comment could not be posted — without ever having tried to post it.
      await expect(gate.token()).resolves.toBe(null)
    } finally {
      error.mockRestore()
    }
  })

  it('gives up when the browser is one Turnstile does not support', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { gate } = gateWith({ waitMs: 10_000 })
      const turnstile = fakeTurnstile()
      gate.start(turnstile.api)
      turnstile.fire('unsupported-callback')
      await expect(gate.token()).resolves.toBe(null)
    } finally {
      error.mockRestore()
    }
  })

  it('posts without a token rather than refusing to post, when it has given up', async () => {
    // The embed decides nothing. src/spam/turnstile.ts rejects a token-less
    // submission when the owner configured a secret and abstains entirely when they
    // did not, so a half-configured deployment — sitekey set, secret not — still
    // takes comments instead of being bricked by the embed's own opinion.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { gate } = gateWith()
      gate.giveUp('blocked')
      expect(await gate.token()).toBe(null)
    } finally {
      error.mockRestore()
    }
  })
})
