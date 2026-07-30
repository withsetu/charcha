// The `vouch` verb (#189).
//
// A layer returning `null` means "I have nothing to say", and until now that was
// also what a provider said when it had *checked the comment and found it clean*.
// Those are different statements, and collapsing them is why `allow` could not be
// trusted: on a deployment with nothing configured, `allow` means nothing ran.
//
// `vouch` is the second one said out loud. The tests here are about the two
// properties that make it safe to act on:
//
//   - **A vouch never outranks a doubt.** Any `review` or `reject`, from any layer,
//     beats any number of vouches. A vouch is not a veto.
//   - **Only a positive check vouches.** A provider that is off, that failed, that
//     timed out, or that answered `unknown` returns `null` as it always did. The
//     fail-open path must never become an auto-approve path.

import { describe, expect, it } from 'vitest'
import { runLayers } from '../../../src/spam/layer'
import type { LayerOutcome, SpamLayer } from '../../../src/spam/layer'
import { providerLayer } from '../../../src/spam/provider'
import type { ProviderSubmission, ProviderVerdict, SpamProvider } from '../../../src/spam/provider'
import { contextFor } from './context'

/** A layer that answers whatever the test says. */
function layerThat(name: string, outcome: LayerOutcome): SpamLayer {
  return { name, run: () => outcome }
}

function stub(verdict: ProviderVerdict | (() => Promise<ProviderVerdict>)): SpamProvider & {
  readonly seen: ProviderSubmission[]
} {
  const seen: ProviderSubmission[] = []
  return {
    name: 'stub',
    seen,
    check(submission) {
      seen.push(submission)
      return typeof verdict === 'function' ? verdict() : Promise.resolve(verdict)
    },
  }
}

const siteUrl = 'https://maya.build'

describe('a provider that checked the comment and found it clean', () => {
  it('vouches for it, rather than merely declining to object', async () => {
    // The line this whole issue turns on. `ham` is a real verdict from a real
    // corpus; `null` cannot carry it, because `null` is also what an unconfigured
    // provider says.
    const layer = providerLayer({ provider: stub('ham'), siteUrl })

    expect(await layer.run(contextFor())).toEqual({ action: 'vouch', reason: 'stub' })
  })

  it('says nothing at all when the provider answered `unknown`', async () => {
    // The fail-open path. Every provider failure — a bad key, a 500, a rate limit,
    // a malformed body — arrives here as `unknown`, and none of them is evidence
    // that a comment is clean. If this ever returned a vouch, an outage at a third
    // party would silently start publishing strangers' comments.
    const layer = providerLayer({ provider: stub('unknown'), siteUrl })

    expect(await layer.run(contextFor())).toBeNull()
  })

  it('says nothing at all when the provider threw', async () => {
    const layer = providerLayer({
      provider: stub(() => Promise.reject(new Error('socket hang up'))),
      siteUrl,
    })

    expect(await layer.run(contextFor())).toBeNull()
  })

  it('says nothing at all when no provider is configured', async () => {
    // Which is every deployment until somebody opts in, so this is the common case
    // rather than an edge one — and it is what stops `trust-vouched` from doing
    // anything on a deployment that configured nothing.
    const layer = providerLayer({ provider: null, siteUrl })

    expect(await layer.run(contextFor())).toBeNull()
  })
})

describe('a vouch against a doubt', () => {
  it('loses to a later review', async () => {
    const verdict = await runLayers(
      [
        layerThat('voucher', { action: 'vouch', reason: 'stub' }),
        layerThat('doubter', { action: 'review', reason: 'links' }),
      ],
      contextFor(),
    )

    expect(verdict).toEqual({ action: 'review', reason: 'doubter: links' })
  })

  it('loses to an earlier review', async () => {
    const verdict = await runLayers(
      [
        layerThat('doubter', { action: 'review', reason: 'links' }),
        layerThat('voucher', { action: 'vouch', reason: 'stub' }),
      ],
      contextFor(),
    )

    expect(verdict).toEqual({ action: 'review', reason: 'doubter: links' })
  })

  it('loses to a reject', async () => {
    const verdict = await runLayers(
      [
        layerThat('voucher', { action: 'vouch', reason: 'stub' }),
        layerThat('refuser', { action: 'reject', reason: 'honeypot' }),
      ],
      contextFor(),
    )

    expect(verdict).toEqual({ action: 'reject', reason: 'refuser: honeypot' })
  })

  it('survives when nothing else objected', async () => {
    const verdict = await runLayers(
      [
        layerThat('quiet', null),
        layerThat('voucher', { action: 'vouch', reason: 'stub' }),
        layerThat('also-quiet', null),
      ],
      contextFor(),
    )

    expect(verdict).toEqual({ action: 'vouch', reason: 'voucher: stub' })
  })

  it('leaves a run with no vouch at all still saying `allow`', async () => {
    // `allow` keeps its old meaning — nothing objected — and stays the thing
    // `trust-vouched` will not act on.
    const verdict = await runLayers([layerThat('quiet', null)], contextFor())

    expect(verdict).toEqual({ action: 'allow' })
  })
})
