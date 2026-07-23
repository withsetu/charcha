// The data layer. Every query lives here, so the query budget is countable in one
// place: D1's free tier allows 50 queries per Worker invocation, which makes a
// per-comment query a ceiling rather than a slowdown. Rendering a page is
// getOrCreateThread + listThreadComments, and nothing in this file loops.
//
// Times are unix seconds and always passed in, never read from the clock here —
// the caller owns "now" so tests can own it too.

export type CommentStatus = 'pending' | 'approved' | 'spam' | 'deleted'

export interface Thread {
  id: number
  pageKey: string
  pageUrl: string | null
  title: string | null
  createdAt: number
  updatedAt: number
}

/**
 * A comment as the renderer receives it. Deliberately missing `authorEmail` and
 * `ipHash`: the read that produces it does not select those columns, so no
 * template mistake downstream can leak either one.
 * Enforced by test/worker/db/comments.test.ts.
 */
export interface RenderableComment {
  id: number
  parentId: number | null
  depth: number
  authorName: string
  body: string
  byOwner: boolean
  createdAt: number
}

export interface StoredComment extends RenderableComment {
  threadId: number
  status: CommentStatus
  moderatedAt: number | null
}

export interface QueuedComment extends StoredComment {
  pageKey: string
  pageTitle: string | null
}

export interface NewComment {
  threadId: number
  parentId?: number | null
  authorName: string
  authorEmail?: string | null
  body: string
  bodyHash: string
  ipHash?: string | null
  byOwner?: boolean
  status?: CommentStatus
  now: number
}

interface ThreadRow {
  id: number
  page_key: string
  page_url: string | null
  title: string | null
  created_at: number
  updated_at: number
}

interface CommentRow {
  id: number
  thread_id: number
  parent_id: number | null
  depth: number
  author_name: string
  body: string
  by_owner: number
  status: string
  created_at: number
  moderated_at: number | null
}

interface QueuedCommentRow extends CommentRow {
  page_key: string
  page_title: string | null
}

const RENDERABLE_COLUMNS = 'id, parent_id, depth, author_name, body, by_owner, created_at'

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    pageKey: row.page_key,
    pageUrl: row.page_url,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toRenderable(row: Omit<CommentRow, 'thread_id' | 'status' | 'moderated_at'>) {
  return {
    id: row.id,
    parentId: row.parent_id,
    depth: row.depth,
    authorName: row.author_name,
    body: row.body,
    byOwner: row.by_owner === 1,
    createdAt: row.created_at,
  }
}

function toStored(row: CommentRow): StoredComment {
  return {
    ...toRenderable(row),
    threadId: row.thread_id,
    status: row.status as CommentStatus,
    moderatedAt: row.moderated_at,
  }
}

/**
 * Resolves a page to its thread, creating it on first sight. One statement: the
 * upsert is what keeps two readers arriving at once from racing into two rows.
 */
export async function getOrCreateThread(
  db: D1Database,
  input: { pageKey: string; pageUrl?: string | null; title?: string | null; now: number },
): Promise<Thread> {
  const row = await db
    .prepare(
      `insert into threads (page_key, page_url, title, created_at, updated_at)
       values (?1, ?2, ?3, ?4, ?4)
       on conflict (page_key) do update set
         page_url   = excluded.page_url,
         title      = excluded.title,
         updated_at = excluded.updated_at
       returning *`,
    )
    .bind(input.pageKey, input.pageUrl ?? null, input.title ?? null, input.now)
    .first<ThreadRow>()

  if (row === null) throw new Error(`could not open a thread for page ${input.pageKey}`)
  return toThread(row)
}

/**
 * Stores a comment. `depth` is derived in SQL from whether there is a parent, and
 * the comments_depth_guard trigger rejects a reply to a reply — so the two-level
 * rule holds even for a caller that never checked.
 */
export async function insertComment(db: D1Database, input: NewComment): Promise<StoredComment> {
  const row = await db
    .prepare(
      `insert into comments (
         thread_id, parent_id, depth, author_name, author_email, body, body_hash,
         status, by_owner, ip_hash, created_at
       )
       values (?1, ?2, case when ?2 is null then 0 else 1 end, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       returning id, thread_id, parent_id, depth, author_name, body, by_owner, status,
                 created_at, moderated_at`,
    )
    .bind(
      input.threadId,
      input.parentId ?? null,
      input.authorName,
      input.authorEmail ?? null,
      input.body,
      input.bodyHash,
      input.status ?? 'pending',
      input.byOwner === true ? 1 : 0,
      input.ipHash ?? null,
      input.now,
    )
    .first<CommentRow>()

  if (row === null) throw new Error('comment was not stored')
  return toStored(row)
}

/**
 * The page read. One statement for the whole conversation, roots and replies
 * together, ordered so the caller can assemble the tree without sorting.
 */
export async function listThreadComments(
  db: D1Database,
  threadId: number,
): Promise<RenderableComment[]> {
  const { results } = await db
    .prepare(
      `select ${RENDERABLE_COLUMNS}
         from comments
        where thread_id = ?1 and status = 'approved'
        order by created_at, id`,
    )
    .bind(threadId)
    .all<Omit<CommentRow, 'thread_id' | 'status' | 'moderated_at'>>()

  return results.map(toRenderable)
}

/** Records a moderation decision, and refuses to pretend it moderated nothing. */
export async function setCommentStatus(
  db: D1Database,
  commentId: number,
  status: CommentStatus,
  now: number,
): Promise<StoredComment> {
  const row = await db
    .prepare(
      `update comments set status = ?2, moderated_at = ?3
        where id = ?1
       returning id, thread_id, parent_id, depth, author_name, body, by_owner, status,
                 created_at, moderated_at`,
    )
    .bind(commentId, status, now)
    .first<CommentRow>()

  if (row === null) throw new Error(`no comment ${commentId} to moderate`)
  return toStored(row)
}

/** The triage queue: one status across every thread, newest first. */
export async function listModerationQueue(
  db: D1Database,
  status: CommentStatus,
  limit: number,
): Promise<QueuedComment[]> {
  const { results } = await db
    .prepare(
      `select c.id, c.thread_id, c.parent_id, c.depth, c.author_name, c.body, c.by_owner,
              c.status, c.created_at, c.moderated_at,
              t.page_key, t.title as page_title
         from comments c
         join threads t on t.id = c.thread_id
        where c.status = ?1
        order by c.created_at desc, c.id desc
        limit ?2`,
    )
    .bind(status, limit)
    .all<QueuedCommentRow>()

  return results.map((row) => ({
    ...toStored(row),
    pageKey: row.page_key,
    pageTitle: row.page_title,
  }))
}
