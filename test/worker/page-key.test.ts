import { describe, expect, it } from 'vitest'
import {
  MAX_PAGE_KEY_LENGTH,
  MAX_THREAD_ID_LENGTH,
  MAX_URL_LENGTH,
  derivePageKey,
  type PageKeyInput,
} from '../../src/page-key'

/** Every test that expects a key wants the key, not the wrapper around it. */
function keyFor(input: PageKeyInput): string {
  const result = derivePageKey(input)
  if (!result.ok) throw new Error(`expected a page key, got rejection "${result.reason}"`)
  return result.pageKey
}

function rejectionFor(input: PageKeyInput): string {
  const result = derivePageKey(input)
  if (result.ok) throw new Error(`expected a rejection, got page key "${result.pageKey}"`)
  return result.reason
}

describe('the five URLs from #22 that were five conversations', () => {
  it('treats /post and /post/ as one conversation', () => {
    expect(keyFor({ url: 'https://blog.example.com/post/' })).toBe(
      keyFor({ url: 'https://blog.example.com/post' }),
    )
  })

  it('treats a link carrying utm parameters as the page it points at', () => {
    expect(keyFor({ url: 'https://blog.example.com/post?utm_source=newsletter' })).toBe(
      keyFor({ url: 'https://blog.example.com/post' }),
    )
  })

  it('ignores the fragment, so #comments is not a thread of its own', () => {
    expect(keyFor({ url: 'https://blog.example.com/post#comments' })).toBe(
      keyFor({ url: 'https://blog.example.com/post' }),
    )
  })

  it('ignores the origin, so www and the apex domain are one conversation', () => {
    expect(keyFor({ url: 'https://www.blog.example.com/post' })).toBe(
      keyFor({ url: 'https://blog.example.com/post' }),
    )
  })

  it('ignores the scheme and the port, so http, https and a dev server agree', () => {
    const canonical = keyFor({ url: 'https://blog.example.com/post' })

    expect(keyFor({ url: 'http://blog.example.com/post' })).toBe(canonical)
    expect(keyFor({ url: 'http://localhost:8788/post' })).toBe(canonical)
  })

  it('folds the case of the scheme and host, which are case-insensitive by definition', () => {
    // RFC 3986 §6.2.2.1: "the scheme and host are case-insensitive and therefore
    // should be normalized to lowercase". Dropping the origin makes this free for
    // the key; page_url still records it, and the dashboard renders that as a link.
    const shouty = derivePageKey({ url: 'HTTPS://BLOG.EXAMPLE.COM/post' })

    expect(shouty.ok).toBe(true)
    if (!shouty.ok) return
    expect(shouty.pageKey).toBe('/post')
    expect(shouty.pageUrl).toBe('https://blog.example.com/post')
  })

  // The one row of #22's list this deliberately does not merge. RFC 3986 §6.2.2.1
  // again: "The other generic syntax components are assumed to be case-sensitive".
  // Static hosts serve paths case-sensitively, so /Post and /post can be two
  // documents — and merging two pages into one thread cannot be undone, while
  // splitting one page into two threads can. A site that needs them merged uses
  // data-thread. See the design comment on #22.
  it('keeps /post and /Post apart, because a path is case-sensitive', () => {
    expect(keyFor({ url: 'https://blog.example.com/Post' })).not.toBe(
      keyFor({ url: 'https://blog.example.com/post' }),
    )
  })
})

describe('the shape of a page key', () => {
  it('starts a URL-derived key with a slash', () => {
    expect(keyFor({ url: 'https://example.com/notes/leaving' })).toBe('/notes/leaving')
  })

  it('starts an owner-declared key with id:, so the two namespaces cannot collide', () => {
    // A path key always begins "/" and an override always begins "id:", so no
    // data-thread value can ever be made to land on a page's URL-derived thread.
    expect(keyFor({ thread: 'leaving-the-comment-industry' })).toBe(
      'id:leaving-the-comment-industry',
    )
  })

  it('gives the site root the key /, never the empty string', () => {
    // page_key is CHECK (length BETWEEN 1 AND 512): an empty key is a constraint
    // failure at the database rather than a rejection at the boundary.
    expect(keyFor({ url: 'https://example.com' })).toBe('/')
    expect(keyFor({ url: 'https://example.com/' })).toBe('/')
  })

  it('collapses repeated slashes, which every static host serves as one page', () => {
    expect(keyFor({ url: 'https://example.com//notes///leaving' })).toBe('/notes/leaving')
  })

  it('records the canonical absolute URL alongside the key, for the dashboard', () => {
    const result = derivePageKey({ url: 'https://example.com/post/?utm_source=x#comments' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pageUrl).toBe('https://example.com/post')
  })
})

describe('query parameters', () => {
  it('drops the query by default, so a tracking link joins the thread it points at', () => {
    expect(keyFor({ url: 'https://example.com/post?fbclid=abc&mc_cid=42&ref=twitter' })).toBe(
      '/post',
    )
  })

  it('keeps a parameter the owner declared to be part of page identity', () => {
    const significantParams = ['page']

    expect(keyFor({ url: 'https://example.com/archive?page=2', significantParams })).toBe(
      '/archive?page=2',
    )
    expect(keyFor({ url: 'https://example.com/archive', significantParams })).toBe('/archive')
  })

  it('still drops the tracking parameters travelling alongside a significant one', () => {
    expect(
      keyFor({
        url: 'https://example.com/archive?utm_source=newsletter&page=2&fbclid=abc',
        significantParams: ['page'],
      }),
    ).toBe('/archive?page=2')
  })

  it('orders the parameters it keeps, so ?a=1&b=2 and ?b=2&a=1 are one thread', () => {
    const significantParams = ['a', 'b']

    expect(keyFor({ url: 'https://example.com/p?b=2&a=1', significantParams })).toBe(
      keyFor({ url: 'https://example.com/p?a=1&b=2', significantParams }),
    )
  })

  it('keeps two values of the same significant parameter apart', () => {
    const significantParams = ['id']

    expect(keyFor({ url: 'https://example.com/item?id=42', significantParams })).not.toBe(
      keyFor({ url: 'https://example.com/item?id=43', significantParams }),
    )
  })

  it('matches a significant parameter by exact name, not by prefix', () => {
    // "page" must not opt "page_source" in as well — an allowlist that matches
    // loosely is an allowlist that lets tracking parameters back in.
    expect(
      keyFor({ url: 'https://example.com/archive?page_source=x', significantParams: ['page'] }),
    ).toBe('/archive')
  })
})

describe('the owner override', () => {
  it('uses data-thread as the key, so a moved page keeps its comments', () => {
    expect(
      keyFor({ url: 'https://example.com/2026/07/new-url', thread: 'leaving-the-industry' }),
    ).toBe('id:leaving-the-industry')
  })

  it('still records the URL the reader was actually on', () => {
    const result = derivePageKey({
      url: 'https://example.com/2026/07/new-url',
      thread: 'leaving-the-industry',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pageUrl).toBe('https://example.com/2026/07/new-url')
  })

  it('treats an empty or blank data-thread as absent, as HTML does', () => {
    expect(keyFor({ url: 'https://example.com/post', thread: '' })).toBe('/post')
    expect(keyFor({ url: 'https://example.com/post', thread: '   ' })).toBe('/post')
  })

  it('has no URL to record when the caller supplied only an override', () => {
    const result = derivePageKey({ thread: 'a-thread' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.pageUrl).toBeNull()
  })

  it.each([
    ['a traversal', '../../etc/passwd'],
    ['a space', 'my thread'],
    ['a percent sign, and with it every encoding trick', 'a%2Fb'],
    ['a leading slash, which is the URL namespace', '/post'],
    ['a leading hyphen', '-post'],
    ['a non-ASCII character, and with it every homoglyph', 'pаge'],
    ['a newline', 'a\nb'],
    ['a null byte', 'a\u0000b'],
  ])('refuses an override containing %s', (_label, thread) => {
    expect(rejectionFor({ thread })).toBe('invalid-thread-id')
  })

  it('refuses an override longer than its cap', () => {
    expect(rejectionFor({ thread: 'a'.repeat(MAX_THREAD_ID_LENGTH + 1) })).toBe('too-long')
    expect(keyFor({ thread: 'a'.repeat(MAX_THREAD_ID_LENGTH) })).toHaveLength(
      MAX_THREAD_ID_LENGTH + 3,
    )
  })
})

describe('hostile input', () => {
  // The input below is shaped so that ONLY the pre-parse cap can reject it. The
  // query is dropped by default, so a normaliser that parsed first and measured
  // afterwards would accept a 2 KB string and cheerfully answer "/post" — and
  // would do the same for a 2 MB one. Measuring a long path instead would prove
  // nothing, because the page_url and page_key caps reject that after the fact.
  // This is a public, unauthenticated endpoint; the work itself is the cost.
  const bloatedQuery = `https://example.com/post?utm_source=${'a'.repeat(MAX_URL_LENGTH)}`

  it('refuses an overlong URL before it parses anything, not after', () => {
    expect(bloatedQuery.length).toBeGreaterThan(MAX_URL_LENGTH)

    expect(rejectionFor({ url: bloatedQuery })).toBe('too-long')
  })

  it('refuses an overlong URL even when a valid override would have decided the key', () => {
    expect(rejectionFor({ url: bloatedQuery, thread: 'fine' })).toBe('too-long')
  })

  it('refuses a URL that percent-encodes into more than the page_url column holds', () => {
    // 250 CJK characters are 250 characters of URL and 2250 of canonical URL:
    // an input under the input cap can still produce a page_url over the column's.
    const dense = `https://example.com/${'日'.repeat(250)}`

    expect(dense.length).toBeLessThanOrEqual(MAX_URL_LENGTH)
    expect(rejectionFor({ url: dense })).toBe('too-long')
  })

  it('refuses a URL containing a newline, which the URL parser would otherwise splice out', () => {
    // WHATWG URL §4.4: "Remove all ASCII tab or newline from input." So
    // "https://exa\nmple.com/a\tb" parses clean, and a value that is two different
    // strings in a log is one string in the database.
    expect(rejectionFor({ url: 'https://exa\nmple.com/post' })).toBe('control-characters')
    expect(rejectionFor({ url: 'https://example.com/po\tst' })).toBe('control-characters')
    expect(rejectionFor({ url: 'https://example.com/post\r\n' })).toBe('control-characters')
  })

  it('refuses a URL containing a null byte or another control character', () => {
    expect(rejectionFor({ url: 'https://example.com/post\u0000' })).toBe('control-characters')
    expect(rejectionFor({ url: 'https://example.com/po\u007Fst' })).toBe('control-characters')
    expect(rejectionFor({ url: 'https://example.com/po\u001Bst' })).toBe('control-characters')
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    // Unlike the three above, this one has a hostname, so the scheme allowlist is
    // the only thing standing between it and threads.page_url.
    'ftp://example.com/post',
  ])('refuses %s, which the dashboard would otherwise render as a link', (url) => {
    // page_url is shown in the moderation queue as an anchor. A scheme allowlist
    // here is what stops a submitted "URL" from becoming stored XSS there.
    expect(rejectionFor({ url })).toBe('unsupported-scheme')
  })

  it('refuses input that is not an absolute URL', () => {
    expect(rejectionFor({ url: '/post' })).toBe('not-a-url')
    expect(rejectionFor({ url: 'not a url at all' })).toBe('not-a-url')
    expect(rejectionFor({ url: '//example.com/post' })).toBe('not-a-url')
  })

  it('refuses a request that carries neither a URL nor an override', () => {
    expect(rejectionFor({})).toBe('missing')
    expect(rejectionFor({ url: null, thread: null })).toBe('missing')
  })

  it('never lets %2F become a path separator', () => {
    // RFC 3986 §6.2.2.2 permits decoding only unreserved characters. Decoding %2F
    // would make /a%2Fb and /a/b the same key, so one page's comments would land
    // on another's.
    expect(keyFor({ url: 'https://example.com/a%2Fb' })).not.toBe(
      keyFor({ url: 'https://example.com/a/b' }),
    )
    expect(keyFor({ url: 'https://example.com/a%2Fb' })).toBe('/a%2Fb')
  })

  it('decodes exactly once, so %252F never collapses into %2F', () => {
    // Decoding until the string stops changing is the classic way this goes
    // wrong: it makes %252F, %25252F and %2F all the same key.
    expect(keyFor({ url: 'https://example.com/a%252Fb' })).toBe('/a%252Fb')
    expect(keyFor({ url: 'https://example.com/a%252Fb' })).not.toBe(
      keyFor({ url: 'https://example.com/a%2Fb' }),
    )
  })

  it('normalises the case of percent-encoding, which is case-insensitive', () => {
    // RFC 3986 §6.2.2.1. Without this, %2f and %2F are two threads.
    expect(keyFor({ url: 'https://example.com/a%2fb' })).toBe(
      keyFor({ url: 'https://example.com/a%2Fb' }),
    )
  })

  it('decodes a needlessly encoded unreserved character', () => {
    // RFC 3986 §6.2.2.2: %7E and ~ identify the same resource, so they must not
    // be two threads.
    expect(keyFor({ url: 'https://example.com/%7Emaya/%41bout' })).toBe('/~maya/About')
  })

  it('removes dot segments rather than storing them', () => {
    expect(keyFor({ url: 'https://example.com/notes/./leaving' })).toBe('/notes/leaving')
    expect(keyFor({ url: 'https://example.com/notes/drafts/../leaving' })).toBe('/notes/leaving')
  })

  it('removes percent-encoded dot segments too', () => {
    // WHATWG URL §4.1: a double-dot path segment is ".." or an ASCII
    // case-insensitive match for ".%2e", "%2e.", or "%2e%2e".
    expect(keyFor({ url: 'https://example.com/notes/drafts/%2e%2e/leaving' })).toBe(
      '/notes/leaving',
    )
    expect(keyFor({ url: 'https://example.com/notes/%2E/leaving' })).toBe('/notes/leaving')
  })

  it('cannot be walked above the site root', () => {
    expect(keyFor({ url: 'https://example.com/../../../etc/passwd' })).toBe('/etc/passwd')
    expect(keyFor({ url: 'https://example.com/a/../..' })).toBe('/')
  })

  it('never leaves a bare dot segment in a key', () => {
    for (const path of ['/a/../b', '/a/./b', '/a/%2e%2e/b', '/./', '/..', '/a/..%2fb']) {
      const key = keyFor({ url: `https://example.com${path}` })
      expect(key.split('?')[0]?.split('/')).not.toContain('..')
      expect(key.split('?')[0]?.split('/')).not.toContain('.')
    }
  })

  it('folds a backslash into a path separator, exactly as the browser does', () => {
    // WHATWG URL §4.4 treats U+005C as U+002F in a special URL, so the reader's
    // browser is already on /a/b. Anything else would be a key for a page that
    // does not exist.
    expect(keyFor({ url: 'https://example.com/a\\b' })).toBe('/a/b')
  })

  it('gives one key to the two Unicode spellings of the same path', () => {
    // "café" precomposed vs "cafe" + U+0301. Canonically equivalent, visually
    // identical, and the browser will send whichever one the page's markup used.
    const precomposed = keyFor({ url: 'https://example.com/café' })
    const decomposed = keyFor({ url: 'https://example.com/café' })

    expect(decomposed).toBe(precomposed)
  })

  it('keeps a Cyrillic homoglyph apart from its Latin lookalike', () => {
    // The opposite direction, and deliberately so: U+0430 and U+0061 are
    // different characters and can be different documents. Folding them would
    // merge two pages into one thread, which cannot be undone. Compatibility
    // normalisation (NFKC) would do exactly that, so this uses NFC.
    expect(keyFor({ url: 'https://example.com/pаge' })).not.toBe(
      keyFor({ url: 'https://example.com/page' }),
    )
  })

  it('produces an ASCII-only key, so its length is the length the column counts', () => {
    // SQLite's length() counts characters. Percent-encoding every non-ASCII byte
    // makes JavaScript's .length, the code-point count and SQLite's count the
    // same number, so the 512 cap below means what it says.
    const key = keyFor({ url: 'https://example.com/café/日本語' })

    expect(key).toMatch(/^[\x20-\x7E]+$/)
    expect([...key]).toHaveLength(key.length)
  })

  it('refuses a key that would not fit the column, rather than letting the insert fail', () => {
    const longPath = `https://example.com/${'a'.repeat(MAX_PAGE_KEY_LENGTH)}`

    expect(longPath.length).toBeLessThanOrEqual(MAX_URL_LENGTH)
    expect(rejectionFor({ url: longPath })).toBe('key-too-long')
  })

  it('counts a percent-encoded path against the cap as the database will', () => {
    // 200 CJK characters is 200 characters of URL and 1800 characters of key.
    const key = derivePageKey({ url: `https://example.com/${'日'.repeat(200)}` })

    expect(key.ok).toBe(false)
    if (key.ok) return
    expect(key.reason).toBe('key-too-long')
  })

  it('never returns a key the schema would reject', () => {
    const inputs = [
      'https://example.com',
      'https://example.com/',
      'https://example.com/a/../..',
      'https://example.com/%7E',
      `https://example.com/${'a'.repeat(400)}`,
    ]

    for (const url of inputs) {
      const key = keyFor({ url })
      expect(key.length).toBeGreaterThanOrEqual(1)
      expect(key.length).toBeLessThanOrEqual(MAX_PAGE_KEY_LENGTH)
    }
  })
})
