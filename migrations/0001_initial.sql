-- Charcha initial schema. Designed on issue #3.
--
-- Two facts from the D1 free tier shape this file: a Worker invocation may issue
-- at most 50 queries, and the account gets 5M row reads a day. So rendering a page
-- is a fixed two queries regardless of comment count, and comments_by_thread is
-- what keeps a hot page from reading every comment in the database.

CREATE TABLE threads (
  id         INTEGER PRIMARY KEY,
  page_key   TEXT    NOT NULL UNIQUE, -- canonical page identity, sent by the embed
  page_url   TEXT,                    -- last seen absolute URL, for the dashboard
  title      TEXT,                    -- last seen page title, for the queue
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE comments (
  id           INTEGER PRIMARY KEY,
  thread_id    INTEGER NOT NULL REFERENCES threads(id)  ON DELETE CASCADE,
  parent_id    INTEGER          REFERENCES comments(id) ON DELETE CASCADE,
  depth        INTEGER NOT NULL DEFAULT 0 CHECK (depth IN (0, 1)),
  author_name  TEXT    NOT NULL,
  author_email TEXT,                  -- reply notifications only; never rendered
  body         TEXT    NOT NULL,      -- Markdown source, rendered on read
  body_hash    TEXT    NOT NULL,      -- duplicate detection
  status       TEXT    NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'spam', 'deleted')),
  by_owner     INTEGER NOT NULL DEFAULT 0 CHECK (by_owner IN (0, 1)),
  ip_hash      TEXT,                  -- HMAC of the IP address, never the address
  created_at   INTEGER NOT NULL,
  moderated_at INTEGER,
  CHECK (parent_id IS NOT NULL OR depth = 0),
  CHECK (parent_id IS NULL     OR depth = 1)
);

-- Threading stops at two levels. `depth` alone cannot say so, because the rule is
-- about the parent's depth, so the database enforces it and fails closed if a
-- future code path forgets. One row read per insert, against 100k writes a day.
-- Enforced by test/worker/db/comments.test.ts.
CREATE TRIGGER comments_depth_guard BEFORE INSERT ON comments
WHEN NEW.parent_id IS NOT NULL
 AND (SELECT depth FROM comments WHERE id = NEW.parent_id) <> 0
BEGIN
  SELECT RAISE(ABORT, 'replies may not be nested more than one level');
END;

CREATE TABLE comment_vectors (
  comment_id INTEGER PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  label      TEXT NOT NULL CHECK (label IN ('ham', 'spam')),
  model      TEXT NOT NULL,
  vector     BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Rendering a page: one seek, then only this thread's approved rows.
CREATE INDEX comments_by_thread ON comments (thread_id, status, created_at, id);
-- The moderation queue: one status across every thread, newest first.
CREATE INDEX comments_by_status ON comments (status, created_at DESC);
-- Replies, and cascade deletes.
CREATE INDEX comments_by_parent ON comments (parent_id) WHERE parent_id IS NOT NULL;
-- Rate limiting. Partial, so rows whose ip_hash has been purged cost nothing.
CREATE INDEX comments_by_ip ON comments (ip_hash, created_at) WHERE ip_hash IS NOT NULL;
-- Duplicate-body detection.
CREATE INDEX comments_by_body ON comments (thread_id, body_hash);
-- The dashboard's thread list, most recently active first.
CREATE INDEX threads_by_updated ON threads (updated_at DESC);

CREATE INDEX comment_vectors_by_label ON comment_vectors (label, created_at);
