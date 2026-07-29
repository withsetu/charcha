// The other half of layer 6: the moderation inbox training the classifier (#10).
//
// **The invariant this file exists to hold, and #28 is why it needs a file:**
//
//   > A row in `comment_vectors`, and a count in `spam_model`, records a decision a
//   > human made about that specific comment in the moderation dashboard. Neither is
//   > ever a copy of `comments.status`.
//
// `status` answers "should this appear on the page". It is written by four things
// that are not a person: the reply cascade (#28 — `setCommentStatus` marks the
// replies under a spam comment, and nobody read them), spam layers 1 to 5, this
// classifier's own verdict, and the Disqus importer (#15). Training on any of them
// teaches the model to reproduce a rule it already sits behind; training on the
// cascade is worse than that, because a reply to spam is disproportionately a *good*
// comment — somebody engaged enough to answer — so the label error is correlated
// with the thing being classified and does not average out.
//
// **The guard is structural rather than a filter.** This module is called from one
// place — the authenticated `POST /admin/api/comments/:id/status` handler — with the
// id out of the request path, which is the comment the moderator was looking at. The
// cascade happens inside MODERATE_SQL and `setCommentStatus` returns its reach as a
// *count*, never as ids, so there is no reply id anywhere in the caller's hands to
// pass here by mistake. Nothing filters cascaded rows out, because nothing ever puts
// them in.
// Enforced by test/worker/spam/train.test.ts.

import {
  pruneCommentVectors,
  readSpamModel,
  readTrainingSubject,
  writeCommentVector,
  writeSpamModel,
} from '../db'
import type { CommentStatus } from '../db'
import type { Embedder } from './embed'
import { workersAiEmbedder } from './embed'
import {
  EMBEDDING_MODEL,
  type SpamLabel,
  type SpamModel,
  decodeWeights,
  emptyModel,
  encodeWeights,
  trainedWith,
} from './model'

/**
 * How many labelled vectors are kept per class (#10 — "bounded storage").
 *
 * At the 1,024 dimensions this model is expected to produce, a vector is 4 KB, so
 * two full classes are roughly 17 MB against D1's 500 MB per database. The cap is
 * generous because these rows are not what the classifier reads — the fitted weights
 * already carry every decision ever made, pruned ones included. What the table buys
 * is the ability to refit or calibrate later against real examples (#9 §5, #175),
 * which is worth keeping thousands of and not worth keeping all of.
 */
export const MAX_VECTORS_PER_LABEL = 2000

/**
 * How often the prune runs once a class is past the cap.
 *
 * Not every decision, and that is a row-read bound rather than tidiness. The prune's
 * subquery walks that label's index entries to find the ones past the newest N, so
 * running it on every click would cost ~MAX_VECTORS_PER_LABEL index reads per
 * moderated comment forever. Every fiftieth decision amortises that to about forty,
 * and lets the table sit between the cap and the cap plus this.
 */
export const PRUNE_EVERY = 50

/**
 * What a moderation decision meant for the training set.
 *
 * Reported rather than returned as a boolean, because these are five different
 * things and the difference is exactly what an owner debugging a classifier that
 * "does not learn" needs. `not-a-decision` is the common one and is not a failure.
 */
export type TrainingOutcome =
  'trained' | 'not-a-decision' | 'already-labelled' | 'no-such-comment' | 'no-embedding'

/**
 * Which statuses are a judgement about spam, and which are only a judgement.
 *
 * `approved` and `spam` are the two a moderator makes about whether a comment is
 * what this classifier is trying to recognise. **`deleted` is deliberately neither.**
 * A comment is deleted for reasons that have nothing to do with spam — it is
 * off-topic, it is abusive, its author asked — so filing every deletion under `spam`
 * would teach the model that unwanted and spam are the same word. `pending` is a
 * moderator putting a decision *back*, which is the absence of one.
 * Enforced by test/worker/spam/train.test.ts.
 */
function labelFor(status: CommentStatus): SpamLabel | null {
  if (status === 'approved') return 'ham'
  if (status === 'spam') return 'spam'
  return null
}

export interface TrainingDeps {
  db: D1Database
  /** The Workers AI binding, absent on a deployment that has none. */
  ai?: Ai
  /** Injected by tests in place of the binding. Nothing in production passes it. */
  embed?: Embedder
  now: number
}

/**
 * The model to train from, given what is stored and how wide the live embedding is.
 *
 * Three cases, and the middle one is the reason this is a function. A model fitted
 * on a different embedding model, or at a different width, holds weights that mean
 * nothing about this vector — so it is *replaced*, counts and all, rather than
 * carried forward. Keeping the counts would be worse than useless: they are the
 * cold-start gate, so a model that had learned nothing would be trusted immediately
 * on the strength of a history it can no longer read.
 * Enforced by test/worker/spam/train.test.ts.
 */
function modelToTrain(stored: Awaited<ReturnType<typeof readSpamModel>>, dims: number): SpamModel {
  if (stored === null) return emptyModel(EMBEDDING_MODEL, dims)
  if (stored.model !== EMBEDDING_MODEL || stored.dims !== dims) {
    return emptyModel(EMBEDDING_MODEL, dims)
  }

  const weights = decodeWeights(stored.weights, stored.dims)
  if (weights === null) return emptyModel(EMBEDDING_MODEL, dims)

  return {
    model: stored.model,
    dims: stored.dims,
    weights,
    bias: stored.bias,
    hamCount: stored.hamCount,
    spamCount: stored.spamCount,
  }
}

/**
 * Trains the classifier on one human decision.
 *
 * **`commentId` must be the id the moderator acted on**, never a cascaded reply. See
 * the file header; the caller structurally has nothing else to give.
 *
 * Four statements at most, all constant: the subject read, the model read, the vector
 * write and the model write, plus a prune every PRUNE_EVERY decisions past the cap.
 * None of them grows with the site's history.
 *
 * It never throws. The moderation decision is already committed by the time this
 * runs, and a classifier that could turn a successful takedown into a 500 would be a
 * worse feature than no classifier.
 * Enforced by test/worker/spam/train.test.ts.
 */
export async function trainOnDecision(
  commentId: number,
  status: CommentStatus,
  deps: TrainingDeps,
): Promise<TrainingOutcome> {
  const label = labelFor(status)
  if (label === null) return 'not-a-decision'

  const embed: Embedder | null =
    deps.embed ?? (deps.ai === undefined ? null : workersAiEmbedder(deps.ai))
  if (embed === null) return 'no-embedding'

  const subject = await readTrainingSubject(deps.db, commentId)
  if (subject === null) return 'no-such-comment'

  // **The same decision twice trains nothing.** Without this, a double-clicked
  // Approve button — or a dashboard retrying a request it thought had failed —
  // applies the same gradient again, so one comment counts as two examples and the
  // cold-start gate can be walked past by clicking. A *changed* mind still trains:
  // the labels differ, and that is a moderator correcting the record.
  // Enforced by test/worker/spam/train.test.ts.
  if (subject.priorLabel === label) return 'already-labelled'

  const vector = await embed(subject.body)
  if (vector === null) return 'no-embedding'

  const stored = await readSpamModel(deps.db)
  const base = modelToTrain(stored, vector.length)

  // A re-labelled comment moves between classes rather than adding to both, or the
  // counts stop being "how many examples of each" and the gate reads a history that
  // never happened.
  const corrected: SpamModel =
    subject.priorLabel === null
      ? base
      : {
          ...base,
          hamCount: Math.max(0, base.hamCount - (subject.priorLabel === 'ham' ? 1 : 0)),
          spamCount: Math.max(0, base.spamCount - (subject.priorLabel === 'spam' ? 1 : 0)),
        }

  const trained = trainedWith(corrected, vector, label)

  await writeCommentVector(deps.db, {
    commentId,
    label,
    model: EMBEDDING_MODEL,
    vector: encodeWeights(vector),
    now: deps.now,
  })
  await writeSpamModel(
    deps.db,
    {
      model: trained.model,
      dims: trained.dims,
      weights: encodeWeights(trained.weights),
      bias: trained.bias,
    },
    { hamCount: trained.hamCount, spamCount: trained.spamCount },
    deps.now,
  )

  const kept = label === 'ham' ? trained.hamCount : trained.spamCount
  if (kept > MAX_VECTORS_PER_LABEL && kept % PRUNE_EVERY === 0) {
    await pruneCommentVectors(deps.db, label, MAX_VECTORS_PER_LABEL)
  }

  return 'trained'
}

/**
 * Trains, and reports rather than propagates.
 *
 * The moderation decision has already been written when this is called, so nothing
 * here may fail it — but nothing here may vanish either. CLAUDE.md: a call whose
 * rejection is discarded owes the user a specific message, and the "user" of this one
 * is the site owner reading their own logs, because a classifier that silently stops
 * learning has no symptom at all. It abstains, which is what it also does when it is
 * working.
 * Enforced by test/worker/spam/train.test.ts.
 */
export async function trainOnDecisionSafely(
  commentId: number,
  status: CommentStatus,
  deps: TrainingDeps,
): Promise<TrainingOutcome | 'failed'> {
  try {
    return await trainOnDecision(commentId, status, deps)
  } catch (error) {
    console.error('classifier: training on a moderation decision failed', error)
    return 'failed'
  }
}
