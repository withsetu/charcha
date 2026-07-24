import { describe, expect, it } from 'vitest'
import { ELAPSED_FIELD } from '../../../src/spam/fields'
import { MIN_ELAPSED_MS, timingLayer } from '../../../src/spam/timing'
import { contextFor } from './context'

const layer = timingLayer()

describe('layer 2 — time to submit', () => {
  it('rejects a form submitted faster than a human can read it', async () => {
    const outcome = await layer.run(contextFor({ form: { [ELAPSED_FIELD]: 40 } }))

    expect(outcome?.action).toBe('reject')
  })

  it('rejects at one millisecond under the threshold and allows at the threshold', async () => {
    // The boundary is the whole guard: an off-by-one here is a layer that either
    // rejects real people or waves through instant submissions.
    expect(
      (await layer.run(contextFor({ form: { [ELAPSED_FIELD]: MIN_ELAPSED_MS - 1 } })))?.action,
    ).toBe('reject')
    expect(await layer.run(contextFor({ form: { [ELAPSED_FIELD]: MIN_ELAPSED_MS } }))).toBeNull()
  })

  it('allows a form a real person spent time on', async () => {
    const outcome = await layer.run(contextFor({ form: { [ELAPSED_FIELD]: 47_000 } }))

    expect(outcome).toBeNull()
  })

  it('holds for review rather than rejecting when the field is missing', async () => {
    // Missing is suspicious — the embed always sends it — but it is also what a
    // stale cached embed sends, and a reject would lose that reader's comment
    // with no queue entry and no recourse. Review keeps it recoverable.
    const outcome = await layer.run(contextFor({ form: {} }))

    expect(outcome?.action).toBe('review')
  })

  it('holds for review when the value is not a finite number', async () => {
    for (const value of ['soon', null, Number.NaN, Infinity, {}]) {
      expect((await layer.run(contextFor({ form: { [ELAPSED_FIELD]: value } })))?.action).toBe(
        'review',
      )
    }
  })

  it('holds for review on a negative elapsed time rather than reading it as instant', async () => {
    // A negative duration is a broken or hostile client, not a fast one. Treating
    // it as "0 ms elapsed" would be the clock-skew bug this field exists to avoid.
    const outcome = await layer.run(contextFor({ form: { [ELAPSED_FIELD]: -60_000 } }))

    expect(outcome?.action).toBe('review')
  })

  it('accepts the duration as a numeric string, because a form-encoded client sends strings', async () => {
    expect(await layer.run(contextFor({ form: { [ELAPSED_FIELD]: '47000' } }))).toBeNull()
    expect((await layer.run(contextFor({ form: { [ELAPSED_FIELD]: '40' } })))?.action).toBe(
      'reject',
    )
  })
})
