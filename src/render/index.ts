// Rendering. One pure function turns rows into the HTML the Worker returns, and
// the same function is what the v1.1 server-rendering paths call.

export { escapeHtml } from './escape'
export { MARKDOWN_ELEMENTS, renderMarkdown } from './markdown'
export { COMMENT_CLASS_NAMES, COMMENT_ELEMENTS, renderComments } from './comments'
export type { RenderOptions } from './comments'
export { ENGLISH_STRINGS } from './strings'
export type { CommentStrings } from './strings'
