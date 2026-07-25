// Owner-facing formatting. Times only, and deliberately not shared with
// src/render/.
//
// The renderer's timestamp is timezone-free and labelled UTC out loud, because it
// runs in a Worker, in an HTMLRewriter and in a site's build, and has no reader to
// ask. This runs in one browser belonging to one person, so it can and should use
// their clock and their locale — a moderator deciding whether a comment is part of
// a burst needs "4 minutes ago", not "19:46 UTC".
//
// Enforced by test/dashboard/format.test.ts.

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * `Intl` formatters are expensive to construct and are constructed once here.
 *
 * Lazily, because this module is imported by tests that never format anything, and
 * because a locale is read from the environment — doing it at module scope would run
 * before a test could pin it.
 */
let relative: Intl.RelativeTimeFormat | null = null
let absolute: Intl.DateTimeFormat | null = null

function relativeFormat(): Intl.RelativeTimeFormat {
  relative ??= new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'long' })
  return relative
}

function absoluteFormat(): Intl.DateTimeFormat {
  absolute ??= new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return absolute
}

/**
 * A comment's age in words, for scanning.
 *
 * Relative under a week and absolute beyond it: "6 days ago" is a useful fact about
 * a comment and "417 days ago" is not, so the crossover is where the relative form
 * stops carrying information. Ages in the future — a clock skew between this browser
 * and the Worker — read as "in 3 minutes" rather than being clamped, because a
 * clamped future timestamp looks like a bug in the queue instead of a bug in a clock.
 * Enforced by test/dashboard/format.test.ts.
 */
export function formatAge(createdAt: number, now: number): string {
  const seconds = createdAt - now
  const magnitude = Math.abs(seconds)

  if (magnitude < MINUTE) return relativeFormat().format(Math.round(seconds), 'second')
  if (magnitude < HOUR) return relativeFormat().format(Math.round(seconds / MINUTE), 'minute')
  if (magnitude < DAY) return relativeFormat().format(Math.round(seconds / HOUR), 'hour')
  if (magnitude < 7 * DAY) return relativeFormat().format(Math.round(seconds / DAY), 'day')
  return absoluteFormat().format(new Date(createdAt * 1000))
}

/** The exact instant, for the tooltip and the `title` — never rounded away. */
export function formatExact(createdAt: number): string {
  return absoluteFormat().format(new Date(createdAt * 1000))
}

/** The value of a `<time datetime>` attribute: an ISO instant, always. */
export function isoInstant(createdAt: number): string {
  return new Date(createdAt * 1000).toISOString()
}

/**
 * The page a comment was posted on, as something readable.
 *
 * The title when the thread has one and the page key otherwise. **The title is
 * untrusted**: a commenter can set the title of a thread that does not exist yet
 * (#49), so it reaches the screen as text and never as markup — React escaping it is
 * what holds that, and this function returns a string for that reason rather than a
 * node. A blank or whitespace title is treated as absent, because an empty label on
 * this line reads as "no page" rather than as "a page whose title is nothing".
 */
export function pageLabel(pageTitle: string | null, pageKey: string): string {
  return pageTitle !== null && pageTitle.trim() !== '' ? pageTitle : pageKey
}
