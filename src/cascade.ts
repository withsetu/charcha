// Which moderation decisions take a comment's replies with them, in one place.
//
// **It is its own module because two TypeScript projects need it and neither can
// import the other's.** The statement that performs the cascade is `MODERATE_SQL` in
// src/db/index.ts, which names `D1Database` and so belongs to the Worker's program; the
// dashboard removes those replies from the list optimistically (#133) and lives in
// src/dashboard/tsconfig.json, which has no Cloudflare types. Writing the set out twice
// was the obvious answer and the wrong one: nothing typechecks a TypeScript predicate
// against a SQL string, so a third cascading status would leave the queue showing rows
// the server had already hidden — with live Approve buttons on them, which is the defect
// #133 exists to fix — and every test in both projects would stay green.
//
// So there is one definition and no mirror to keep. It imports nothing, which is what
// lets both programs have it, the same way src/render/markdown reaches the dashboard.

/**
 * The statuses whose decision also moves the comment's direct replies.
 *
 * Hiding a comment hides the replies underneath it — otherwise removing a spam comment
 * leaves the replies to it on the page, answering something no reader can see.
 * Approving is deliberately absent: each reply is still judged on its own.
 *
 * **The membership of this list is asserted by the tests that name a status outright**,
 * not by the one parameterised over `cascades` — that one follows this constant, so it
 * agrees with whatever is put here. Adding `approved` fails "approving reports none" and
 * "does not approve the replies when the parent is approved".
 * Enforced by test/worker/db/comments.test.ts.
 */
export const CASCADING_STATUSES = ['spam', 'deleted'] as const

/**
 * Whether a decision cascades. Takes a `string` rather than a status union because the
 * two callers have different unions for the same four values, and this is the one fact
 * they share.
 */
export function cascades(status: string): boolean {
  return (CASCADING_STATUSES as readonly string[]).includes(status)
}

/**
 * The same set as a SQL list, for interpolation into `MODERATE_SQL`.
 *
 * **Interpolation into a statement, which this project otherwise never does** — so it is
 * worth being explicit about why it is not the hole it resembles. The values are the
 * frozen literals above, fixed at build time, reachable from no input and no binding;
 * there is nothing here a caller can influence. The alternative was a hand-written
 * `in ('spam', 'deleted')` in the statement, which is a second copy of the list and the
 * whole thing this module exists to prevent. The statement's *parameters* are bound as
 * they always were.
 * Enforced by test/worker/db/comments.test.ts and test/worker/db/query-plan.test.ts.
 */
export const CASCADING_STATUSES_SQL = CASCADING_STATUSES.map((status) => `'${status}'`).join(', ')
