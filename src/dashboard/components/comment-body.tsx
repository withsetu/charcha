// The one place in this dashboard that inserts HTML, and the only place it can be
// done at all.
//
// A moderation queue puts attacker-chosen text in front of an authenticated
// session — the one session on this deployment that can delete every comment on the
// site — so this file is the whole of the XSS surface for #13, and it is four lines
// long on purpose.
//
// Enforced by test/dashboard/comment-body.test.tsx.

import { renderMarkdown } from '../../render/markdown'

/**
 * A comment body, rendered by src/render and by nothing else.
 *
 * **`renderMarkdown` is imported rather than reimplemented, and that is CLAUDE.md's
 * one-renderer rule reaching the dashboard.** The queue endpoint sends `body` as the
 * commenter typed it — Markdown, untrusted, unrendered — so something has to render
 * it, and the only permissible something is the function the reader-facing page
 * already uses. It escapes once on the way in and composes the result with markup
 * written literally in that file, so the only `<` in the output is one src/render
 * typed; its vocabulary is enumerated and asserted by
 * test/worker/render/vocabulary.test.ts. A second renderer here would be a second
 * escaping implementation to get right, on the surface where getting it wrong costs
 * the most.
 *
 * **Imported from `../../render/markdown` and not from `../../render`.** The
 * package's index re-exports `renderComments`, which imports a type from `../db` and
 * so drags the Worker's ambient types into a program that must not have them (see
 * src/dashboard/tsconfig.json). `markdown.ts` imports only `escape.ts`, and both are
 * pure string functions with no runtime of their own.
 *
 * `dangerouslySetInnerHTML` is the correct API here and not a compromise: the input
 * *is* a trusted HTML string, having just been produced from untrusted text by the
 * function whose job that is. What must never happen is this component receiving
 * anything else — so it takes the raw body and calls the renderer itself, rather
 * than taking pre-rendered HTML from a caller who could be handed the body by
 * mistake.
 * Enforced by test/dashboard/comment-body.test.tsx.
 */
export function CommentBody({ body }: { body: string }) {
  return <div className="charcha-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
}
