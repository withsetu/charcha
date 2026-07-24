// Every word the renderer shows a reader, in one place.
//
// The point of this module is not the English in it. It is that no user-facing
// sentence is written at a call site, so adding a second language later is
// supplying a table rather than searching the renderer for prose. The seam is
// cheap to build now with one string and expensive to retrofit with thirty.
//
// It is a parameter rather than a module-level setting or an ambient locale
// lookup, because renderComments is pure and has to stay that way: the v1.1
// server-rendering paths call the same function, and a renderer that reads
// hidden state renders differently depending on who called it last.
//
// These strings live in the Worker, not the embed, so they cost nothing against
// the 10 KB budget.

/**
 * The complete set of reader-visible strings. Every key is required, so a
 * translation missing one is a type error rather than the word `undefined` on
 * somebody's page — and this type is the list a translator, or #17's docs, reads
 * to know what a complete translation is.
 *
 * Keys are named for the slot, not for the English that currently fills it. A
 * key named after its own sentence is wrong the moment the sentence is
 * translated.
 */
export interface CommentStrings {
  /** Shown in place of the comment list when a page has no comments yet. */
  emptyState: string
}

/**
 * The default. Named for its language rather than called `DEFAULT`, so that a
 * call site reads as having chosen English instead of having chosen nothing.
 *
 * Whatever a table contains is escaped on the way out like any other untrusted
 * text — a translation is a contribution the day somebody accepts one, and
 * exempting it because it is "ours" is how an i18n table becomes an XSS vector.
 * Enforced by test/worker/render/comments.test.ts and
 * test/worker/render/vocabulary.test.ts.
 */
export const ENGLISH_STRINGS: CommentStrings = {
  emptyState: 'Be the first to comment',
}
