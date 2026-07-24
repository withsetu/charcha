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
    },
  }
}
