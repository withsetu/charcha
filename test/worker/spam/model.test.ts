// The classifier's arithmetic, on its own (#10).
//
// Pure functions, so these tests are about the model rather than about D1 or
// Workers AI — which matters because this is the only part of layer 7 that spends
// CPU, and the only part whose cost has to stay constant as the site's moderation
// history grows.

import { describe, expect, it } from 'vitest'
import {
  LEARNING_RATE,
  MAX_MODEL_DIMS,
  MIN_LABELS_PER_CLASS,
  SPAM_PROBABILITY_THRESHOLD,
  type SpamModel,
  decodeWeights,
  emptyModel,
  encodeWeights,
  isTrained,
  spamProbability,
  toUnitVector,
  trainedWith,
} from '../../../src/spam/model'

const DIMS = 8

function modelWith(overrides: Partial<SpamModel> = {}): SpamModel {
  return { ...emptyModel('@cf/test/model', DIMS), ...overrides }
}

/** A unit vector pointing along one axis, so a test can separate two classes by hand. */
function axis(index: number, dims = DIMS): Float32Array {
  const vector = new Float32Array(dims)
  vector[index] = 1
  return vector
}

/** `vector`, nudged by `noise` on every other axis, then renormalised. */
function nearAxis(index: number, noise: number, seed: number): Float32Array {
  const vector = new Float32Array(DIMS)
  for (let i = 0; i < DIMS; i++) vector[i] = Math.sin(seed * (i + 1)) * noise
  vector[index] = 1
  return toUnitVector(vector) ?? vector
}

describe('encodeWeights and decodeWeights', () => {
  it('round-trips a vector through the shape D1 hands back for a BLOB', () => {
    // D1 converts a BLOB column to a JavaScript array of byte values, not to a
    // typed array, so the decode has to start from `number[]` — a round-trip that
    // only ever went ArrayBuffer to ArrayBuffer would pass while production read
    // nothing at all.
    // https://developers.cloudflare.com/d1/worker-api/ (checked 2026-07-29)
    const weights = new Float32Array([0.5, -0.25, 0, 1, -1, 0.125, 2, -0.75])
    const bytes = [...new Uint8Array(encodeWeights(weights))]

    expect(decodeWeights(bytes, DIMS)).toEqual(weights)
  })

  it('round-trips through an ArrayBuffer too, so the decode does not depend on which D1 returns', () => {
    const weights = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8])

    expect(decodeWeights(encodeWeights(weights), DIMS)).toEqual(weights)
  })

  it('refuses a blob whose length disagrees with the recorded dimensionality', () => {
    // The width is discovered from a real embedding rather than hardcoded, so a
    // disagreement means the stored model and the live model are different things.
    // Reading it anyway would classify against half a vector.
    const weights = encodeWeights(new Float32Array(DIMS))

    expect(decodeWeights(weights, DIMS + 1)).toBeNull()
  })

  it('refuses a dimensionality past the cap, whatever the blob says', () => {
    expect(decodeWeights(new ArrayBuffer(4 * (MAX_MODEL_DIMS + 1)), MAX_MODEL_DIMS + 1)).toBeNull()
  })

  it('refuses a blob that is not bytes at all', () => {
    expect(decodeWeights(null, DIMS)).toBeNull()
    expect(decodeWeights('not a vector', DIMS)).toBeNull()
  })
})

describe('toUnitVector', () => {
  it('scales to length one, so the dot product is bounded by the weights alone', () => {
    const unit = toUnitVector(new Float32Array([3, 4, 0, 0, 0, 0, 0, 0]))

    expect(unit).not.toBeNull()
    expect(unit![0]).toBeCloseTo(0.6, 6)
    expect(unit![1]).toBeCloseTo(0.8, 6)
  })

  it('refuses a zero vector, which has no direction to normalise', () => {
    expect(toUnitVector(new Float32Array(DIMS))).toBeNull()
  })

  it('refuses a vector carrying a value that is not finite', () => {
    // The vector arrives from a binding's JSON response. Card rule 5 does not stop
    // at the commenter: one NaN would make every later dot product NaN, and
    // `NaN >= threshold` is false, so the layer would abstain forever and silently.
    expect(toUnitVector(new Float32Array([Number.NaN, 1, 0, 0, 0, 0, 0, 0]))).toBeNull()
    expect(
      toUnitVector(new Float32Array([Number.POSITIVE_INFINITY, 1, 0, 0, 0, 0, 0, 0])),
    ).toBeNull()
  })
})

describe('isTrained — the cold-start gate', () => {
  it('is false on a model nothing has been labelled into', () => {
    expect(isTrained(modelWith())).toBe(false)
  })

  it('stays false one example short in either class, counted separately', () => {
    // Both counts gate independently. A site with hundreds of spam decisions and
    // four ham ones has no ham model, and a single total would let that pass.
    expect(isTrained(modelWith({ hamCount: MIN_LABELS_PER_CLASS - 1, spamCount: 500 }))).toBe(false)
    expect(isTrained(modelWith({ hamCount: 500, spamCount: MIN_LABELS_PER_CLASS - 1 }))).toBe(false)
  })

  it('becomes true at the threshold in both classes', () => {
    expect(
      isTrained(modelWith({ hamCount: MIN_LABELS_PER_CLASS, spamCount: MIN_LABELS_PER_CLASS })),
    ).toBe(true)
  })
})

describe('trainedWith — the online update', () => {
  it('counts the class it was given, and only that one', () => {
    const once = trainedWith(modelWith(), axis(0), 'spam')
    expect(once.spamCount).toBe(1)
    expect(once.hamCount).toBe(0)

    const twice = trainedWith(once, axis(1), 'ham')
    expect(twice.spamCount).toBe(1)
    expect(twice.hamCount).toBe(1)
  })

  it('moves the score for that example in the direction of its label', () => {
    const before = spamProbability(modelWith(), axis(0))
    const after = spamProbability(trainedWith(modelWith(), axis(0), 'spam'), axis(0))

    expect(before).toBeCloseTo(0.5, 6)
    expect(after).toBeGreaterThan(before)
  })

  it('separates two classes well enough to clear the threshold it is judged on', () => {
    // The one test that would fail if the learning rate or the threshold were set
    // where nothing the model learns can ever reach. A classifier that is never
    // confident abstains forever, which passes every other test in this file.
    let model = modelWith()
    for (let i = 0; i < MIN_LABELS_PER_CLASS; i++) {
      model = trainedWith(model, nearAxis(0, 0.2, i + 1), 'spam')
      model = trainedWith(model, nearAxis(1, 0.2, i + 1), 'ham')
    }

    expect(spamProbability(model, nearAxis(0, 0.2, 99))).toBeGreaterThan(SPAM_PROBABILITY_THRESHOLD)
    expect(spamProbability(model, nearAxis(1, 0.2, 99))).toBeLessThan(0.5)
  })

  it('leaves a model whose width does not match the vector untouched', () => {
    const model = modelWith()
    const wrong = new Float32Array(DIMS + 1)
    wrong[0] = 1

    expect(trainedWith(model, wrong, 'spam')).toBe(model)
  })

  it('never produces a weight that is not finite', () => {
    // A single Infinity in the weights poisons every later score irreversibly, and
    // the layer's only symptom would be that it stopped having opinions.
    let model = modelWith()
    for (let i = 0; i < 200; i++) model = trainedWith(model, axis(i % DIMS), 'spam')

    expect([...model.weights].every(Number.isFinite)).toBe(true)
    expect(Number.isFinite(model.bias)).toBe(true)
  })
})

describe('spamProbability', () => {
  it('is exactly one half on an untrained model, which is why the count gate exists', () => {
    // Not a usable answer — it is the absence of one. The gate, not this number, is
    // what keeps a fresh deployment from acting on it.
    expect(spamProbability(modelWith(), axis(0))).toBeCloseTo(0.5, 10)
  })

  it('answers a vector of the wrong width with one half rather than a verdict', () => {
    expect(spamProbability(modelWith(), new Float32Array(DIMS + 1))).toBeCloseTo(0.5, 10)
  })

  it('stays inside zero and one for weights far outside the range training reaches', () => {
    const huge = modelWith({ weights: new Float32Array(DIMS).fill(1e6), bias: 1e6 })

    expect(spamProbability(huge, axis(0))).toBeLessThanOrEqual(1)
    expect(spamProbability(huge, axis(0))).toBeGreaterThanOrEqual(0)
  })
})

describe('the schema and the code agree about the width cap', () => {
  it('refuses a row the TypeScript cap would have allowed through', async () => {
    // `MAX_MODEL_DIMS` is written twice — here in TypeScript and as
    // `CHECK (dims BETWEEN 1 AND 4096)` in migrations/0003_spam_model.sql — and
    // nothing typechecks a constant against a SQL string. This is the same hazard
    // src/cascade.ts exists to prevent, answered with an assertion rather than a
    // shared definition, because a migration is frozen once it has been applied and
    // cannot import anything.
    const { env } = await import('cloudflare:workers')

    await expect(
      env.DB.prepare(
        `insert into spam_model (id, model, dims, weights, bias, ham_count, spam_count, updated_at)
         values (1, ?1, ?2, ?3, 0, 0, 0, 0)`,
      )
        .bind('@cf/test/model', MAX_MODEL_DIMS + 1, new ArrayBuffer(4))
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/i)
  })

  it('accepts the widest row the cap allows, so the bound is not off by one', async () => {
    const { env } = await import('cloudflare:workers')
    await env.DB.exec('DELETE FROM spam_model')

    await env.DB.prepare(
      `insert into spam_model (id, model, dims, weights, bias, ham_count, spam_count, updated_at)
       values (1, ?1, ?2, ?3, 0, 0, 0, 0)`,
    )
      .bind('@cf/test/model', MAX_MODEL_DIMS, new ArrayBuffer(4))
      .run()

    const row = await env.DB.prepare('select dims from spam_model where id = 1').first<{
      dims: number
    }>()
    expect(row?.dims).toBe(MAX_MODEL_DIMS)
    await env.DB.exec('DELETE FROM spam_model')
  })
})

describe('the constants this layer is judged on', () => {
  it('holds the learning rate and threshold inside ranges that mean something', () => {
    expect(LEARNING_RATE).toBeGreaterThan(0)
    expect(SPAM_PROBABILITY_THRESHOLD).toBeGreaterThan(0.5)
    expect(SPAM_PROBABILITY_THRESHOLD).toBeLessThan(1)
  })
})
