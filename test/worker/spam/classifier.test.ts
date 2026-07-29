// Layer 6, as a layer (#10).
//
// **No test here touches the real `AI` binding, and none can.** Workers AI has no
// local simulation, so a test that reached it would need a CLOUDFLARE_API_TOKEN in
// CI and would spend the owner's neurons on every run — see vitest.config.ts. Every
// test below passes an `Embedder` stand-in, which is the seam src/spam/embed.ts
// exists to provide.

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { writeSpamModel } from '../../../src/db'
import { CLASSIFIER_REASON, classifierLayer } from '../../../src/spam/classifier'
import type { Embedder } from '../../../src/spam/embed'
import {
  EMBEDDING_MODEL,
  MIN_LABELS_PER_CLASS,
  emptyModel,
  encodeWeights,
  toUnitVector,
  trainedWith,
} from '../../../src/spam/model'
import { contextFor, db, t0 } from './context'

const DIMS = 16

/** An embedder that always answers the same vector, and counts how often it was asked. */
function embedderFor(vector: Float32Array) {
  const calls: string[] = []
  const embed: Embedder = (text) => {
    calls.push(text)
    return Promise.resolve(vector)
  }
  return { calls, embed }
}

function unit(index: number): Float32Array {
  const vector = new Float32Array(DIMS)
  vector[index] = 1
  return toUnitVector(vector)!
}

/**
 * Stores a model that has seen `hamCount`/`spamCount` decisions and leans towards
 * `spamAxis`. The weights are fitted rather than written by hand, so no test here
 * depends on an encoding the production code does not also use.
 */
async function storeModel(
  options: {
    hamCount?: number
    spamCount?: number
    model?: string
    dims?: number
  } = {},
): Promise<void> {
  let fitted = emptyModel(options.model ?? EMBEDDING_MODEL, options.dims ?? DIMS)
  for (let i = 0; i < 40; i++) {
    fitted = trainedWith(fitted, unit(0), 'spam')
    fitted = trainedWith(fitted, unit(1), 'ham')
  }

  await writeSpamModel(
    db,
    {
      model: options.model ?? EMBEDDING_MODEL,
      dims: options.dims ?? DIMS,
      weights: encodeWeights(fitted.weights),
      bias: fitted.bias,
    },
    {
      hamCount: options.hamCount ?? MIN_LABELS_PER_CLASS,
      spamCount: options.spamCount ?? MIN_LABELS_PER_CLASS,
    },
    t0,
  )
}

beforeEach(async () => {
  await db.exec('DELETE FROM comment_vectors')
  await db.exec('DELETE FROM spam_model')
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
})

describe('cold start', () => {
  it('abstains on a deployment that has trained nothing, and spends no embedding', async () => {
    // CLAUDE.md, in as many words: "Cold start must abstain, not guess." A fresh
    // deployment has no `spam_model` row at all, so there is nothing to guess from —
    // and the classifier must not reach Workers AI to discover that.
    const { calls, embed } = embedderFor(unit(0))

    const outcome = await classifierLayer({ embed }).run(contextFor())

    expect(outcome).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('abstains one decision short in either class, counted separately', async () => {
    // A site with a long spam history and almost no approvals has no ham model. A
    // single total would let that through, and the classifier would then be judging
    // "is this like the spam I know" with no idea what a real comment looks like.
    const { calls, embed } = embedderFor(unit(0))

    await storeModel({ hamCount: MIN_LABELS_PER_CLASS - 1, spamCount: 500 })
    expect(await classifierLayer({ embed }).run(contextFor())).toBeNull()

    await storeModel({ hamCount: 500, spamCount: MIN_LABELS_PER_CLASS - 1 })
    expect(await classifierLayer({ embed }).run(contextFor())).toBeNull()

    // Not merely "no verdict" — no inference call was made either, so an untrained
    // deployment costs nothing but the one row read.
    expect(calls).toHaveLength(0)
  })

  it('speaks once both classes reach the threshold', async () => {
    const { calls, embed } = embedderFor(unit(0))
    await storeModel()

    const outcome = await classifierLayer({ embed }).run(contextFor())

    expect(outcome).toEqual({ action: 'review', reason: CLASSIFIER_REASON })
    expect(calls).toHaveLength(1)
  })
})

describe('what the layer is allowed to answer', () => {
  it('never rejects, however certain the model is', async () => {
    // The rule this layer is built around. A `reject` is not stored, so it can never
    // be labelled — a classifier able to reject would delete its own training data,
    // and delete exactly the examples it was most confident about. `review` puts the
    // comment in front of the human gate, which is where a judgement call belongs.
    await storeModel({ hamCount: 10_000, spamCount: 10_000 })

    // Every vector on the spam side of a heavily trained model, and the strongest
    // signal any comment could produce.
    for (const vector of [unit(0), toUnitVector(new Float32Array(DIMS).fill(1))!]) {
      const outcome = await classifierLayer({ embed: () => Promise.resolve(vector) }).run(
        contextFor(),
      )

      expect(outcome?.action).not.toBe('reject')
    }
  })

  it('abstains on a comment the model does not think is spam', async () => {
    await storeModel()

    const outcome = await classifierLayer({ embed: () => Promise.resolve(unit(1)) }).run(
      contextFor(),
    )

    expect(outcome).toBeNull()
  })

  it('names the signal and never the score', async () => {
    // The reason is stored on the comment (#70) and shown to the moderator. A number
    // there would read as a measurement, and this one is not calibrated.
    await storeModel()

    const outcome = await classifierLayer({ embed: () => Promise.resolve(unit(0)) }).run(
      contextFor(),
    )

    expect(outcome?.reason).toBe(CLASSIFIER_REASON)
    expect(outcome?.reason).not.toMatch(/\d/)
  })
})

describe('when something is unavailable', () => {
  it('abstains with no AI binding, and reads nothing', async () => {
    const statements: string[] = []
    const counting = {
      ...db,
      prepare(sql: string) {
        statements.push(sql)
        return db.prepare(sql)
      },
    } as unknown as D1Database
    await storeModel()

    const outcome = await classifierLayer({}).run({ ...contextFor(), db: counting })

    expect(outcome).toBeNull()
    expect(statements).toHaveLength(0)
  })

  it('abstains when the embedder answers nothing, which is every Workers AI failure', async () => {
    // The daily neuron allowance is exhaustible (HTTP 429, "Account limited"), the
    // model can be at capacity, and the response can be a shape nobody expected.
    // src/spam/embed.ts turns all of them into null, and null must never become a
    // verdict — a comment marked on the strength of an outage is the worst version
    // of this feature.
    await storeModel()

    const outcome = await classifierLayer({ embed: () => Promise.resolve(null) }).run(contextFor())

    expect(outcome).toBeNull()
  })

  it('abstains rather than throwing when the embedder rejects', async () => {
    // The submission path is a reader posting a comment, and `runLayers` does not
    // catch — so a layer that could throw would turn their POST into a 500 for a
    // probabilistic convenience. This is the assertion that caught it: the layer
    // propagated the rejection until the catch in classifierLayer was added.
    await storeModel()
    const layer = classifierLayer({ embed: () => Promise.reject(new Error('down')) })

    await expect(layer.run(contextFor())).resolves.toBeNull()
  })

  it('abstains rather than throwing when the model read fails', async () => {
    await storeModel()
    const broken = {
      ...db,
      prepare() {
        throw new Error('D1 is having a day')
      },
    } as unknown as D1Database

    const outcome = await classifierLayer({ embed: () => Promise.resolve(unit(0)) }).run({
      ...contextFor(),
      db: broken,
    })

    expect(outcome).toBeNull()
  })

  it('abstains on a model fitted by a different embedding model', async () => {
    // Weights fitted in one embedding space say nothing about a vector from another.
    // The id is on the row so this is checkable rather than assumed.
    await storeModel({ model: '@cf/some/other-model' })

    const outcome = await classifierLayer({ embed: () => Promise.resolve(unit(0)) }).run(
      contextFor(),
    )

    expect(outcome).toBeNull()
  })

  it('abstains when the stored width and the live vector disagree', async () => {
    await storeModel()

    const outcome = await classifierLayer({
      embed: () => Promise.resolve(toUnitVector(new Float32Array(DIMS + 8).fill(1))!),
    }).run(contextFor())

    expect(outcome).toBeNull()
  })
})

describe('the cost of asking', () => {
  it('reads one row whatever the site has moderated, trained or not', async () => {
    // The property the whole design exists for. A nearest-neighbour classifier would
    // read one row per stored vector here, on the busiest write path in the Worker,
    // against a 5M row-reads-a-day account budget. This one reads
    // `READ_SPAM_MODEL_SQL` and stops: a rowid seek on a table the schema allows a
    // single row in.
    const countingDb = () => {
      const statements: string[] = []
      const wrapped = {
        ...db,
        prepare(sql: string) {
          statements.push(sql)
          return db.prepare(sql)
        },
      } as unknown as D1Database
      return { statements, wrapped }
    }

    const cold = countingDb()
    await classifierLayer({ embed: () => Promise.resolve(unit(0)) }).run({
      ...contextFor(),
      db: cold.wrapped,
    })
    expect(cold.statements).toHaveLength(1)

    await storeModel({ hamCount: 5_000, spamCount: 5_000 })
    const warm = countingDb()
    await classifierLayer({ embed: () => Promise.resolve(unit(0)) }).run({
      ...contextFor(),
      db: warm.wrapped,
    })
    expect(warm.statements).toHaveLength(1)
  })

  it('asks the embedder once per comment', async () => {
    const { calls, embed } = embedderFor(unit(0))
    await storeModel()

    await classifierLayer({ embed }).run(contextFor({ body: 'a comment worth embedding once' }))

    expect(calls).toEqual(['a comment worth embedding once'])
  })
})

describe('the assembled pipeline', () => {
  it('leaves the layer out of the way of a deployment with no binding', async () => {
    // env.AI exists in this suite but cannot be reached, so this is the shape a real
    // deployment without Workers AI would see: the other five layers still decide.
    const outcome = await classifierLayer({}).run(contextFor())

    expect(outcome).toBeNull()
  })

  it('is the last layer, so nothing cheap runs after an inference call', async () => {
    const { SPAM_LAYER_ORDER } = await import('../../../src/spam')

    expect(SPAM_LAYER_ORDER.at(-1)).toBe('classifier')
  })
})

// The suite writes to spam_model directly, so nothing here depends on env.AI.
void env
