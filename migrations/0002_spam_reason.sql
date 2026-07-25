-- Why a comment was held. Designed on issue #70.
--
-- #8's layers have three outcomes and use `review` for every judgement they are
-- not certain about — Turnstile unreachable, no timing field, a link-heavy body.
-- Each carries a reason, and until this column existed the pipeline computed it,
-- logged it, and dropped it: a held comment and a clean one were byte-identical
-- rows, both `pending`, and the human gate was being asked to decide without
-- being told why it was asked.
--
-- Nullable, and null is the common case: it is set only when the verdict was
-- `review`, so an allowed comment stores nothing and the column costs a spam-free
-- site nothing but the NULL.
--
-- The length cap is not decoration. One reason reaching here is
-- `turnstile: <error-codes joined>`, and `error-codes` is a JSON array from
-- siteverify — a response from outside this Worker, of no bounded length. Card
-- rule 5 is size caps everywhere, including on input that arrives from a
-- third party rather than from a commenter. src/db/index.ts bounds the value before
-- binding it; this CHECK is what holds for a caller that did not, the importer
-- (#15) included.
--
-- **The cap counts bytes, over a BLOB cast, rather than characters.** SQLite's
-- length(X) on a text value "returns the number of characters prior to the first
-- NUL character", so a value whose second byte is NUL measures 1 however long it
-- really is, and a text-length CHECK would have admitted five kilobytes. JSON
-- permits an escaped NUL, and the untrusted source named above is a JSON array, so
-- that byte is reachable from exactly the input this cap exists for — which made the
-- backstop inert against the one caller it was written for. Found by review, not by
-- the tests, which is why the test file now inserts a NUL-bearing value directly.
-- Source: https://sqlite.org/lang_corefunc.html#length (checked 2026-07-25)
-- Enforced by test/worker/db/spam-reason.test.ts.
ALTER TABLE comments ADD COLUMN spam_reason TEXT
  CHECK (
    spam_reason IS NULL
    OR (length(CAST(spam_reason AS BLOB)) BETWEEN 1 AND 200)
  );
