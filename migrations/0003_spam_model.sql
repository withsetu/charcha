-- Layer 6's model (#10): the weights the classifier reads on every submission.
--
-- **One row, and the CHECK is what says so.** The submission path reads this table
-- on the busiest write endpoint in the Worker, so the read has to be a rowid seek
-- that cannot become anything else as the table grows — and a table that cannot
-- hold a second row cannot grow. `id = 1` is the whole of the key.
--
-- **The weights are one vector, not a corpus, and that is the design.** Classifying
-- is `sigmoid(w . x + bias)`: one dot product, constant CPU however many comments
-- have been moderated. The alternative — comparing a new comment against every
-- stored labelled vector — is N dot products of real JavaScript execution against a
-- 10 ms CPU limit ("CPU time measures how long the CPU spends executing your Worker
-- code. Waiting on network requests [...] does not count toward CPU time",
-- https://developers.cloudflare.com/workers/platform/limits/, checked 2026-07-29),
-- and it grows into that limit as the site's history accumulates. The embedding call
-- itself is a subrequest and costs no CPU at all; the comparison is the only part
-- that does, which is why it is the part held constant.
-- Enforced by test/worker/spam/classifier.test.ts.
--
-- `dims` is stored rather than assumed. Cloudflare does not publish an
-- `output_dimensions` for @cf/baai/bge-m3 — its model schema carries `context_window`
-- and nothing else, where its siblings carry the field — so this deployment learns
-- its own embedding width from the first real response and refuses anything that
-- disagrees with it afterwards. A hardcoded constant would have been a guess that
-- fails silently by writing half a vector.
-- Enforced by test/worker/spam/train.test.ts.
CREATE TABLE spam_model (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  model      TEXT    NOT NULL,   -- the Workers AI model id these weights were fitted on
  dims       INTEGER NOT NULL CHECK (dims BETWEEN 1 AND 4096),
  weights    BLOB    NOT NULL,   -- little-endian float32, dims * 4 bytes
  bias       REAL    NOT NULL,
  -- Both counts gate the classifier independently: a site with 300 spam and 4 ham has
  -- no ham model, and a single total would hide that. See MIN_LABELS_PER_CLASS.
  ham_count  INTEGER NOT NULL DEFAULT 0 CHECK (ham_count  >= 0),
  spam_count INTEGER NOT NULL DEFAULT 0 CHECK (spam_count >= 0),
  updated_at INTEGER NOT NULL
);
