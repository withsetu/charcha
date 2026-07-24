// The Markdown a comment body may use, and nothing else.
//
// The design is escape-then-build, not build-then-sanitise. The body is escaped
// once, on the way in, and every rule below composes those already-escaped
// fragments with markup written literally in this file. So the only `<` in the
// output is one this file typed. Sanitising generated HTML is the other design,
// and it is a blocklist: it has to recognise every way a browser can be talked
// into parsing a tag, and it loses the first time it meets one nobody knew about.
//
// The subset is deliberately small, hand-written and enumerated here rather than
// delegated to a Markdown library. A parser is a large amount of someone else's
// code standing between a public write endpoint and other people's pages, and
// this project needs eight rules of it.
//
// Supported: paragraphs, hard line breaks, **bold**, *italic*, `code`, fenced
// code blocks, > blockquotes, - unordered lists, and [text](https://url) links.
// Everything else — headings, images, tables, HTML, raw URLs, underscores — is
// left as the text the commenter typed.

import { escapeHtml } from './escape'

/**
 * The scheme allowlist. `javascript:`, `data:` and `vbscript:` are the three
 * everyone remembers; the browser knows more URL schemes than this project does,
 * so the rule is what is permitted rather than what is refused.
 */
const HTTP_URL = /^https?:\/\/\S/i

/**
 * Characters with no business in a URL a public comment box accepts: C0 and C1
 * controls, every width of space, and the bidirectional and zero-width marks
 * that make one URL read on screen as another.
 *
 * Neither quote, `<` nor `>` can actually reach here — escapeHtml turned them
 * into entities before this ran — so listing them is a second lock on a door
 * that is already shut, and a failing test if the first lock is ever removed.
 */
const UNSAFE_URL_CHARACTER =
  // The control characters are the point of this expression, not an oversight:
  // a tab inside `java<tab>script:` is exactly the trick being refused here.
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0020\u007f-\u009f\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f-\u2069\u3000\ufeff<>"'`\\]/

/** rel and target for every link a comment produces. */
const LINK_REL = 'nofollow ugc noopener noreferrer'

const MAX_URL_LENGTH = 2048
const MAX_LINK_TEXT_LENGTH = 512

const FENCE = '```'

/**
 * The blockquote marker, matched in the form escaping leaves it in. Escaping
 * happens once, at the entry to renderMarkdown, so every rule after it reads
 * escaped text — `>` is `&gt;` by the time the block scanner sees a line.
 * A commenter who literally types `&gt;` produces `&amp;gt;`, so the two cannot
 * be confused.
 */
const QUOTE_MARKER = '&gt;'

function isSafeUrl(url: string): boolean {
  if (url.length === 0 || url.length > MAX_URL_LENGTH) return false
  if (UNSAFE_URL_CHARACTER.test(url)) return false
  return HTTP_URL.test(url)
}

/**
 * A forward-only cursor over one delimiter. Intended to keep a body of
 * half-written link syntax — thousands of `[` with one `]` far away — linear in
 * its length rather than quadratic, by never restarting a search behind a
 * position the scanner has already passed.
 */
function seeker(text: string, needle: string): (from: number) => number {
  let at = text.indexOf(needle)
  return (from: number) => {
    if (at !== -1 && at < from) at = text.indexOf(needle, from)
    return at
  }
}

interface Span {
  html: string
  end: number
}

function readLink(
  escaped: string,
  start: number,
  nextBracket: (from: number) => number,
  nextParen: (from: number) => number,
): Span | null {
  const textEnd = nextBracket(start + 1)
  if (textEnd === -1) return null
  if (textEnd - start - 1 > MAX_LINK_TEXT_LENGTH) return null
  if (escaped.charAt(textEnd + 1) !== '(') return null

  const urlEnd = nextParen(textEnd + 2)
  if (urlEnd === -1) return null
  // Measured before slicing: the point of the cap is that an absurd URL costs
  // nothing to refuse.
  if (urlEnd - textEnd - 2 > MAX_URL_LENGTH) return null

  const url = escaped.slice(textEnd + 2, urlEnd)
  if (!isSafeUrl(url)) return null

  // The label is emitted as the escaped text it already is. No nested rules
  // inside it: a link cannot carry another link, and there is one fewer place
  // where a fragment could be built rather than escaped.
  const text = escaped.slice(start + 1, textEnd)
  return {
    html: `<a href="${url}" rel="${LINK_REL}" target="_blank">${text}</a>`,
    end: urlEnd + 1,
  }
}

function readEmphasis(escaped: string, start: number): Span | null {
  for (const marker of ['**', '*']) {
    if (!escaped.startsWith(marker, start)) continue

    const from = start + marker.length
    const close = escaped.indexOf(marker, from)
    // `close === from` is an empty span, `-1` is an unclosed one. Both are left
    // as literal text.
    if (close <= from) continue

    const tag = marker === '**' ? 'strong' : 'em'
    return {
      html: `<${tag}>${renderInline(escaped.slice(from, close))}</${tag}>`,
      end: close + marker.length,
    }
  }
  return null
}

/**
 * Renders one line of already-escaped text. A single left-to-right scan rather
 * than a chain of regular-expression replacements, so the rules cannot interact:
 * a code span is consumed whole, and what is inside it is never looked at again.
 *
 * Emphasis closes at the nearest matching delimiter, which is why its content
 * can never contain the delimiter that opened it, and why nesting bottoms out
 * after two levels instead of being a depth the commenter chooses.
 * Enforced by test/worker/render/markdown.test.ts.
 */
function renderInline(escaped: string): string {
  const out: string[] = []
  const nextBracket = seeker(escaped, ']')
  const nextParen = seeker(escaped, ')')
  let index = 0

  while (index < escaped.length) {
    const character = escaped.charAt(index)

    if (character === '`') {
      const close = escaped.indexOf('`', index + 1)
      if (close > index + 1) {
        out.push('<code>', escaped.slice(index + 1, close), '</code>')
        index = close + 1
        continue
      }
    } else if (character === '[') {
      const link = readLink(escaped, index, nextBracket, nextParen)
      if (link !== null) {
        out.push(link.html)
        index = link.end
        continue
      }
    } else if (character === '*') {
      const emphasis = readEmphasis(escaped, index)
      if (emphasis !== null) {
        out.push(emphasis.html)
        index = emphasis.end
        continue
      }
    }

    out.push(character)
    index += 1
  }

  return out.join('')
}

function isListItem(line: string): boolean {
  return line.startsWith('- ') || line.startsWith('* ')
}

function isProse(line: string): boolean {
  return (
    line.trim() !== '' &&
    !line.startsWith(FENCE) &&
    !line.startsWith(QUOTE_MARKER) &&
    !isListItem(line)
  )
}

/**
 * Renders a comment body — untrusted Markdown — as an HTML string.
 *
 * Pure: no I/O, no clock, no globals, no state between calls. The same body
 * renders to the same string in the Worker, in the HTMLRewriter injection path
 * and in the build-time API (#1), which is the whole reason this is a function
 * and not an endpoint.
 * Enforced by test/worker/render/markdown.test.ts.
 */
export function renderMarkdown(source: string): string {
  // Escaped once, here, at the only point where untrusted text enters this
  // module. Every rule below composes the fragments this produces with literal
  // markup, so nothing is escaped twice and nothing is missed.
  const lines = escapeHtml(source.replace(/\r\n?/g, '\n')).split('\n')
  const out: string[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (line.startsWith(FENCE)) {
      // The info string after the fence is attacker-controlled text that would
      // land on an element this file owns, so it is dropped rather than turned
      // into a class: `class` is the one attribute a host stylesheet trusts.
      const content: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').startsWith(FENCE)) {
        content.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      out.push('<pre><code>', content.join('\n'), '</code></pre>')
      continue
    }

    if (line.startsWith(QUOTE_MARKER)) {
      const quoted: string[] = []
      while (index < lines.length && (lines[index] ?? '').startsWith(QUOTE_MARKER)) {
        const rest = (lines[index] ?? '').slice(QUOTE_MARKER.length)
        quoted.push(renderInline(rest.startsWith(' ') ? rest.slice(1) : rest))
        index += 1
      }
      out.push('<blockquote><p>', quoted.join('<br>'), '</p></blockquote>')
      continue
    }

    if (isListItem(line)) {
      const items: string[] = []
      while (index < lines.length && isListItem(lines[index] ?? '')) {
        items.push('<li>', renderInline((lines[index] ?? '').slice(2)), '</li>')
        index += 1
      }
      out.push('<ul>', ...items, '</ul>')
      continue
    }

    if (line.trim() === '') {
      index += 1
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length && isProse(lines[index] ?? '')) {
      paragraph.push(renderInline(lines[index] ?? ''))
      index += 1
    }
    // A single newline is a line break rather than a space. Comment boxes are
    // not editors: people press Enter and expect the line to end there.
    out.push('<p>', paragraph.join('<br>'), '</p>')
  }

  return out.join('')
}
