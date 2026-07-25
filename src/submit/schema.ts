// Validation at the boundary. Card rule 5: this Worker's primary surface is a
// public, unauthenticated write endpoint, so every field arrives untrusted and is
// size-capped here, before it can reach the database or the renderer.
//
// The caps are the same numbers as the CHECK constraints in
// migrations/0001_initial.sql. That duplication is deliberate: a field the column
// would reject must be rejected here, with a message the reader can act on, rather
// than surfacing as a 500 from a CHECK constraint. The URL and thread caps are
// imported from src/page-key.ts so there is one source for those two.
// Enforced by test/worker/submit/schema.test.ts.

import { z } from 'zod'
import { MAX_THREAD_ID_LENGTH, MAX_URL_LENGTH } from '../page-key'

/** `comments.body` is `CHECK (length(body) BETWEEN 1 AND 10000)`. */
export const MAX_BODY_LENGTH = 10_000
/** `comments.author_name` is `CHECK (length(author_name) BETWEEN 1 AND 80)`. */
export const MAX_AUTHOR_NAME_LENGTH = 80
/** `comments.author_email` is `CHECK (author_email IS NULL OR length(...) <= 254)`. */
export const MAX_AUTHOR_EMAIL_LENGTH = 254
/** `threads.title` is `CHECK (title IS NULL OR length(title) <= 300)`. */
export const MAX_TITLE_LENGTH = 300

/**
 * What a valid submission is, as the pipeline consumes it. Input/output are kept
 * separate on purpose (api-and-interface-design): this is not `z.infer` of the
 * schema, so absent optionals are absent keys rather than `undefined` values, and
 * the type the rest of the Worker sees does not move when the schema's internals do.
 */
export interface ValidatedComment {
  authorName: string
  body: string
  authorEmail?: string
  parentId?: number
  /** The reported `location.href`. Still untrusted — derivePageKey re-validates it. */
  url?: string
  /** The `data-thread` override. Still untrusted — derivePageKey re-validates it. */
  thread?: string
  title?: string
}

/**
 * A parse that either produced a value or a single sentence the reader can act on.
 * Generic because the preview route validates a body on its own (#78) and needs
 * the same shape for a `string`.
 */
export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

export type ParseResult = Parsed<ValidatedComment>

// Grouping-safe thousands separator, so the too-long message names the real limit
// without depending on the runtime's locale data.
function withThousands(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// A blank optional string means "not provided", not "provided and invalid". The
// embed sends "" for an email the reader left empty; without this it would fail
// the email-format check and turn a blank field into a 400.
const blankToAbsent = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const nullishToAbsent = (value: unknown) =>
  value === null || value === undefined || value === '' ? undefined : value

const BODY_TOO_LONG = `Your comment is too long (maximum ${withThousands(MAX_BODY_LENGTH)} characters).`

const BODY_REQUIRED = 'A comment is required.'

/**
 * What a comment body may be, on its own and apart from the rest of a submission.
 *
 * Named and exported because two endpoints validate one: the write, through the
 * object below, and the composer's preview (#78), which has a body and nothing
 * else. Sharing the schema — not merely the number — is what makes the preview
 * refuse exactly what the write would refuse, in the same words, so a draft that
 * previews cleanly cannot then fail to post for a reason the reader was not shown.
 *
 * The same message for a missing, empty, or non-string body: the reader's problem
 * is identical ("there is no comment"), and the type-machinery default ("expected
 * string, received number") is both unhelpful and a small internal leak.
 * Enforced by test/worker/submit/schema.test.ts and test/worker/preview/route.test.ts.
 */
export const commentBodySchema = z
  .string({ error: BODY_REQUIRED })
  .trim()
  .min(1, BODY_REQUIRED)
  .max(MAX_BODY_LENGTH, BODY_TOO_LONG)

const schema = z.object(
  {
    body: commentBodySchema,

    authorName: z
      .string({ error: 'A name is required.' })
      .trim()
      .min(1, 'A name is required.')
      .max(
        MAX_AUTHOR_NAME_LENGTH,
        `That name is too long (maximum ${MAX_AUTHOR_NAME_LENGTH} characters).`,
      ),

    authorEmail: z.preprocess(
      blankToAbsent,
      z
        .email('That email address is not valid.')
        .max(MAX_AUTHOR_EMAIL_LENGTH, 'That email address is too long.')
        .optional(),
    ),

    parentId: z.preprocess(
      nullishToAbsent,
      z
        .number({ error: 'That reply could not be posted.' })
        .int('That reply could not be posted.')
        .positive('That reply could not be posted.')
        .optional(),
    ),

    // Length only. Whether the URL parses, uses an allowed scheme, and which key it
    // maps to are all derivePageKey's job — re-validated there, never trusted here.
    url: z.preprocess(
      blankToAbsent,
      z.string().max(MAX_URL_LENGTH, 'That page address is too long.').optional(),
    ),

    thread: z.preprocess(
      blankToAbsent,
      z.string().max(MAX_THREAD_ID_LENGTH, 'That thread id is not valid.').optional(),
    ),

    title: z.preprocess(
      blankToAbsent,
      z.string().trim().max(MAX_TITLE_LENGTH, 'That page title is too long.').optional(),
    ),
  },
  { error: 'Those comment details are not valid.' },
)

type SchemaOutput = z.infer<typeof schema>

// Absent optionals become absent keys, not `undefined` values, so nothing
// downstream has to tell "sent as empty" apart from "not sent".
function clean(data: SchemaOutput): ValidatedComment {
  const value: ValidatedComment = { authorName: data.authorName, body: data.body }
  if (data.authorEmail !== undefined) value.authorEmail = data.authorEmail
  if (data.parentId !== undefined) value.parentId = data.parentId
  if (data.url !== undefined) value.url = data.url
  if (data.thread !== undefined) value.thread = data.thread
  if (data.title !== undefined) value.title = data.title
  return value
}

/**
 * Validates one parsed JSON body into a ValidatedComment, or a single
 * reader-facing message naming what to fix. One message, not the whole issue list:
 * the reader fixes one thing at a time, and a flattened Zod error is both noisier
 * and a wider internal surface than a public endpoint should hand back.
 * Enforced by test/worker/submit/schema.test.ts.
 */
export function parseComment(input: unknown): ParseResult {
  const result = schema.safeParse(input)
  if (result.success) return { ok: true, value: clean(result.data) }

  const message = result.error.issues[0]?.message ?? 'Those comment details are not valid.'
  return { ok: false, message }
}

/**
 * Validates a comment body on its own — the whole of what the preview route needs
 * (#78) — through the very schema the submission uses for the same field.
 *
 * It returns the *trimmed* body, which is what makes the preview honest: the write
 * trims before it stores, so rendering the untrimmed draft would differ from the
 * published comment by whatever the reader typed at the edges.
 * Enforced by test/worker/preview/route.test.ts.
 */
export function parseCommentBody(input: unknown): Parsed<string> {
  const result = commentBodySchema.safeParse(input)
  if (result.success) return { ok: true, value: result.data }

  return { ok: false, message: result.error.issues[0]?.message ?? BODY_REQUIRED }
}
