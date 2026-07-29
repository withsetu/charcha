// Turning a comment into a vector, and the one place in this project that calls
// Workers AI (#10).
//
// It runs in the site owner's own Cloudflare account. That is the reason layer 6
// sits ahead of layer 7 in CLAUDE.md's ordering and is on by default: nothing here
// leaves the deployment, so no comment, address or email is disclosed to anybody,
// and the site owner has nothing to add to their privacy notice for it.
//
// **Every failure answers `null`, and every caller reads `null` as "no opinion".**
// The daily neuron allowance is exhaustible — "Account limited", internal code 3036,
// HTTP 429, "You have used up your daily free allocation of 10,000 neurons"
// (https://developers.cloudflare.com/workers-ai/platform/errors/, checked
// 2026-07-29) — and the model can be at capacity, time out, or answer a shape nobody
// expected. A spam layer that turned any of those into a verdict would mark comments
// on the strength of an outage; one that let them propagate would turn a reader's
// POST into a 500. Card rule 5: fail closed, and closed here means silent.
// Enforced by test/worker/spam/embed.test.ts.

import { announceOnce } from './log'
import { EMBEDDING_MODEL, MAX_MODEL_DIMS, toUnitVector } from './model'

/**
 * How much of a comment is embedded.
 *
 * **Cut here rather than by the model, because the model's ceiling is not
 * published.** Cloudflare gives this model a `context_window` of 60,000 and no
 * `max_input_tokens` at all, while upstream BAAI documents a maximum sequence length
 * of 8,192 — so nobody outside Cloudflare can say what a single text is allowed to
 * be. `truncate_inputs` defaults to `false`, and its own description is "When
 * provided with too long context should the model error out or truncate the context
 * to fit?", so the default behaviour on a long comment is an error on the reader's
 * submission.
 *
 * The schema allows a 10,000-character body. Four thousand characters is well under
 * 8,192 tokens for ordinary prose in any script, and it is far more of a comment
 * than any spam signal needs. Cutting here makes the truncation this project's
 * decision, at a boundary written down.
 *
 * **It is not a token bound, and this is deliberately not claimed as one.** bge-m3
 * tokenises with XLM-R SentencePiece, which has byte fallback: a codepoint the
 * vocabulary does not know becomes several tokens rather than one, so adversarial
 * input can exceed 8,192 tokens well inside this character cap. Correctness survives
 * that — `truncate_inputs: true` below means the model shortens rather than errors —
 * but the *cost* does not: a worst-case submission spends several times the neurons
 * of a typical one. The bound on that is layer 4, which rejects before this layer is
 * reached (see src/spam/index.ts), and #181, which is the accounting this has none of.
 * Enforced by test/worker/spam/embed.test.ts.
 */
export const MAX_EMBED_CHARS = 4000

/** A high surrogate at the end has lost its pair to the cut — the same rule as `spam_reason`. */
function cutToEmbedLength(text: string): string {
  if (text.length <= MAX_EMBED_CHARS) return text
  const cut = text.slice(0, MAX_EMBED_CHARS)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

/**
 * What layer 6 and the trainer both need, as a function rather than as the binding.
 *
 * The seam is here because `env.AI` cannot be exercised in tests: Workers AI has no
 * local simulation, so a test that reached the binding would need account
 * credentials in CI and would spend the owner's neurons on every run (see
 * vitest.config.ts). Everything above this type is testable; `workersAiEmbedder` is
 * the thin piece that is not.
 */
export type Embedder = (text: string) => Promise<Float32Array | null>

/**
 * The embedding out of a Workers AI response, or null when there is not one.
 *
 * **Two fields, because this model answers in two shapes and the docs render only
 * one.** Sent `{ text }` it replies `{ data: number[][] }`; sent `{ contexts }` with
 * no query it replies `{ response: number[][] }` — the same content under a
 * different name. This project sends `text`, so `data` is what it expects;
 * `response` is read as a fallback rather than trusted to never appear, because the
 * cost of being wrong is the layer silently never working.
 * (https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/workers-ai-models/bge-m3.json,
 * checked 2026-07-29.)
 *
 * **Every field in that schema is optional**, so TypeScript will not force absence
 * to be handled and this has to. The width is bounded rather than believed: the
 * numbers arrive as JSON from outside this Worker, and an unbounded length is an
 * unbounded allocation.
 * Enforced by test/worker/spam/embed.test.ts.
 */
export function parseEmbedding(response: unknown): Float32Array | null {
  if (typeof response !== 'object' || response === null) return null

  const body = response as { data?: unknown; response?: unknown }
  const rows = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.response)
      ? body.response
      : null
  if (rows === null) return null

  const first: unknown = rows[0]
  if (!Array.isArray(first)) return null
  if (first.length < 1 || first.length > MAX_MODEL_DIMS) return null

  const vector = new Float32Array(first.length)
  for (let i = 0; i < first.length; i++) {
    const value: unknown = first[i]
    if (typeof value !== 'number') return null
    vector[i] = value
  }

  // Normalised here rather than at every use, and `toUnitVector` is also what
  // rejects a NaN or an Infinity — see its note for why one of those reaching the
  // weights would silence this layer permanently.
  return toUnitVector(vector)
}

/**
 * The real embedder, wrapped around the binding.
 *
 * `truncate_inputs: true` is a backstop and not the cap — `cutToEmbedLength` is the
 * cap. It is set because the flag's default is to *error*, and the only case it can
 * still fire in is one where this project's own character cut was not enough. There,
 * embedding a prefix is strictly better than throwing on a reader's submission, and
 * the caller cannot tell the difference either way.
 *
 * The catch is total on purpose. It is the boundary between a probabilistic
 * convenience and a comment somebody wrote.
 */
export function workersAiEmbedder(ai: Ai): Embedder {
  return async (text: string): Promise<Float32Array | null> => {
    try {
      const response = await ai.run(EMBEDDING_MODEL, {
        text: cutToEmbedLength(text),
        truncate_inputs: true,
      })
      return parseEmbedding(response)
    } catch (error) {
      // **Once per isolate, and the message rather than the error.** Both halves are
      // about src/spam/log.ts's rule rather than about tidiness:
      //
      //   - *Once*, because this is on the public submission path. When the daily
      //     neuron allowance is spent the binding fails on **every** comment for the
      //     rest of the day, so a line per failure is one log line per submission,
      //     at a rate an attacker chooses. "One line per stopped comment is a signal;
      //     one line per comment is an invoice."
      //   - *The message*, because the error object comes from outside this Worker
      //     and this project has no contract with its shape. Serialising it could put
      //     the request — which is the commenter's body — into a log that log.ts
      //     promises carries no comment body, and that #19's retention sweep cannot
      //     reach.
      //
      // The cost is that a second, different failure later in the isolate's life is
      // not reported. That is the right way round: the first cause is the one worth
      // having, and an unbounded log on a public endpoint is a defect of its own.
      announceOnce('classifier:embed-failed', {
        event: 'spam_layer_degraded',
        layer: 'classifier',
        reason: 'embedding-failed',
        message: error instanceof Error ? error.message : 'unknown',
      })
      return null
    }
  }
}
