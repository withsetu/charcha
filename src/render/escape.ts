const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Turns text into HTML text, by escaping the five characters that can change
 * what surrounds them: the two that open a tag, the two that delimit an
 * attribute value, and the one that begins an escape of its own.
 *
 * Escaping the ampersand is what makes this reversible, and reversibility is the
 * property the rest of the renderer stands on: an already-escaped fragment can
 * be composed with literal markup without being escaped again, because nothing
 * a commenter can write survives one pass through here still meaning HTML.
 *
 * One regular expression, one pass — a chain of `.replace()` calls would rewrite
 * the ampersands it had just introduced.
 * Enforced by test/worker/render/escape.test.ts.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character)
}
