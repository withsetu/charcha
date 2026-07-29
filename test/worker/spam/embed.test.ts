// Reading a Workers AI response, and refusing to read one that is not (#10).
//
// The binding itself is never called here — Workers AI has no local simulation, so a
// test that reached it would need a CLOUDFLARE_API_TOKEN in CI and would spend real
// neurons on every run (see vitest.config.ts). `parseEmbedding` is the whole of what
// interprets the response, and it is a pure function for exactly that reason.

import { describe, expect, it, vi } from 'vitest'
import { MAX_EMBED_CHARS, parseEmbedding, workersAiEmbedder } from '../../../src/spam/embed'
import { EMBEDDING_MODEL, MAX_MODEL_DIMS } from '../../../src/spam/model'

/** A response in the shape `{ text }` produces, which is the shape this project asks for. */
function dataResponse(vector: number[]) {
  return { shape: [1, vector.length], data: [vector], pooling: 'mean' }
}

describe('parseEmbedding — the shape the model answers in', () => {
  it('reads the `data` field, which is what a `text` request returns', () => {
    const vector = parseEmbedding(dataResponse([3, 4]))

    // Normalised on the way out, so callers never depend on whether Cloudflare
    // returns unit vectors — which is not documented either way.
    expect(vector).not.toBeNull()
    expect(vector![0]).toBeCloseTo(0.6, 6)
    expect(vector![1]).toBeCloseTo(0.8, 6)
  })

  it('reads the `response` field too, which is what a `contexts` request returns', () => {
    // The same content under a different name. This project sends `text` and so
    // expects `data`; `response` is read as a fallback rather than trusted never to
    // appear, because the cost of being wrong is a layer that silently never works.
    const vector = parseEmbedding({ response: [[0, 1]], shape: [1, 2] })

    expect(vector).not.toBeNull()
    expect(vector![1]).toBeCloseTo(1, 6)
  })

  it('refuses a reranking response, which carries scores rather than embeddings', () => {
    // Sent a `query` alongside `contexts`, this model is a reranker and answers
    // `{ response: [{ id, score }] }`. Reading that as a vector would be reading
    // object references as numbers.
    expect(parseEmbedding({ response: [{ id: 0, score: 0.9 }] })).toBeNull()
  })

  it('refuses an async acknowledgement, which contains no embedding at all', () => {
    expect(parseEmbedding({ request_id: 'abc' })).toBeNull()
  })

  it('refuses every shape that is not a response', () => {
    // Every field in Cloudflare's output schema is optional, so TypeScript will not
    // force any of this to be handled. Card rule 5 does not stop at the commenter:
    // a binding's JSON is input from outside this Worker.
    for (const bad of [null, undefined, 'a string', 42, [], {}, { data: 'no' }, { data: [] }]) {
      expect(parseEmbedding(bad)).toBeNull()
    }
  })

  it('refuses a row carrying something that is not a number', () => {
    expect(parseEmbedding({ data: [[1, '2', 3]] })).toBeNull()
    expect(parseEmbedding({ data: [[1, null, 3]] })).toBeNull()
  })

  it('refuses a value that is not finite, rather than storing it', () => {
    // One NaN in the weights would make every later score NaN, and `NaN >= threshold`
    // is false — so the layer would abstain forever, silently, with every test green.
    expect(parseEmbedding({ data: [[Number.NaN, 1]] })).toBeNull()
    expect(parseEmbedding({ data: [[Number.POSITIVE_INFINITY, 1]] })).toBeNull()
  })

  it('refuses a zero vector, which has no direction', () => {
    expect(parseEmbedding(dataResponse([0, 0, 0]))).toBeNull()
  })

  it('refuses a width past the cap', () => {
    // An unbounded length here is an unbounded allocation and an unbounded BLOB, on
    // a number chosen by a response rather than by this project.
    const huge = Array.from({ length: MAX_MODEL_DIMS + 1 }, () => 1)

    expect(parseEmbedding(dataResponse(huge))).toBeNull()
    expect(parseEmbedding(dataResponse(huge.slice(1)))).not.toBeNull()
  })
})

describe('workersAiEmbedder — the call itself', () => {
  /**
   * A stand-in for the binding. Cast, because `Ai` is a generated type over every
   * model Cloudflare ships and this only has to answer one of them — and because
   * the real binding cannot be reached from a test at all.
   */
  function stubBinding(run: (model: string, input: unknown) => Promise<unknown>): Ai {
    return { run } as unknown as Ai
  }

  it('asks for the model this project fitted its weights on', async () => {
    const run = vi.fn(() => Promise.resolve(dataResponse([1, 0])))

    await workersAiEmbedder(stubBinding(run))('a comment')

    expect(run).toHaveBeenCalledWith(EMBEDDING_MODEL, {
      text: 'a comment',
      truncate_inputs: true,
    })
  })

  it('cuts the text itself rather than leaving the length to the model', async () => {
    // `truncate_inputs` defaults to false and its own description is "should the
    // model error out or truncate", so an over-long comment would otherwise throw on
    // a reader's submission. Cloudflare publishes no per-text token ceiling for this
    // model, so the cut is this project's decision, at a boundary written down.
    let sent = ''
    const run = (_model: string, input: unknown) => {
      sent = (input as { text: string }).text
      return Promise.resolve(dataResponse([1, 0]))
    }

    await workersAiEmbedder(stubBinding(run))('x'.repeat(MAX_EMBED_CHARS + 5000))

    expect(sent).toHaveLength(MAX_EMBED_CHARS)
  })

  it('does not cut a character in half', async () => {
    // The cut counts UTF-16 units, so a character outside the BMP landing on the
    // boundary would leave half of itself in the request.
    let sent = ''
    const run = (_model: string, input: unknown) => {
      sent = (input as { text: string }).text
      return Promise.resolve(dataResponse([1, 0]))
    }
    // One astral character straddles the boundary exactly.
    const text = 'a'.repeat(MAX_EMBED_CHARS - 1) + '\u{1F600}' + 'b'.repeat(10)

    await workersAiEmbedder(stubBinding(run))(text)

    expect(sent).toHaveLength(MAX_EMBED_CHARS - 1)
    expect(/[\uD800-\uDBFF]$/.test(sent)).toBe(false)
  })

  it('answers null when the binding throws, which is every Workers AI failure', async () => {
    // The daily allowance is exhaustible — "Account limited", HTTP 429, "You have
    // used up your daily free allocation of 10,000 neurons" — and the model can be
    // at capacity or time out. None of them may reach the reader's POST.
    const run = () => Promise.reject(new Error('Account limited'))

    await expect(workersAiEmbedder(stubBinding(run))('a comment')).resolves.toBeNull()
  })

  it('answers null when the binding throws synchronously', async () => {
    // Which is what the real binding does in this suite: reaching `.run` on an
    // unreachable AI binding throws from a property getter, before any promise
    // exists to reject.
    const binding = {
      get run(): never {
        throw new Error('Binding AI needs to be run remotely')
      },
    } as unknown as Ai

    await expect(workersAiEmbedder(binding)('a comment')).resolves.toBeNull()
  })

  it('answers null for a response it cannot read', async () => {
    const run = () => Promise.resolve({ nothing: 'useful' })

    await expect(workersAiEmbedder(stubBinding(run))('a comment')).resolves.toBeNull()
  })
})
