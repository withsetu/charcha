// What the Setup tab is allowed to say about layer 7 (#177).
//
// **The property this file exists for is agreement with the layer, not plausibility of
// the words.** A status panel is only worth having if it says "abstaining" exactly when
// the classifier abstains — a panel that read *On* while every comment sailed past
// untouched would be worse than the silence #177 is fixing, because it would be a reason
// to stop looking. So the cases below are the classifier's own branches
// (src/spam/classifier.ts), read back through the derivation the dashboard renders.

import { describe, expect, it } from 'vitest'
import { EMBEDDING_MODEL, MIN_LABELS_PER_CLASS } from '../../../src/spam/model'
import { classifierStatus } from '../../../src/spam/status'

/** A stored row as `readSpamModelStatus` hands it back. */
function stored(overrides: Partial<Parameters<typeof classifierStatus>[0]> = {}) {
  return {
    model: EMBEDDING_MODEL,
    hamCount: MIN_LABELS_PER_CLASS,
    spamCount: MIN_LABELS_PER_CLASS,
    updatedAt: 1_800_000_000,
    ...overrides,
  }
}

describe('a deployment with no AI binding', () => {
  it('says so, whatever is in the table', () => {
    // The state `spam_layer_inactive` / `no-ai-binding` announces once per isolate and
    // nowhere else. It outranks every other reading because it is the one that means
    // *nothing here runs at all*: no comment is classified, and no decision trains.
    expect(classifierStatus(stored(), false).state).toBe('no-binding')
    expect(classifierStatus(null, false).state).toBe('no-binding')
  })

  it('still reports the counts, because they are what a restored binding would resume from', () => {
    const status = classifierStatus(stored({ hamCount: 7, spamCount: 41 }), false)

    expect(status.hamCount).toBe(7)
    expect(status.spamCount).toBe(41)
  })
})

describe('a deployment that has trained nothing', () => {
  it('reports zeroes and no last-trained time rather than pretending to a model', () => {
    const status = classifierStatus(null, true)

    expect(status).toEqual({
      state: 'learning',
      hamCount: 0,
      spamCount: 0,
      minPerClass: MIN_LABELS_PER_CLASS,
      updatedAt: null,
    })
  })
})

describe('the cold-start gate, as the classifier applies it', () => {
  it('is learning one decision short in either class, counted separately', () => {
    // Both classes gate independently (MIN_LABELS_PER_CLASS): a site with three hundred
    // spam decisions and four ham ones has no ham model, and a status derived from a
    // single total would call that trained.
    expect(
      classifierStatus(stored({ hamCount: MIN_LABELS_PER_CLASS - 1 }), true).state,
    ).toBe('learning')
    expect(
      classifierStatus(stored({ spamCount: MIN_LABELS_PER_CLASS - 1 }), true).state,
    ).toBe('learning')
  })

  it('is trained at exactly the threshold in both, which is where the layer starts speaking', () => {
    const status = classifierStatus(
      stored({ hamCount: MIN_LABELS_PER_CLASS, spamCount: MIN_LABELS_PER_CLASS }),
      true,
    )

    expect(status.state).toBe('trained')
  })

  it('sends the threshold with the counts, so the screen never restates the number', () => {
    // The #120 duplication, not repeated. `MIN_DASHBOARD_PASSWORD_LENGTH` had to be
    // written twice and pinned by test/node/password-floor.test.ts because the dashboard
    // cannot import from src/admin. This one travels in the payload instead, so there is
    // no second copy to drift.
    expect(classifierStatus(stored(), true).minPerClass).toBe(MIN_LABELS_PER_CLASS)
  })
})

describe('weights fitted in an embedding space this deployment no longer uses', () => {
  it('is its own state, and outranks the counts', () => {
    // **The counts say trained and the layer abstains anyway** — src/spam/classifier.ts
    // refuses a model whose id is not EMBEDDING_MODEL, because weights fitted in one
    // embedding space say nothing about a vector from another. It is the exact failure
    // #177 describes: silent, total, and with a full history behind it that makes every
    // other signal read as healthy.
    const status = classifierStatus(stored({ model: '@cf/some/other-model' }), true)

    expect(status.state).toBe('model-changed')
  })

  it('reports the counts that are about to be discarded, rather than hiding them', () => {
    // src/spam/train.ts resets on the next decision — `modelToTrain` replaces the model
    // counts and all. The owner is losing this many examples, so this many is the number
    // worth showing.
    const status = classifierStatus(
      stored({ model: '@cf/some/other-model', hamCount: 412, spamCount: 380 }),
      true,
    )

    expect(status.hamCount).toBe(412)
    expect(status.spamCount).toBe(380)
  })

  it('is reported even below the threshold, where the classifier checks the counts first', () => {
    // **A deliberate divergence from src/spam/classifier.ts's ordering, and the reason is
    // that the ordering there is a CPU decision rather than a meaning.** That module
    // checks the counts before the model id so an untrained deployment pays neither the
    // decode nor the embedding. Nothing is being spent here, and the more actionable
    // truth for an owner is that the history they have is about to be thrown away.
    const status = classifierStatus(
      stored({ model: '@cf/some/other-model', hamCount: 2, spamCount: 1 }),
      true,
    )

    expect(status.state).toBe('model-changed')
  })
})

describe('what it never carries', () => {
  it('answers counts, a threshold and a time — and no score, accuracy or confidence', () => {
    // #175 has not calibrated a threshold, so there is no number here anybody could read
    // as "how good is it". A fabricated one would be worse than the silence, because a
    // percentage on a dashboard is believed.
    expect(Object.keys(classifierStatus(stored(), true)).sort()).toEqual([
      'hamCount',
      'minPerClass',
      'spamCount',
      'state',
      'updatedAt',
    ])
  })

  it('carries the last time the model learned, which is how a stalled trainer shows up', () => {
    const status = classifierStatus(stored({ updatedAt: 1_777_000_000 }), true)

    expect(status.updatedAt).toBe(1_777_000_000)
  })
})
