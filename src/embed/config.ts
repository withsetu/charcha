// What the site owner wrote in their HTML, turned into the three things the widget
// needs to know. Designed on issues #5 and #6.
//
// Pure: it is handed an attribute reader and the script's own URL rather than
// reaching for `document`. That is what lets it be tested in workerd alongside the
// rest of the project, and it keeps every DOM touch in one file (mount.ts).

/** The three styling modes from #6. */
export type StylesMode = 'inherit' | 'tokens' | 'bare'

export interface EmbedConfig {
  /**
   * The deployment's base address, with no trailing slash. A base rather than an
   * origin because a Worker can be routed at a subpath on a custom domain, and the
   * script's own URL is where this is derived from.
   */
  api: string
  /** The owner's `data-thread` override, or null. Validated by the Worker, not here. */
  thread: string | null
  styles: StylesMode
  /**
   * The Turnstile sitekey, or null when the owner has not configured Turnstile (#79).
   *
   * **This attribute is how the embed learns Turnstile is on**, and the alternatives
   * were both worse. A separate config fetch costs a second Worker request on every
   * page view, and Worker requests — not D1 — are what bound a site on the free tier
   * (100k/day, the capacity note on #5), so it would halve the ceiling. A flag on the
   * read response costs nothing extra but puts spam configuration inside the rendered
   * comment HTML, which is the one payload this project keeps single-purpose: the
   * v1.1 server-rendering paths emit that same HTML into pages with no embed on them
   * at all (#1). The attribute costs nothing, is readable before the first network
   * call, and leaks nothing — a sitekey is public by design and appears in the page
   * on every Turnstile site there is.
   *
   * The price is that the owner sets two things — `TURNSTILE_SECRET_KEY` on the
   * Worker and this attribute — and setting only the first refuses every comment.
   * Emitting the snippet with this filled in is #16's, and this is the contract it
   * fills.
   */
  turnstileSitekey: string | null
}

export type ConfigResult = { ok: true; config: EmbedConfig } | { ok: false; message: string }

/**
 * Said out loud on the page rather than only to the console.
 *
 * This is the one failure whose audience is the site owner rather than the reader:
 * it happens on every page load or none, and it happens the first time they paste
 * the snippet. A widget that renders nothing at all looks like a widget that has
 * not loaded yet, and the owner has no way to tell the two apart.
 */
const NO_BASE_MESSAGE =
  'Charcha could not tell which deployment to use. Add data-api to the embed element.'

/**
 * Both bases go through the same parser and the same scheme check.
 *
 * http(s) only. The value comes from the owner's own page rather than from a
 * reader, but it decides where every comment on the site is posted, and
 * `javascript:` or `data:` here is never something anybody meant.
 */
function parseBase(value: string, dropFilename: boolean): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null

  // For a script src, the directory the script sits in — so `/charcha/embed.js`
  // yields `/charcha` and a Worker routed at that subpath is reachable. The query
  // is dropped either way: a host that added `?v=3` to bust a cache is talking
  // about the file, not about the deployment.
  const path = dropFilename
    ? parsed.pathname.replace(/\/[^/]*$/, '')
    : parsed.pathname.replace(/\/$/, '')
  return `${parsed.origin}${path}`
}

function readStyles(value: string | null): StylesMode {
  if (value === 'bare' || value === 'tokens' || value === 'inherit') return value
  // A typo leaves the widget styled rather than naked: bare has to be asked for by
  // name, because it is the mode in which the owner has taken over.
  return 'inherit'
}

/**
 * A bound, not a format check.
 *
 * Cloudflare owns what a sitekey looks like, and a second, weaker copy of their rule
 * here is a thing that drifts — the same reason `data-thread` is passed through for
 * the Worker to validate. The cap only stops an absurd attribute being handed on
 * verbatim to a third party's script.
 * Enforced by test/worker/embed/config.test.ts.
 */
const MAX_SITEKEY_LENGTH = 128

function readSitekey(value: string | null): string | null {
  const sitekey = (value ?? '').trim()
  if (sitekey === '') return null
  if (sitekey.length > MAX_SITEKEY_LENGTH) {
    // Said out loud, because the consequence is out of all proportion to the typo:
    // with a secret configured on the Worker, a sitekey the embed will not use means
    // every comment on the site is refused. The server half announces its own
    // version of this misconfiguration (src/spam/turnstile.ts); this is the other end.
    console.warn('charcha: data-turnstile-sitekey is too long to be a sitekey; ignoring it')
    return null
  }
  return sitekey
}

/**
 * Reads the widget's configuration off the mount element.
 *
 * `attribute` is the element's own `getAttribute`, and `scriptSrc` is the `src` of
 * the script tag that loaded the embed — which is where the deployment address
 * comes from by default, so the owner names it once, in the snippet they paste.
 * Enforced by test/worker/embed/config.test.ts.
 */
export function readConfig(
  attribute: (name: string) => string | null,
  scriptSrc: string | null,
): ConfigResult {
  const declared = (attribute('data-api') ?? '').trim()
  const base =
    declared === ''
      ? scriptSrc === null || scriptSrc === ''
        ? null
        : parseBase(scriptSrc, true)
      : parseBase(declared, false)

  if (base === null) return { ok: false, message: NO_BASE_MESSAGE }

  const thread = (attribute('data-thread') ?? '').trim()

  return {
    ok: true,
    config: {
      api: base,
      thread: thread === '' ? null : thread,
      styles: readStyles(attribute('data-styles')),
      turnstileSitekey: readSitekey(attribute('data-turnstile-sitekey')),
    },
  }
}
