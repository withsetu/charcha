// Layer 6 — the classifier, trained on this site's own moderation decisions (#10).
//
// It is last of the local layers and ahead of any third-party provider, which is the
// ordering CLAUDE.md sets and the reason it may cost a subrequest at all: everything
// above it is a string comparison or an indexed read, so a comment the cheap layers
// already decided never reaches Workers AI.
//
// **It can only ever hold a comment for review. It cannot refuse one.** Three
// reasons, and the third is the one that is easy to miss:
//
//   - It is probabilistic where every layer above it is a rule. A false positive on
//     a rule is a bug somebody can find and fix; a false positive here is a real
//     person's comment destroyed by a number nobody can inspect.
//   - Layer 8 — the human — is the gate this project already has. `review` puts the
//     comment in front of them, which is where a judgement call belongs.
//   - **A rejected comment is never stored, so it can never be labelled.** This layer
//     learns only from comments a moderator saw. A classifier allowed to reject would
//     therefore delete its own training data, and the ones it deleted would be
//     exactly the ones it was most confident about — so its mistakes would be the
//     part of the corpus it could never be corrected on.
// Enforced by test/worker/spam/classifier.test.ts.
//
// On this project's submission path a `review` does not hide anything: every public
// comment is stored `pending` regardless (src/submit/pipeline.ts), and what the
// verdict adds is the `spam_reason` the moderator sees while triaging (#70). That is
// the whole of the authority this layer has, and it is deliberately small.

import { readSpamModel } from '../db'
import type { SpamCheckContext } from '../submit/spam'
import type { Embedder } from './embed'
import { workersAiEmbedder } from './embed'
import type { LayerOutcome, SpamLayer } from './layer'
import { announceOnce } from './log'
import {
  EMBEDDING_MODEL,
  SPAM_PROBABILITY_THRESHOLD,
  decodeWeights,
  isTrained,
  spamProbability,
} from './model'

/** The reason token stored against a held comment. Names the signal, never the score. */
export const CLASSIFIER_REASON = 'similar-to-spam'

export interface ClassifierConfig {
  /**
   * The Workers AI binding. Absent means the layer abstains outright — which is what
   * happens on a deployment whose `ai` binding did not come up, and what every test
   * in this project does, because Workers AI has no local simulation.
   */
  ai?: Ai
  /** Injected by tests in place of the binding. Nothing in production passes it. */
  embed?: Embedder
  /** Pinned by tests. Production uses SPAM_PROBABILITY_THRESHOLD. */
  threshold?: number
}

/**
 * Builds layer 6.
 *
 * **The order inside the layer is the order of the pipeline in miniature**, and it is
 * the reason a fresh deployment pays essentially nothing for this feature: the cold
 * start check is a rowid seek on a one-row table, and it happens *before* the
 * embedding. A site that has not trained a model yet never reaches Workers AI at all
 * — no subrequest, no neurons, no latency on the reader's POST — and the same is
 * true of a site whose moderation history is still one-sided.
 * Enforced by test/worker/spam/classifier.test.ts.
 */
export function classifierLayer(config: ClassifierConfig = {}): SpamLayer {
  const threshold = config.threshold ?? SPAM_PROBABILITY_THRESHOLD
  const embed: Embedder | null =
    config.embed ?? (config.ai === undefined ? null : workersAiEmbedder(config.ai))

  return {
    name: 'classifier',
    async run(context: SpamCheckContext): Promise<LayerOutcome> {
      if (embed === null) {
        // Once per isolate. A deployment whose AI binding is missing has no other
        // way to learn that layer 6 is not running — it abstains, which is
        // indistinguishable from a working layer with no opinion.
        announceOnce('classifier:no-binding', {
          event: 'spam_layer_inactive',
          layer: 'classifier',
          reason: 'no-ai-binding',
        })
        return null
      }

      const stored = await readSpamModel(context.db)
      if (stored === null) return null

      // The cold-start gate, and it is checked before anything is spent. CLAUDE.md:
      // "Cold start must abstain, not guess." Below MIN_LABELS_PER_CLASS human
      // decisions in *each* class there is no model worth consulting, and asking one
      // anyway would be guessing with a decimal point on it.
      const weights = decodeWeights(stored.weights, stored.dims)
      if (weights === null) return null

      const model = {
        model: stored.model,
        dims: stored.dims,
        weights,
        bias: stored.bias,
        hamCount: stored.hamCount,
        spamCount: stored.spamCount,
      }
      if (!isTrained(model)) return null

      // Weights fitted in one embedding space say nothing about a vector from
      // another, and the id is recorded on the row precisely so this is checkable
      // rather than assumed. Abstain and say so; ./train.ts is what refits.
      if (model.model !== EMBEDDING_MODEL) {
        announceOnce('classifier:model-changed', {
          event: 'spam_layer_inactive',
          layer: 'classifier',
          reason: 'model-changed',
          fitted: model.model,
          current: EMBEDDING_MODEL,
        })
        return null
      }

      const vector = await embed(context.comment.body)
      if (vector === null) return null

      // The only CPU this layer spends: one dot product, constant in the number of
      // comments this site has ever moderated. See src/spam/model.ts.
      const score = spamProbability(model, vector)
      if (!(score >= threshold)) return null

      return { action: 'review', reason: CLASSIFIER_REASON }
    },
  }
}
