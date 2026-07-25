// Layer 3's client half — the widget's lifecycle, not its transport (#79).
//
// Transport already worked: mount.ts serialises `cf-turnstile-response` when the
// page has one (#8). What was missing is everything around it — rendering the widget,
// keeping the token fresh, and knowing what to do when Cloudflare's script never
// arrives.
//
// Every fact below is from the API reference rather than memory (card rule 7),
// verified 2026-07-25:
//   https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
//   https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/
//   https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
//
// **The gate decides nothing about spam.** It is handed Cloudflare's API rather than
// reaching for `window`, so the whole lifecycle is testable in workerd
// (test/worker/embed/turnstile.test.ts) — and, more importantly, so that it is
// obvious by reading it that its only power is over *when the reader waits*. Whether
// a comment is accepted is src/spam/turnstile.ts's, on the server, every time.

/**
 * The one global Charcha puts on a host page, and only while the script is loading.
 *
 * `turnstile.ready()` is **not** an option here, and that is a measured fact rather
 * than a preference: called against an `async`/`defer` script tag it throws
 * `TurnstileError: [Cloudflare Turnstile] Remove async/defer from the Turnstile
 * api.js script tag before using turnstile.ready()`. Thrown from inside a `load`
 * listener it rejects nothing and stops nothing — the widget silently never renders
 * and every comment is posted without a token. The `onload` query parameter is
 * Cloudflare's own answer for an async script, and it costs this one name, which
 * mount.ts deletes the moment it fires.
 */
export const TURNSTILE_ONLOAD_GLOBAL = '__charchaTurnstileOnload'

/**
 * Cloudflare's script, asking for explicit rendering and an onload callback.
 *
 * Explicit rather than implicit because the widget belongs inside Charcha's own
 * composer, which does not exist when the script loads. Implicit rendering scans the
 * host page for `.cf-turnstile`, which would make the owner place a container
 * themselves — the thing this issue exists to stop.
 *
 * It is a third-party script on somebody else's page, so it is fetched **only** when
 * the owner set `data-turnstile-sitekey`, and never speculatively (#79).
 * Enforced by test/worker/embed/turnstile.test.ts.
 */
export function turnstileScriptUrl(onloadGlobal: string): string {
  return `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=${onloadGlobal}`
}

/** "Each token is valid for 300 seconds (5 minutes) after generation." */
export const TOKEN_LIFETIME_MS = 300_000

/**
 * How long a token may be held before this gate mints a new one instead of sending it.
 *
 * The margin is not caution, it is the round trip: a token read at 299 s is valid in
 * the embed and expired by the time siteverify sees it, and the reader is told their
 * comment could not be posted for something they did not do. Thirty seconds covers a
 * slow upload of a long comment with room to spare.
 * Enforced by test/worker/embed/turnstile.test.ts.
 */
export const TOKEN_REFRESH_MARGIN_MS = 30_000
export const TOKEN_REFRESH_AFTER_MS = TOKEN_LIFETIME_MS - TOKEN_REFRESH_MARGIN_MS

/**
 * How long the Post button will wait for a token before posting without one.
 *
 * The same five seconds the server gives siteverify (src/spam/turnstile.ts): it is
 * the outer edge of what somebody holding down a button reads as "working".
 */
export const TOKEN_WAIT_MS = 5_000

/** The part of `window.turnstile` this file uses. Names are Cloudflare's. */
export interface TurnstileApi {
  render(container: unknown, parameters: Record<string, unknown>): string | undefined | null
  reset(widgetId: string): void
  isExpired?(widgetId: string): boolean
  // `ready` is deliberately absent, so that nothing here can reach for it. See
  // TURNSTILE_ONLOAD_GLOBAL: it throws against the async script tag this embed uses.
}

/**
 * Properties rather than methods, deliberately: these are handed to Cloudflare's
 * script, which calls them detached from this object, and the property form is the
 * one that says so in the type.
 */
export interface TurnstileHandlers {
  onToken: (token: string) => void
  onExpired: () => void
  onError: () => void
  onUnsupported: () => void
}

/**
 * The options `turnstile.render` is called with.
 *
 * Built here, as data, so the option names are frozen by a test rather than by
 * proofreading. A typo in one of them fails silently in the worst possible way: the
 * widget still renders, the callback never fires, and the token lifecycle this file
 * exists for is gone with nothing to notice it.
 * Enforced by test/worker/embed/turnstile.test.ts.
 *
 * Five values are chosen rather than defaulted. The first three are *already* the
 * documented defaults and are pinned anyway, because each is a load-bearing part of
 * this file's design and a default is a third party's to change:
 *
 * - `refresh-expired: auto` — the widget healing itself in the background is what
 *   makes a form left open for an hour still postable.
 * - `retry: auto` — the whole reason `onError` does not give up is that the widget
 *   tries again on its own. Were this off, an error would strand the gate until the
 *   wait expired, on every submission.
 * - `execution: render` — the challenge runs when the widget is created rather than
 *   when it is asked for a token, which is what puts a token in hand before the
 *   reader has finished typing.
 * - `appearance: interaction-only` — "the widget becomes visible only when visitor
 *   interaction is required". Charcha's widget names no colour and puts no branding
 *   on the host page (#6); a permanent Cloudflare box in the composer is the one
 *   piece of visible chrome the design has no room for. The challenge still runs at
 *   render time, so the token is minted while the reader is typing either way.
 * - `size: flexible` — "100% (min: 300px)". `normal` is a fixed 300px, which
 *   overflows a narrow host column, and the widget cannot see the host's layout.
 */
export function renderParameters(
  sitekey: string,
  handlers: TurnstileHandlers,
): Record<string, unknown> {
  return {
    sitekey,
    callback: handlers.onToken,
    'expired-callback': handlers.onExpired,
    // "invoked when the challenge presents an interactive challenge but was not
    // solved within a given time" — from here, indistinguishable from an expiry:
    // there is no token and the widget is getting another.
    'timeout-callback': handlers.onExpired,
    'error-callback': handlers.onError,
    'unsupported-callback': handlers.onUnsupported,
    'refresh-expired': 'auto',
    retry: 'auto',
    execution: 'render',
    appearance: 'interaction-only',
    size: 'flexible',
  }
}

export interface TokenState {
  token: string | null
  /** When `token` arrived, on the clock the gate was given. */
  issuedAt: number
  /** The widget cannot produce a token at all — not that this one is late. */
  failed: boolean
}

export type TokenAction = 'send' | 'refresh' | 'wait' | 'give-up'

/**
 * What to do about the token, at the moment the reader presses Post.
 *
 * The order is the design. `give-up` first, because a reader whose browser blocked
 * challenges.cloudflare.com must not sit through the wait on every attempt for
 * something that is never coming.
 */
export function tokenAction(state: TokenState, now: number): TokenAction {
  if (state.failed) return 'give-up'
  if (state.token === null) return 'wait'
  return now - state.issuedAt >= TOKEN_REFRESH_AFTER_MS ? 'refresh' : 'send'
}

export interface TurnstileGate {
  /** Renders the widget. Called once Cloudflare's script has loaded. */
  start(api: TurnstileApi): void
  /** No token will ever be produced — the script was blocked, or the browser is unsupported. */
  giveUp(reason: string): void
  /** The token to post with, or null when there is none to be had. */
  token(): Promise<string | null>
}

export interface TurnstileGateOptions {
  /** Passed straight to `turnstile.render`; the gate never touches it. */
  container: unknown
  /** The owner's sitekey. Public by design — it appears in the page on every Turnstile site. */
  sitekey: string
  now?: () => number
  waitMs?: number
}

export function createTurnstileGate(options: TurnstileGateOptions): TurnstileGate {
  const now = options.now ?? (() => performance.now())
  const waitMs = options.waitMs ?? TOKEN_WAIT_MS

  const state: TokenState = { token: null, issuedAt: 0, failed: false }
  let api: TurnstileApi | null = null
  let widgetId: string | null = null
  let waiters: (() => void)[] = []

  function notify(): void {
    const waiting = waiters
    waiters = []
    for (const wake of waiting) wake()
  }

  function giveUp(reason: string): void {
    state.failed = true
    state.token = null
    // The owner's signal, and the only one there is: a widget that never renders is
    // invisible from the server, and the reader's comment simply starts being
    // refused. CLAUDE.md — a layer that fails quietly is worse than one that is off.
    // Worded as the outcome rather than the mechanism: with a secret configured, a
    // token-less submission is a hard reject, so this is comments being lost.
    console.error(
      'charcha: Turnstile produced no token, so comments will be refused if this' +
        ' deployment has TURNSTILE_SECRET_KEY set —',
      reason,
    )
    notify()
  }

  function resetWidget(): void {
    if (api === null || widgetId === null) return
    try {
      api.reset(widgetId)
    } catch (error) {
      // Never let this reach submit()'s catch, which would tell the reader their
      // comment could not be posted without ever having tried to post it.
      giveUp(`reset threw: ${String(error)}`)
    }
  }

  const handlers: TurnstileHandlers = {
    onToken: (token: string): void => {
      state.token = token
      state.issuedAt = now()
      notify()
    },
    onExpired: (): void => {
      state.token = null
    },
    // Deliberately not `giveUp`. `retry` defaults to auto and the widget tries again
    // every 8 seconds, so an error is a setback; writing the widget off here would
    // stop asking for the token that was about to arrive.
    onError: (): void => {
      state.token = null
    },
    onUnsupported: (): void => {
      giveUp('this browser is not supported by Turnstile')
    },
  }

  function waitForToken(): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        waiters = waiters.filter((wake) => wake !== finish)
        resolve(state.token)
      }
      const timer = setTimeout(finish, waitMs)
      waiters.push(finish)
    })
  }

  async function obtain(): Promise<string | null> {
    // The widget's own answer beats the gate's arithmetic: it knows about resets and
    // refreshes that never came back through a callback.
    if (widgetId !== null && api?.isExpired?.(widgetId) === true) state.token = null

    switch (tokenAction(state, now())) {
      case 'give-up':
        return null
      case 'send':
        return state.token
      case 'refresh':
        state.token = null
        resetWidget()
        break
      case 'wait':
        break
    }
    // `resetWidget` above can give up, and the switch was decided before it ran. Ask
    // again rather than making the reader sit through the full wait for an answer
    // this gate already has.
    if (state.failed) return null
    return waitForToken()
  }

  return {
    start(loaded: TurnstileApi): void {
      if (state.failed || widgetId !== null) return
      api = loaded
      let id: string | undefined | null
      try {
        id = loaded.render(options.container, renderParameters(options.sitekey, handlers))
      } catch (error) {
        giveUp(`render threw: ${String(error)}`)
        return
      }
      if (typeof id !== 'string' || id === '') {
        giveUp('render produced no widget')
        return
      }
      widgetId = id
    },

    giveUp,

    async token(): Promise<string | null> {
      const value = await obtain()
      if (value === null) return null
      // "Each token can only be validated once. A replayed token will be rejected
      // with the timeout-or-duplicate error code." So it is spent the moment it is
      // handed over — including when the post then fails for some unrelated reason,
      // because the alternative is a reader whose second attempt is refused as spam.
      // Resetting now also means the next token is already being minted.
      state.token = null
      resetWidget()
      return value
    },
  }
}
