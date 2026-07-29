// The moderation inbox training the classifier (#10), and the guard that keeps #28's
// mislabelled replies out of it.
//
// The invariant every test here is about:
//
//   > A row in `comment_vectors`, and a count in `spam_model`, records a decision a
//   > human made about that specific comment. Neither is ever a copy of
//   > `comments.status`.
//
// `status` is written by four things that are not a person — the reply cascade, spam
// layers 1 to 5, this classifier's own verdict, and the importer (#15). The cascade
// is the worst of them, because a reply to a spam comment is disproportionately a
// *good* comment: somebody engaged enough to answer. That is label error correlated
// with the thing being classified, which is the kind that does not average out.
//
// No test here touches the real `AI` binding; see test/worker/spam/classifier.test.ts
// for why it cannot.

import { Hono } from 'hono'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  getOrCreateThread,
  insertComment,
  pruneCommentVectors,
  readSpamModel,
  setCommentStatus,
  writeCommentVector,
} from '../../../src/db'
import { COMMENT_STATUS_PATH, handleCommentStatus } from '../../../src/admin/route'
import { SESSION_COOKIE_NAME, issueSession } from '../../../src/admin/session'
import { classifierLayer } from '../../../src/spam/classifier'
import type { Embedder } from '../../../src/spam/embed'
import { ELAPSED_FIELD, HONEYPOT_FIELD } from '../../../src/spam/fields'
import {
  EMBEDDING_MODEL,
  MIN_LABELS_PER_CLASS,
  encodeWeights,
  toUnitVector,
} from '../../../src/spam/model'
import {
  MAX_VECTORS_PER_LABEL,
  PRUNE_EVERY,
  trainOnDecision,
  trainOnDecisionSafely,
} from '../../../src/spam/train'
import { createSpamCheck } from '../../../src/spam'
import { contextFor } from './context'
import { TEST_PASSWORD, configurePassword, restorePassword } from '../admin/env'

const db = env.DB
const t0 = 1_753_300_000
const DIMS = 16

function unit(index: number): Float32Array {
  const vector = new Float32Array(DIMS)
  vector[index] = 1
  return toUnitVector(vector)!
}

/** An embedder that maps a body to an axis by its first character. Deterministic, no AI. */
const embed: Embedder = (text) => Promise.resolve(unit(text.charCodeAt(0) % DIMS))

/**
 * The real moderation handler, on the real path, with an embedder injected.
 *
 * `src/index.ts` registers the same handler with no config, which is why driving it
 * through `exports.default.fetch` cannot exercise training at all — that route
 * reaches the live `AI` binding. `AdminRouteConfig.embed` exists for exactly this,
 * and until this test used it, nothing did.
 */
const moderationApp = new Hono<{ Bindings: Env }>()
moderationApp.post(COMMENT_STATUS_PATH, (c) =>
  handleCommentStatus(c, { embed, now: () => t0 + 10 }),
)

let threadId: number

async function comment(body: string, parentId: number | null = null): Promise<number> {
  const stored = await insertComment(db, {
    threadId,
    parentId,
    authorName: 'Someone',
    body,
    bodyHash: `h-${body.slice(0, 20)}-${String(Math.random())}`,
    now: t0,
  })
  return stored.id
}

async function vectorRows(): Promise<{ comment_id: number; label: string; model: string }[]> {
  const { results } = await db
    .prepare('select comment_id, label, model from comment_vectors order by comment_id')
    .all<{ comment_id: number; label: string; model: string }>()
  return results
}

beforeEach(async () => {
  await db.exec('DELETE FROM comment_vectors')
  await db.exec('DELETE FROM spam_model')
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  threadId = (await getOrCreateThread(db, { pageKey: '/notes/training', now: t0 })).id
})

describe('#28 — the cascade must not become training data', () => {
  it('labels only the comment the moderator acted on, never the replies it took down', async () => {
    // The defect #28 describes, driven end to end. A moderator marks one root comment
    // spam; `setCommentStatus` marks four replies spam as well, and no human read any
    // of them. If those four became training examples, the classifier would learn
    // that ordinary sentences under a spam comment are spam.
    const root = await comment('buy cheap watches from my site right now')
    const replies: number[] = []
    for (let i = 0; i < 4; i++) {
      replies.push(await comment(`this is spam, please remove it (${String(i)})`, root))
    }

    const decision = await setCommentStatus(db, root, 'spam', t0 + 10)
    await trainOnDecision(root, 'spam', { db, embed, now: t0 + 10 })

    // The replies really were moved — otherwise this test would pass on a cascade
    // that had quietly stopped happening, and prove nothing about the guard.
    expect(decision.cascaded).toBe(4)
    const { results: cascaded } = await db
      .prepare('select count(*) as n from comments where status = ?1')
      .bind('spam')
      .all<{ n: number }>()
    expect(cascaded[0]!.n).toBe(5)

    // And exactly one of the five is a training example.
    expect(await vectorRows()).toEqual([
      { comment_id: root, label: 'spam', model: EMBEDDING_MODEL },
    ])

    const model = await readSpamModel(db)
    expect(model).toMatchObject({ spamCount: 1, hamCount: 0 })
  })

  it('records the same one label through the real moderation handler', async () => {
    // Through the handler rather than the function, because the guard is structural:
    // the handler has only the id from the request path to give, and the cascade's
    // reach comes back as a count rather than as ids. There is no reply id at that
    // call site to pass by mistake.
    //
    // **It passes an embedder, and that is what makes the assertion mean anything.**
    // Driving the endpoint through `fetch` reaches the real `AI` binding, which
    // cannot be used in tests — so training abstains, *nothing* is written, and the
    // test would pass identically if the handler looped over every cascaded reply
    // and labelled each one. That version of this test read as coverage of the
    // branch's headline property and enforced nothing; found in review. With a
    // stand-in the training really runs, so exactly one row is the real assertion.
    configurePassword(TEST_PASSWORD)
    try {
      const root = await comment('a comment somebody will reply to before it is judged')
      for (let i = 0; i < 3; i++) await comment(`a reply number ${String(i)}`, root)
      const { token } = await issueSession(TEST_PASSWORD, Math.floor(Date.now() / 1000))

      const response = await moderationApp.fetch(
        new Request(`https://charcha.example/admin/api/comments/${String(root)}/status`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: `${SESSION_COOKIE_NAME}=${token}`,
          },
          body: JSON.stringify({ status: 'spam' }),
        }),
        env,
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ cascaded: 3 })

      // Training ran — so the one row is a guard that fired, not an absence.
      expect(await vectorRows()).toEqual([
        { comment_id: root, label: 'spam', model: EMBEDDING_MODEL },
      ])
      expect(await readSpamModel(db)).toMatchObject({ spamCount: 1, hamCount: 0 })
    } finally {
      restorePassword()
    }
  })
})

describe('which decisions are a label at all', () => {
  it('trains ham on approve and spam on spam', async () => {
    const approved = await comment('a real comment from a real person, approved')
    const rejected = await comment('zero-cost pills, click here now')

    expect(await trainOnDecision(approved, 'approved', { db, embed, now: t0 })).toBe('trained')
    expect(await trainOnDecision(rejected, 'spam', { db, embed, now: t0 })).toBe('trained')

    expect(await readSpamModel(db)).toMatchObject({ hamCount: 1, spamCount: 1 })
  })

  it('trains nothing on delete, which is not a spam judgement', async () => {
    // A comment is deleted for reasons that have nothing to do with spam — it is
    // off-topic, it is abusive, its author asked. Filing every deletion under spam
    // would teach the model that unwanted and spam are the same word.
    const id = await comment('an off-topic comment the owner took down')

    expect(await trainOnDecision(id, 'deleted', { db, embed, now: t0 })).toBe('not-a-decision')
    expect(await vectorRows()).toEqual([])
    expect(await readSpamModel(db)).toBeNull()
  })

  it('trains nothing on a move back to pending, which is un-deciding', async () => {
    const id = await comment('a comment the moderator put back in the queue')

    expect(await trainOnDecision(id, 'pending', { db, embed, now: t0 })).toBe('not-a-decision')
    expect(await vectorRows()).toEqual([])
  })

  it('answers no-such-comment for an id that is not one, and writes nothing', async () => {
    expect(await trainOnDecision(999_999, 'spam', { db, embed, now: t0 })).toBe('no-such-comment')
    expect(await vectorRows()).toEqual([])
  })
})

describe('the same decision twice', () => {
  it('trains once, however many times the button is clicked', async () => {
    // Without this, a double-clicked Approve — or a dashboard retrying a request it
    // thought had failed — applies the same gradient again, so one comment counts as
    // two examples and the cold-start gate can be walked past by clicking.
    const id = await comment('a comment approved twice by an impatient moderator')

    expect(await trainOnDecision(id, 'approved', { db, embed, now: t0 })).toBe('trained')
    expect(await trainOnDecision(id, 'approved', { db, embed, now: t0 + 1 })).toBe(
      'already-labelled',
    )
    expect(await trainOnDecision(id, 'approved', { db, embed, now: t0 + 2 })).toBe(
      'already-labelled',
    )

    expect(await readSpamModel(db)).toMatchObject({ hamCount: 1, spamCount: 0 })
    expect(await vectorRows()).toHaveLength(1)
  })

  it('moves the comment between classes when the moderator changes their mind', async () => {
    const id = await comment('a comment judged one way and then the other')

    await trainOnDecision(id, 'approved', { db, embed, now: t0 })
    expect(await readSpamModel(db)).toMatchObject({ hamCount: 1, spamCount: 0 })

    await trainOnDecision(id, 'spam', { db, embed, now: t0 + 5 })

    // One example, not two. The counts are "how many examples of each", and a
    // corrected decision is a correction rather than a second comment.
    expect(await readSpamModel(db)).toMatchObject({ hamCount: 0, spamCount: 1 })
    expect(await vectorRows()).toEqual([{ comment_id: id, label: 'spam', model: EMBEDDING_MODEL }])
  })
})

describe('when the embedding cannot be taken', () => {
  it('writes nothing at all rather than a half-trained model', async () => {
    const id = await comment('a comment moderated while Workers AI is unavailable')

    const outcome = await trainOnDecision(id, 'spam', {
      db,
      embed: () => Promise.resolve(null),
      now: t0,
    })

    expect(outcome).toBe('no-embedding')
    expect(await vectorRows()).toEqual([])
    expect(await readSpamModel(db)).toBeNull()
  })

  it('writes nothing when there is no binding and no stand-in', async () => {
    const id = await comment('a comment on a deployment with no Workers AI at all')

    expect(await trainOnDecision(id, 'spam', { db, now: t0 })).toBe('no-embedding')
    expect(await vectorRows()).toEqual([])
  })
})

describe('training must never fail a decision that is already committed', () => {
  // The moderation write happens before this runs, so nothing here may propagate —
  // and nothing here may vanish either. Found by review: `trainOnDecisionSafely`
  // carried an "Enforced by" naming this file while no test in it called the
  // function at all, which is the #107 failure exactly — a comment sitting where a
  // reader goes to verify the property, suppressing the check.
  function brokenDb(): D1Database {
    return {
      ...db,
      prepare() {
        throw new Error('D1 is having a day')
      },
    } as unknown as D1Database
  }

  it('reports failure rather than throwing', async () => {
    await expect(
      trainOnDecisionSafely(1, 'spam', { db: brokenDb(), embed, now: t0 }),
    ).resolves.toBe('failed')
  })

  it('is the wrapper doing the work, not the function underneath', async () => {
    // The contrast is the assertion. `trainOnDecision` propagates, and the handler
    // calls the wrapper — so if the two were ever swapped at the call site, a
    // classifier fault would become a 500 for the one person doing the moderating.
    await expect(trainOnDecision(1, 'spam', { db: brokenDb(), embed, now: t0 })).rejects.toThrow(
      /D1 is having a day/,
    )
  })

  it('still reports the ordinary outcomes through the safe wrapper', async () => {
    const id = await comment('a comment judged while everything is working')

    expect(await trainOnDecisionSafely(id, 'approved', { db, embed, now: t0 })).toBe('trained')
    expect(await trainOnDecisionSafely(id, 'deleted', { db, embed, now: t0 })).toBe(
      'not-a-decision',
    )
  })
})

describe('the classifier cannot label its own verdicts', () => {
  it('gains no training example from a comment layer 6 held for review', async () => {
    // The degenerate case #9 named and #28 does not cover: a model that treats its
    // own output as ground truth stops learning from reality and amplifies its first
    // mistakes, invisibly, because every decision agrees with the model that made it.
    //
    // It is structurally impossible here — layer 6 returns a verdict and never writes
    // — and this drives the submission path to prove it rather than asserting it.
    for (let i = 0; i < MIN_LABELS_PER_CLASS; i++) {
      const spam = await comment(`Ycheap offers number ${String(i)}`)
      const ham = await comment(`Za thoughtful comment number ${String(i)}`)
      await trainOnDecision(spam, 'spam', { db, embed, now: t0 + i })
      await trainOnDecision(ham, 'approved', { db, embed, now: t0 + i })
    }
    const before = await vectorRows()

    const check = createSpamCheck({}, { classifier: { embed } })
    const verdict = await check.check(
      contextFor({
        form: { [HONEYPOT_FIELD]: '', [ELAPSED_FIELD]: 31_000 },
        body: 'Ycheap offers, the same shape as everything above',
      }),
    )

    // The layer did hold it — otherwise this proves nothing about a layer that
    // never fired.
    expect(verdict).toMatchObject({ action: 'review' })
    expect(String((verdict as { reason: string }).reason)).toContain('classifier')

    // And the training set is untouched by its own verdict.
    expect(await vectorRows()).toEqual(before)
  })

  it('leaves the training set untouched when the spam layers reject a comment', async () => {
    const check = createSpamCheck({}, { classifier: { embed } })

    const verdict = await check.check(
      contextFor({ form: { [HONEYPOT_FIELD]: 'a bot filled this in', [ELAPSED_FIELD]: 31_000 } }),
    )

    expect(verdict.action).toBe('reject')
    expect(await vectorRows()).toEqual([])
  })
})

describe('a model fitted somewhere else', () => {
  it('starts over rather than carrying counts it can no longer read', async () => {
    // Keeping the counts would be worse than useless: they are the cold-start gate,
    // so a model that had learned nothing would be trusted immediately on the
    // strength of a history it cannot read.
    await db
      .prepare(
        `insert into spam_model (id, model, dims, weights, bias, ham_count, spam_count, updated_at)
         values (1, ?1, ?2, ?3, 0, 900, 900, ?4)`,
      )
      .bind('@cf/some/other-model', DIMS, new ArrayBuffer(DIMS * 4), t0)
      .run()

    const id = await comment('the first comment judged after the model id changed')
    await trainOnDecision(id, 'spam', { db, embed, now: t0 + 1 })

    expect(await readSpamModel(db)).toMatchObject({
      model: EMBEDDING_MODEL,
      hamCount: 0,
      spamCount: 1,
    })
  })

  it('starts over when the stored width and the live vector disagree', async () => {
    await db
      .prepare(
        `insert into spam_model (id, model, dims, weights, bias, ham_count, spam_count, updated_at)
         values (1, ?1, ?2, ?3, 0, 900, 900, ?4)`,
      )
      .bind(EMBEDDING_MODEL, DIMS + 8, new ArrayBuffer((DIMS + 8) * 4), t0)
      .run()

    const id = await comment('the first comment judged after the width changed')
    await trainOnDecision(id, 'spam', { db, embed, now: t0 + 1 })

    expect(await readSpamModel(db)).toMatchObject({ dims: DIMS, hamCount: 0, spamCount: 1 })
  })
})

describe('the cost of training', () => {
  it('spends four statements, whatever the site has already moderated', async () => {
    // The subject read, the model read, the vector write, the model write. Constant:
    // none of them is per stored vector, and none is per reply the decision moved.
    // The prune is the only conditional statement and runs once every PRUNE_EVERY
    // decisions past the cap — see below.
    const first = await comment('the very first comment this site ever moderated')
    await trainOnDecision(first, 'spam', { db, embed, now: t0 })

    for (let i = 0; i < 40; i++) {
      const id = await comment(`an earlier decision number ${String(i)}`)
      await trainOnDecision(id, i % 2 === 0 ? 'spam' : 'approved', { db, embed, now: t0 + i })
    }

    const statements: string[] = []
    const counting = {
      ...db,
      prepare(sql: string) {
        statements.push(sql)
        return db.prepare(sql)
      },
    } as unknown as D1Database

    const id = await comment('one more comment, on a site with a history behind it')
    await trainOnDecision(id, 'spam', { db: counting, embed, now: t0 + 100 })

    expect(statements).toHaveLength(4)
  })

  it('does not prune until a class is past the cap', async () => {
    const id = await comment('a comment on a site nowhere near the storage cap')
    await trainOnDecision(id, 'spam', { db, embed, now: t0 })

    expect(MAX_VECTORS_PER_LABEL).toBeGreaterThan(PRUNE_EVERY)
    expect(await vectorRows()).toHaveLength(1)
  })
})

describe('pruning the training log (#10 — bounded storage)', () => {
  // The statement is a DELETE on the only record of what a human ever decided, and
  // `trainOnDecision` runs it only past a cap of 2,000 — which no test can afford to
  // reach. So it is driven directly, with a small `keep`. Without this, a prune that
  // deleted the newest rows, or every row, would pass the whole suite: the caller's
  // tests never trigger it, and the query-plan test only reads the plan.
  async function seedVectors(label: 'ham' | 'spam', count: number, from = 0) {
    for (let i = 0; i < count; i++) {
      const id = await comment(`${label} example number ${String(from + i)}`)
      await writeCommentVector(db, {
        commentId: id,
        label,
        model: EMBEDDING_MODEL,
        vector: encodeWeights(unit(0)),
        // Ascending, so "newest" is unambiguous.
        now: t0 + from + i,
      })
    }
  }

  it('keeps the newest and drops the rest', async () => {
    await seedVectors('spam', 6)

    const deleted = await pruneCommentVectors(db, 'spam', 2)

    expect(deleted).toBe(4)
    const kept = await db
      .prepare('select created_at from comment_vectors order by created_at')
      .all<{ created_at: number }>()
    expect(kept.results.map((row) => row.created_at)).toEqual([t0 + 4, t0 + 5])
  })

  it('touches only the label it was given', async () => {
    // Both classes gate the classifier independently, so a prune that took the other
    // label with it could silently drop a site below the cold-start threshold.
    await seedVectors('spam', 4)
    await seedVectors('ham', 4, 100)

    await pruneCommentVectors(db, 'spam', 1)

    const rows = await vectorRows()
    expect(rows.filter((row) => row.label === 'spam')).toHaveLength(1)
    expect(rows.filter((row) => row.label === 'ham')).toHaveLength(4)
  })

  it('deletes nothing when the class is under the cap', async () => {
    await seedVectors('ham', 3)

    expect(await pruneCommentVectors(db, 'ham', 10)).toBe(0)
    expect(await vectorRows()).toHaveLength(3)
  })
})

describe('the trained classifier, end to end', () => {
  it('goes from abstaining to holding a comment, on decisions alone', async () => {
    // The loop #10 is about, driven in one test: a fresh deployment abstains, the
    // moderator judges comments, and the layer starts holding what looks like what
    // they marked spam. Nothing is written by hand — every count and every weight
    // here came from `trainOnDecision`.
    const layer = classifierLayer({ embed })
    const spammy = contextFor({ body: 'Ybuy cheap watches, limited time only' })

    expect(await layer.run(spammy)).toBeNull()

    for (let i = 0; i < MIN_LABELS_PER_CLASS; i++) {
      const spam = await comment(`Ycheap watches offer number ${String(i)}`)
      const ham = await comment(`Za considered reply number ${String(i)}`)
      await trainOnDecision(spam, 'spam', { db, embed, now: t0 + i })
      await trainOnDecision(ham, 'approved', { db, embed, now: t0 + i })
    }

    expect(await readSpamModel(db)).toMatchObject({
      hamCount: MIN_LABELS_PER_CLASS,
      spamCount: MIN_LABELS_PER_CLASS,
    })
    expect(await layer.run(spammy)).toMatchObject({ action: 'review' })
    expect(
      await layer.run(contextFor({ body: 'Za considered reply about the article' })),
    ).toBeNull()
  })
})
