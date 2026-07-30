// Layer 7 — the seam, apart from any one provider (#11).
//
// These tests are about what the seam promises: that it is off unless configured,
// that it can only ever hold a comment, that a provider which throws or hangs
// cannot cost anyone their comment, and that it hands a provider a permalink built
// from the owner's own site rather than from the submission.

import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_LAYER_NAME, providerLayer } from '../../../src/spam/provider'
import type { ProviderSubmission, ProviderVerdict, SpamProvider } from '../../../src/spam/provider'
import { contextFor } from './context'

/** A provider that answers whatever the test says, and records what it was asked. */
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

describe('the layer 7 seam', () => {
  it('abstains, and asks nothing, when no provider is configured', async () => {
    // Off by default is the whole posture (#11): layer 7 is the only layer that
    // transmits anything about the reader, so a deployment that never opts in must
    // never reach one — and must still take comments.
    const layer = providerLayer({ provider: null, siteUrl })

    expect(await layer.run(contextFor())).toBeNull()
  })

  it('holds a comment the provider calls spam, and names the provider', async () => {
    const provider = stub('spam')
    const layer = providerLayer({ provider, siteUrl })

    expect(await layer.run(contextFor())).toEqual({ action: 'review', reason: 'stub' })
  })

  it('still only holds a comment the provider calls blatant spam', async () => {
    // The reason token is the moderator's signal and the only thing that changes.
    // See src/spam/provider.ts for why there is no reject branch at all.
    const provider = stub('blatant-spam')
    const layer = providerLayer({ provider, siteUrl })

    expect(await layer.run(contextFor())).toEqual({ action: 'review', reason: 'stub-discard' })
  })

  it('never returns a reject, whatever a provider answers', async () => {
    for (const verdict of ['spam', 'blatant-spam', 'ham', 'unknown'] as const) {
      const layer = providerLayer({ provider: stub(verdict), siteUrl })
      const outcome = await layer.run(contextFor())

      expect(outcome?.action ?? 'review').toBe('review')
    }
  })

  it('abstains on ham and on no answer', async () => {
    expect(await providerLayer({ provider: stub('ham'), siteUrl }).run(contextFor())).toBeNull()
    expect(await providerLayer({ provider: stub('unknown'), siteUrl }).run(contextFor())).toBeNull()
  })

  it('abstains rather than throwing when the provider throws', async () => {
    // `runLayers` does not catch, so a layer that threw would turn a reader's
    // comment into a 500 — on a feature that is a convenience.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const provider: SpamProvider = {
      name: 'broken',
      check: () => Promise.reject(new Error('boom')),
    }

    expect(await providerLayer({ provider, siteUrl }).run(contextFor())).toBeNull()
    error.mockRestore()
  })

  it('is reviewOnly, so a held comment never spends a metered check', () => {
    expect(providerLayer({ provider: stub('spam'), siteUrl }).reviewOnly).toBe(true)
  })

  it('is named for the layer, not for the provider', () => {
    expect(providerLayer({ provider: stub('ham'), siteUrl }).name).toBe(PROVIDER_LAYER_NAME)
  })
})

describe('what the seam hands a provider', () => {
  it('builds the permalink from the owner site URL and the derived page key', async () => {
    // `pageUrl` carries an attacker-chosen origin (src/page-key.ts drops the origin
    // from identity precisely because it is not trustworthy), so passing it on would
    // let any caller put any URL into the owner's account at a third party.
    //
    // **The site URL here deliberately differs from the fixture's `pageUrl`
    // origin.** With both set to `https://maya.build` this assertion holds either
    // way, so it would read as coverage of a guard it was not exercising — which a
    // kill-shot found it doing.
    const provider = stub('ham')
    const context = contextFor({ pageKey: '/notes/leaving' })
    expect(context.pageUrl).toBe('https://maya.build/notes/leaving')

    await providerLayer({ provider, siteUrl: 'https://elsewhere.example' }).run(context)

    expect(provider.seen[0]?.permalink).toBe('https://elsewhere.example/notes/leaving')
  })

  it('sends no permalink for a data-thread key, which is not a path', async () => {
    const provider = stub('ham')
    await providerLayer({ provider, siteUrl }).run(contextFor({ pageKey: 'id:release-notes' }))

    expect(provider.seen[0]?.permalink).toBeNull()
  })

  it('passes the connection metadata a provider judges on', async () => {
    const provider = stub('ham')
    const context = contextFor({ ip: '203.0.113.9' })
    context.request.headers.set('user-agent', 'Mozilla/5.0 (test)')
    context.request.headers.set('referer', 'https://maya.build/notes/leaving')

    await providerLayer({ provider, siteUrl }).run(context)

    expect(provider.seen[0]).toMatchObject({
      ip: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (test)',
      referrer: 'https://maya.build/notes/leaving',
      siteUrl,
    })
  })

  it('passes the comment, and the email only when the reader gave one', async () => {
    const provider = stub('ham')
    const context = contextFor({ authorName: 'Rahul Kanwar', body: 'a real comment' })
    await providerLayer({ provider, siteUrl }).run(context)

    expect(provider.seen[0]).toMatchObject({
      authorName: 'Rahul Kanwar',
      body: 'a real comment',
      kind: 'comment',
    })
    expect(provider.seen[0]?.authorEmail).toBeUndefined()

    const withEmail = stub('ham')
    const replyContext = contextFor()
    replyContext.comment = {
      ...replyContext.comment,
      authorEmail: 'rahul@example.com',
      parentId: 7,
    }
    await providerLayer({ provider: withEmail, siteUrl }).run(replyContext)

    expect(withEmail.seen[0]?.authorEmail).toBe('rahul@example.com')
    expect(withEmail.seen[0]?.kind).toBe('reply')
  })
})
