// How a page URL becomes a thread key. Designed on issue #22.
//
// `threads.page_key` is the UNIQUE key of the threads table, and the value it is
// derived from arrives from a public, unauthenticated endpoint. So the key is
// *derived here*, in the Worker, from the URL the embed reports — it is never
// accepted over the wire as a key. An embed can send whatever it likes; a stale
// cached one can send whatever last year's build liked. Neither can choose a key
// this file would not have produced.
//
// The key has two namespaces, and they cannot collide:
//
//   /notes/leaving   a URL-derived key — always starts "/"
//   id:leaving       an owner-declared key from data-thread — always starts "id:"
//
// Enforced by test/worker/page-key.test.ts.
//
// Nothing here reads the clock, the network or the database. It is a pure
// function so that #7 (the submission pipeline) and the v1.1 server-rendering
// paths can all call it and agree — the SSR build-time API and the HTMLRewriter
// injection must land on the same key as the embed did, or the page renders
// someone else's conversation.

/**
 * The longest URL accepted from a caller. Matches the `page_url` column, and it
 * is checked before anything is parsed: normalising a megabyte of attacker
 * string is work a public endpoint would be doing for free.
 */
export const MAX_URL_LENGTH = 2048

/** The longest `data-thread` accepted. Short on purpose — it is a slug, not a URL. */
export const MAX_THREAD_ID_LENGTH = 200

/** The `page_key` column is `CHECK (length(page_key) BETWEEN 1 AND 512)`. */
export const MAX_PAGE_KEY_LENGTH = 512

/**
 * Rejections are values rather than exceptions: this runs on the hot path of a
 * public endpoint, and #7 needs to map the outcome onto a status code without
 * pattern-matching an error message.
 */
export type PageKeyRejection =
  | 'missing'
  | 'too-long'
  | 'control-characters'
  | 'not-a-url'
  | 'unsupported-scheme'
  | 'invalid-thread-id'
  | 'key-too-long'

export interface PageKeyInput {
  /** `location.href`, as reported by the embed. Untrusted. */
  url?: string | null
  /** The site owner's `data-thread` override. Untrusted — it arrives the same way. */
  thread?: string | null
  /**
   * Query parameters that are page identity on this site, e.g. `['page']` or
   * `['id']`. Everything not named here is dropped, so `?utm_source=` cannot
   * fork a thread. Owner configuration: it belongs in `settings`, read by the
   * caller, so that the allowlist is Worker-side and an embed cannot widen it.
   */
  significantParams?: readonly string[]
}

export type PageKeyResult =
  | {
      ok: true
      /** The thread key. ASCII, 1..512 characters, safe to store as-is. */
      pageKey: string
      /** The canonical absolute URL, for `threads.page_url`. Always http(s). */
      pageUrl: string | null
    }
  | { ok: false; reason: PageKeyRejection }

/**
 * Rejected outright rather than percent-encoded. The URL parser strips ASCII tab
 * and newline before it parses (WHATWG URL §4.4), so `https://exa\nmple.com/p`
 * would otherwise become a perfectly ordinary key — the value in the log and the
 * value in the database would be two different strings. Nothing legitimate sends
 * a control character in a page URL.
 * Enforced by test/worker/page-key.test.ts.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * A `data-thread` value: ASCII, starting with a letter or digit. No percent sign,
 * so no encoding games; no non-ASCII, so no homoglyph can be aimed at another
 * site's slug; no leading "/", so it cannot be pushed into the URL namespace.
 */
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._~:@/-]*$/

/** RFC 3986 §2.3 unreserved: the only octets a normaliser may decode. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/

function reject(reason: PageKeyRejection): PageKeyResult {
  return { ok: false, reason }
}

/**
 * RFC 3986 §6.2.2.1 and §6.2.2.2: uppercase the hex digits of every triplet, and
 * decode the triplets that encode an unreserved character.
 *
 * The decode happens exactly once, by construction — the replacement is not
 * rescanned. Decoding until the string stops changing is the classic mistake
 * here: it makes `%252F`, `%25252F` and `%2F` the same key. `%2F` in particular
 * is left encoded, because decoding it would turn one page's path segment into
 * two and land its comments on a different page.
 * Enforced by test/worker/page-key.test.ts.
 */
function normalisePercentEncoding(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_triplet, hex: string) => {
    const decoded = String.fromCharCode(Number.parseInt(hex, 16))
    return UNRESERVED.test(decoded) ? decoded : `%${hex.toUpperCase()}`
  })
}

/**
 * The path, as identity. `URL.pathname` has already removed dot segments — including
 * the percent-encoded spellings `.%2e`, `%2e.` and `%2e%2e` (WHATWG URL §4.1) —
 * folded backslashes into separators, and percent-encoded every non-ASCII byte.
 * What is left to decide here is encoding case, redundant encoding, repeated
 * separators and the trailing slash.
 *
 * Path *case* is deliberately preserved: RFC 3986 §6.2.2.1 makes only the scheme
 * and host case-insensitive, and static hosts serve paths case-sensitively.
 * Enforced by test/worker/page-key.test.ts.
 */
function canonicalPath(pathname: string): string {
  const normalised = normalisePercentEncoding(pathname).replace(/\/{2,}/g, '/')
  const trimmed = normalised.length > 1 ? normalised.replace(/\/$/, '') : normalised
  return trimmed === '' ? '/' : trimmed
}

/**
 * The query, as identity — which by default is none of it. A blanket strip would
 * merge `?page=2` into `?page=1`; keeping everything lets any tracking parameter
 * fork a thread, and the set of those is unbounded and grows. So: keep nothing
 * unless the owner named it, and sort what is kept, so `?a=1&b=2` and `?b=2&a=1`
 * are one conversation.
 */
function canonicalQuery(params: URLSearchParams, significant: readonly string[]): string {
  if (significant.length === 0) return ''

  const wanted = new Set(significant)
  const kept: [string, string][] = []
  for (const [name, value] of params) if (wanted.has(name)) kept.push([name, value])
  if (kept.length === 0) return ''

  kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  return `?${new URLSearchParams(kept).toString()}`
}

/**
 * Turns what the embed reported into the key its comments belong under.
 *
 * The caller owns the trust boundary in one direction only: it may choose which
 * query parameters count, and it may hand over a `data-thread`. It may not hand
 * over a key.
 */
export function derivePageKey(input: PageKeyInput): PageKeyResult {
  const rawUrl = input.url ?? null
  const rawThread = (input.thread ?? '').trim()

  // Size caps first, before any parsing, on both inputs. Card rule 5.
  if (rawUrl !== null && rawUrl.length > MAX_URL_LENGTH) return reject('too-long')
  if (rawThread.length > MAX_THREAD_ID_LENGTH) return reject('too-long')
  if (rawUrl === null && rawThread === '') return reject('missing')

  let pageUrl: string | null = null
  let urlKey: string | null = null

  if (rawUrl !== null) {
    if (hasControlCharacter(rawUrl)) return reject('control-characters')

    // NFC, not NFKC. NFC merges the two encodings of one character — "café" and
    // "cafe" + U+0301 are the same text and must be one thread. NFKC would also
    // fold compatibility characters, merging text that is genuinely different and
    // therefore merging pages; a wrong merge cannot be undone, a wrong split can.
    // Enforced by test/worker/page-key.test.ts.
    let parsed: URL
    try {
      parsed = new URL(rawUrl.normalize('NFC'))
    } catch {
      return reject('not-a-url')
    }

    // page_url is rendered as a link in the moderation queue, so the scheme
    // allowlist here is what stops a submitted "URL" becoming stored XSS there.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return reject('unsupported-scheme')
    }
    if (parsed.hostname === '') return reject('not-a-url')

    const path = canonicalPath(parsed.pathname)
    const query = canonicalQuery(parsed.searchParams, input.significantParams ?? [])

    // The origin is not identity. One deployment serves one site (multi-site is a
    // v1 non-goal, #1), and a site is reachable at its apex and at www, over http
    // and https, and on a dev port — readers hit all of them. Dropping the origin
    // makes those one conversation with no configuration, and lets the key survive
    // a domain move.
    urlKey = `${path}${query}`
    pageUrl = `${parsed.origin}${path}${query}`
    if (pageUrl.length > MAX_URL_LENGTH) return reject('too-long')
  }

  let pageKey: string
  if (rawThread !== '') {
    if (!THREAD_ID.test(rawThread.normalize('NFC'))) return reject('invalid-thread-id')
    pageKey = `id:${rawThread}`
  } else if (urlKey !== null) {
    pageKey = urlKey
  } else {
    return reject('missing')
  }

  // Checked here as well as by the column, because failing at the boundary is a
  // 400 and failing at the database is a 500. The key is ASCII by construction —
  // every non-ASCII byte of a path is percent-encoded — so this count is the same
  // count SQLite's length() will make.
  if (pageKey.length > MAX_PAGE_KEY_LENGTH) return reject('key-too-long')

  return { ok: true, pageKey, pageUrl }
}
