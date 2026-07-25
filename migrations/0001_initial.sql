-- Charcha initial schema. Designed on issue #3.
--
-- Two facts from the D1 free tier shape this file: a Worker invocation may issue
-- at most 50 queries, and the account gets 5M row reads a day. So rendering a page
-- is a fixed two queries regardless of comment count, and comments_by_thread is
-- what keeps a hot page from reading every comment in the database.

-- Size caps are in the schema as well as at the request boundary, because the
-- boundary is not the only writer: the Disqus importer (#15) writes here too. Card
-- rule 5 — size caps everywhere, fail closed.
-- Enforced by test/worker/db/limits.test.ts.
CREATE TABLE threads (
  id         INTEGER PRIMARY KEY,
  page_key   TEXT    NOT NULL UNIQUE, -- canonical page identity, derived in the Worker
                                      -- by src/page-key.ts, never sent by the embed
  page_url   TEXT,                    -- last seen absolute URL, for the dashboard
  title      TEXT,                    -- last seen page title, for the queue
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(page_key) BETWEEN 1 AND 512),
  CHECK (page_url IS NULL OR length(page_url) <= 2048),
  CHECK (title    IS NULL OR length(title)    <= 300)
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
  CHECK (parent_id IS NULL     OR depth = 1),
  CHECK (length(author_name)  BETWEEN 1 AND 80),
  CHECK (length(body)         BETWEEN 1 AND 10000),
  CHECK (author_email IS NULL OR length(author_email) <= 254)
);

-- Threading stops at two levels. `depth` alone cannot say so, because the rule is
-- about the parent's depth, so the database enforces it rather than the caller.
-- One indexed row read per guard that fires, against 100k writes a day.
--
-- Two triggers, because a rule enforced only on insert is not a rule: `update
-- comments set parent_id = ...` walks past a BEFORE INSERT guard and nests a
-- reply three deep (#29). SQLite has no `INSERT OR UPDATE` trigger, so the pair
-- is written out twice rather than shared.
--
-- `UPDATE OF` fires on a column appearing in the SET clause, not on its value
-- changing, so moderation — status, moderated_at, body — never reaches these.
-- It also silently ignores column names that do not exist, which means a typo or
-- a rename here disarms the guard without any error: the tests are the only
-- thing that would notice.
-- Enforced by test/worker/db/threading-triggers.test.ts.
CREATE TRIGGER comments_depth_guard BEFORE INSERT ON comments
WHEN NEW.parent_id IS NOT NULL
 AND (SELECT depth FROM comments WHERE id = NEW.parent_id) <> 0
BEGIN
  SELECT RAISE(ABORT, 'replies may not be nested more than one level');
END;

CREATE TRIGGER comments_depth_guard_on_update BEFORE UPDATE OF parent_id, thread_id ON comments
WHEN NEW.parent_id IS NOT NULL
 AND (SELECT depth FROM comments WHERE id = NEW.parent_id) <> 0
BEGIN
  SELECT RAISE(ABORT, 'replies may not be nested more than one level');
END;

-- A reply must be on the page it is replying to. `parent_id` arrives from a public
-- form, so without this a comment can be attached to a conversation on a different
-- page — which renders as a reply with no parent in sight, and lets anyone graft
-- their comment onto a thread they were not posting to. This rule lives only here:
-- unlike depth, no CHECK constraint restates it, so the trigger is the whole of it.
--
-- Paired on update for the same reason as the depth guard: `update comments set
-- thread_id = ...` would otherwise move a comment onto a page it was never posted
-- to (#29). Both directions of the edge are covered when the *reply* is the row
-- being written; moving a row that has replies of its own is #60.
-- Enforced by test/worker/db/threading-triggers.test.ts.
CREATE TRIGGER comments_parent_thread_guard BEFORE INSERT ON comments
WHEN NEW.parent_id IS NOT NULL
 AND (SELECT thread_id FROM comments WHERE id = NEW.parent_id) <> NEW.thread_id
BEGIN
  SELECT RAISE(ABORT, 'a reply must be on the same page as the comment it replies to');
END;

CREATE TRIGGER comments_parent_thread_guard_on_update BEFORE UPDATE OF parent_id, thread_id ON comments
WHEN NEW.parent_id IS NOT NULL
 AND (SELECT thread_id FROM comments WHERE id = NEW.parent_id) <> NEW.thread_id
BEGIN
  SELECT RAISE(ABORT, 'a reply must be on the same page as the comment it replies to');
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
-- The per-thread rate limit (#69): this thread's comments inside a time window,
-- at *any* status — a spammer's pending and already-rejected comments are exactly
-- the ones that should count against them.
--
-- Not redundant with comments_by_thread, and neither can absorb the other.
-- That one leads (thread_id, status, ...), so a query with no status predicate
-- cannot reach its created_at column: SQLite seeks the thread and then filters one
-- index entry per comment on the page, on every submission including the ones
-- about to be rejected. Reordering it to put created_at first would move the same
-- cost onto the page read, which is the hotter path and the one bounded by the
-- account-wide 5M row reads a day rather than by one page.
--
-- The write it costs is the trade: D1 counts one extra row written per index whose
-- columns a write touches, so this adds one to the handful an accepted comment
-- already costs, against 100k a day. Moderation pays nothing — it sets status and
-- moderated_at, neither of which is on this index. So the write is paid only on
-- comments that are *stored*, while the read it saves was paid on every submission
-- attempt, which is the number an attacker controls.
-- Source: https://developers.cloudflare.com/d1/platform/pricing/ (checked 2026-07-25)
-- Enforced by test/worker/spam/query-plan.test.ts.
CREATE INDEX comments_by_thread_time ON comments (thread_id, created_at);
-- The moderation queue: one status across every thread, newest first.
CREATE INDEX comments_by_status ON comments (status, created_at DESC);
-- Replies, and cascade deletes.
CREATE INDEX comments_by_parent ON comments (parent_id) WHERE parent_id IS NOT NULL;
-- Rate limiting. Partial, so rows whose ip_hash has been purged cost nothing.
CREATE INDEX comments_by_ip ON comments (ip_hash, created_at) WHERE ip_hash IS NOT NULL;
-- Duplicate-body detection, over a window: all three of DUPLICATE_BODY_SQL's
-- predicates, so the answer comes from the index alone.
--
-- `created_at` is on this index because comments_by_thread_time exists, not merely
-- because the query mentions it. That index answers two of the same three
-- predicates, and SQLite chose it here the moment it was added — turning an exact
-- two-column seek into a window scan filtered on body_hash. A third column makes
-- this one strictly the more constrained candidate, so the planner's estimates no
-- longer get a say.
-- Enforced by test/worker/spam/query-plan.test.ts.
CREATE INDEX comments_by_body ON comments (thread_id, body_hash, created_at);
-- The dashboard's thread list, most recently active first.
CREATE INDEX threads_by_updated ON threads (updated_at DESC);

CREATE INDEX comment_vectors_by_label ON comment_vectors (label, created_at);
