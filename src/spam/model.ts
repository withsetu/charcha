// Layer 6's model: the arithmetic, with no binding in sight (#10).
//
// **Everything here is pure, and that is the point rather than a style.** This is
// the only part of the classifier that spends CPU. `env.AI.run()` and every D1 read
// around it are subrequests — "CPU time measures how long the CPU spends executing
// your Worker code. Waiting on network requests (such as fetch() calls, KV reads,
// or database queries) does not count toward CPU time"
// (https://developers.cloudflare.com/workers/platform/limits/, checked 2026-07-29),
// and the Free plan allows 10 ms of it per request. So the cost that has to be held
// constant as a site's moderation history grows is exactly the cost of this file.
//
// It is held constant by fitting **one weight vector** rather than keeping the
// examples. Classifying is one dot product of `dims` multiply-adds whether the site
// has moderated thirty comments or thirty thousand. Comparing a new comment against
// every stored labelled vector instead would be N dot products of real JavaScript
// execution — the shape that grows into the 10 ms wall, and the reason this is a
// linear model rather than a nearest-neighbour search.
// Enforced by test/worker/spam/model.test.ts and test/worker/spam/classifier.test.ts.

/**
 * The embedding model, and the one place its id is written.
 *
 * `@cf/baai/bge-m3` because it is the cheapest embedding model Cloudflare lists
 * (1,075 neurons per million input tokens) and because it is multilingual — the
 * English-only bge-* models are both more expensive per token and a hard ceiling on
 * who could use this project.
 * https://developers.cloudflare.com/workers-ai/platform/pricing/ (checked 2026-07-29)
 *
 * It is stored on every model row and every vector, so changing this id is a
 * detectable event rather than a silent reinterpretation of weights fitted in a
 * different embedding space — see `trainedWith`'s callers in ./train.ts.
 */
export const EMBEDDING_MODEL = '@cf/baai/bge-m3'

/**
 * The widest embedding this deployment will store or read.
 *
 * **Cloudflare does not publish an output dimensionality for this model.** Its
 * schema JSON carries `context_window` and no `output_dimensions`, where
 * `bge-small-en-v1.5` (384), `bge-base-en-v1.5` (768) and `bge-large-en-v1.5` (1024)
 * all carry the field. Cloudflare's AI Search model table lists bge-m3 at 1,024 and
 * upstream BAAI publishes 1,024, so 1,024 is what this is *expected* to meet — but
 * expected is not measured, so nothing here assumes it. The width is learned from
 * the first real response and recorded (`spam_model.dims`), and this cap is the
 * bound on what a response is allowed to claim: a binding's JSON is untrusted input
 * like any other (card rule 5), and an unbounded length here is an unbounded
 * allocation and an unbounded BLOB.
 * Enforced by test/worker/spam/model.test.ts and test/worker/spam/embed.test.ts.
 */
export const MAX_MODEL_DIMS = 4096

/**
 * How many human decisions in **each** class before the classifier is allowed an
 * opinion at all. Below this it abstains — CLAUDE.md's cold-start rule.
 *
 * Thirty, and the number comes from the shape of a published learning curve rather
 * than from taste. SetFit — a logistic-regression head on sentence embeddings, the
 * same architecture as this — reports 90.1 ± 3.4 accuracy at 8 labelled examples per
 * class and 96.1 ± 0.8 at 64 (https://arxiv.org/abs/2209.11055). The means are not
 * the interesting part; the standard deviation collapsing is. At eight per class the
 * model's quality depends on *which* eight comments happened to be moderated first,
 * which on a new blog is arbitrary. Thirty sits inside the stretch where that
 * variance has largely gone, without asking a site to moderate hundreds of comments
 * before the layer does anything.
 *
 * It is an optimistic anchor rather than a prediction: SetFit fine-tunes its encoder
 * and Workers AI offers no fine-tuning for embedding models, so this model's
 * embeddings are frozen and it will be worse than that table at every N. #9's §5
 * evaluation is what replaces this number with a measured one.
 *
 * **Both classes gate independently.** A site with three hundred spam decisions and
 * four ham ones has no ham model, and a single total would hide exactly that.
 * Enforced by test/worker/spam/model.test.ts.
 */
export const MIN_LABELS_PER_CLASS = 30

/**
 * The score at which the layer speaks. Below it, no opinion.
 *
 * **Provisional, and honest about it.** Raw scores off frozen embeddings are not
 * calibrated, so this is not a probability anyone should read as one — it is an
 * operating point picked conservatively while there is no held-out data to pick it
 * from. What makes that affordable is what the layer is allowed to do with it: the
 * only outcome is `review`, which on this project's submission path attaches a
 * triage reason to a comment that was already going to the moderation queue. It
 * cannot hide a comment and cannot refuse one. #175 is the calibration.
 * Enforced by test/worker/spam/model.test.ts and test/worker/spam/classifier.test.ts.
 */
export const SPAM_PROBABILITY_THRESHOLD = 0.9

/**
 * The online update's step size.
 *
 * Constant rather than decaying, because the alternative needs a schedule and a
 * schedule needs a corpus to tune it against (#9 §5). Feature vectors are unit
 * length, so one update moves the weights by at most this much and the scale of the
 * model stays interpretable across deployments.
 */
export const LEARNING_RATE = 0.5

/** Which way a human judged one comment. The only two labels that train anything. */
export type SpamLabel = 'ham' | 'spam'

/** One fitted classifier: the weights, and what they were fitted from. */
export interface SpamModel {
  /** The Workers AI model id these weights were fitted in the embedding space of. */
  model: string
  dims: number
  weights: Float32Array
  bias: number
  hamCount: number
  spamCount: number
}

/** A model that has learned nothing, for a deployment whose first decision is pending. */
export function emptyModel(model: string, dims: number): SpamModel {
  return { model, dims, weights: new Float32Array(dims), bias: 0, hamCount: 0, spamCount: 0 }
}

/** The weights as the BLOB column holds them: little-endian float32, `dims * 4` bytes. */
export function encodeWeights(weights: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(weights.length * 4)
  const view = new DataView(buffer)
  for (let i = 0; i < weights.length; i++) view.setFloat32(i * 4, weights[i]!, true)
  return buffer
}

/**
 * The weights back out of a D1 row, or null when the row cannot be read as `dims`
 * floats.
 *
 * **It starts from `number[]`, because that is what D1 hands back for a BLOB.** The
 * type-conversion table on
 * https://developers.cloudflare.com/d1/worker-api/ (checked 2026-07-29) maps the
 * BLOB column type to `Array`, one JavaScript number per byte — not to a typed
 * array. A decoder written only against `ArrayBuffer` would round-trip perfectly in
 * a test and read nothing in production, so both shapes are accepted and both are
 * tested.
 *
 * Null rather than a throw, and null rather than a zero vector: the caller's answer
 * to "I could not read the model" has to be abstention, and a zero vector is not
 * absence — it scores every comment at exactly one half, which the count gate would
 * then let through as a real opinion.
 * Enforced by test/worker/spam/model.test.ts.
 */
export function decodeWeights(value: unknown, dims: number): Float32Array | null {
  if (!Number.isInteger(dims) || dims < 1 || dims > MAX_MODEL_DIMS) return null

  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : Array.isArray(value)
          ? Uint8Array.from(value as number[])
          : null
  if (bytes === null || bytes.byteLength !== dims * 4) return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const weights = new Float32Array(dims)
  for (let i = 0; i < dims; i++) weights[i] = view.getFloat32(i * 4, true)
  return weights
}

/**
 * `vector` scaled to length one, or null when it has no direction to scale.
 *
 * Normalising is what makes `SPAM_PROBABILITY_THRESHOLD` and `LEARNING_RATE` mean
 * the same thing on every deployment: with unit features the score depends on the
 * angle between a comment and the fitted boundary rather than on how long the
 * comment happened to be. Cloudflare does not document whether this model returns
 * normalised embeddings, so it is done here rather than assumed there.
 *
 * **A value that is not finite is refused rather than repaired.** The numbers arrive
 * in a binding's JSON response, which is untrusted input like any other (card rule
 * 5). One NaN reaching the weights would make every later score NaN, and
 * `NaN >= threshold` is false — so the layer would abstain forever, silently, with
 * every test still green.
 * Enforced by test/worker/spam/model.test.ts.
 */
export function toUnitVector(vector: Float32Array): Float32Array | null {
  let sumOfSquares = 0
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i]!
    if (!Number.isFinite(value)) return null
    sumOfSquares += value * value
  }

  const norm = Math.sqrt(sumOfSquares)
  if (!Number.isFinite(norm) || norm === 0) return null

  const unit = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i++) unit[i] = vector[i]! / norm
  return unit
}

/**
 * Whether this model has seen enough human decisions to be worth asking.
 *
 * The cold-start gate, and the reason a fresh deployment's submission path never
 * reaches Workers AI at all — see ./classifier.ts, which checks this *before* it
 * spends an embedding.
 * Enforced by test/worker/spam/model.test.ts and test/worker/spam/classifier.test.ts.
 */
export function isTrained(model: SpamModel): boolean {
  return model.hamCount >= MIN_LABELS_PER_CLASS && model.spamCount >= MIN_LABELS_PER_CLASS
}

/** The logistic function, clamped by construction into (0, 1). */
function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z))
  const e = Math.exp(z)
  return e / (1 + e)
}

/**
 * How much this model thinks `vector` looks like the spam it has been shown.
 *
 * One dot product — `dims` multiply-adds, constant in the number of examples the
 * model was fitted from. That constancy is the whole reason the model is a single
 * weight vector; see the file header.
 *
 * A vector of the wrong width answers one half rather than throwing, because the
 * caller's only safe response to a model it cannot apply is no opinion, and one half
 * is below every threshold this layer will ever be given.
 * Enforced by test/worker/spam/model.test.ts.
 */
export function spamProbability(model: SpamModel, vector: Float32Array): number {
  if (vector.length !== model.weights.length) return 0.5

  let z = model.bias
  for (let i = 0; i < vector.length; i++) z += model.weights[i]! * vector[i]!
  return sigmoid(z)
}

/**
 * The model after one labelled example: one step of online logistic regression.
 *
 * `w += lr * (y - p) * x`, `bias += lr * (y - p)`. Incremental rather than a refit,
 * and that is a platform constraint rather than a preference: a refit over stored
 * vectors is O(N) JavaScript, and there is no offline escape hatch to move it to —
 * the Free plan's CPU limit on a Cron Trigger is the same 10 ms as on an HTTP
 * request (https://developers.cloudflare.com/workers/platform/limits/, checked
 * 2026-07-29), where the 15 minutes quoted for cron is wall time.
 *
 * Returns a new model and mutates nothing, so a caller that fails to write it back
 * has not half-trained anything.
 *
 * **A vector of the wrong width returns the model unchanged**, rather than
 * reshaping either side. The width comes from a live binding response and the model
 * from a row written earlier; if they disagree, the two are not the same embedding
 * space and there is no arithmetic that makes them one.
 * Enforced by test/worker/spam/model.test.ts.
 */
export function trainedWith(model: SpamModel, vector: Float32Array, label: SpamLabel): SpamModel {
  if (vector.length !== model.weights.length) return model

  const target = label === 'spam' ? 1 : 0
  const error = target - spamProbability(model, vector)
  const step = LEARNING_RATE * error

  const weights = new Float32Array(model.weights.length)
  for (let i = 0; i < weights.length; i++) weights[i] = model.weights[i]! + step * vector[i]!

  return {
    ...model,
    weights,
    bias: model.bias + step,
    hamCount: model.hamCount + (label === 'ham' ? 1 : 0),
    spamCount: model.spamCount + (label === 'spam' ? 1 : 0),
  }
}
