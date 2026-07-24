import { describe, expect, it } from 'vitest'
import { HONEYPOT_FIELD } from '../../../src/spam/fields'
import { honeypotLayer } from '../../../src/spam/honeypot'
import { contextFor } from './context'

const layer = honeypotLayer()

describe('layer 1 — the honeypot field', () => {
  it('rejects a submission that filled the field no human can see', async () => {
    const outcome = await layer.run(
      contextFor({ form: { [HONEYPOT_FIELD]: 'http://buy-pills.example' } }),
    )

    expect(outcome?.action).toBe('reject')
  })

  it('lets an empty honeypot through, because that is what the embed sends', async () => {
    const outcome = await layer.run(contextFor({ form: { [HONEYPOT_FIELD]: '' } }))

    expect(outcome).toBeNull()
  })

  it('treats a whitespace-only value as empty, so a stray space cannot lose a real comment', async () => {
    const outcome = await layer.run(contextFor({ form: { [HONEYPOT_FIELD]: '   ' } }))

    expect(outcome).toBeNull()
  })

  it('abstains when the field is absent entirely, because absence is not evidence', async () => {
    // A caller that never rendered the form — a stale cached embed, or curl — has
    // not tripped the trap. Rejecting on absence would turn "did not send a field"
    // into "is a spammer", which is a different and much weaker claim.
    const outcome = await layer.run(contextFor({ form: {} }))

    expect(outcome).toBeNull()
  })

  it('rejects a non-string value, so a bot cannot dodge the trap with a number or an array', async () => {
    expect((await layer.run(contextFor({ form: { [HONEYPOT_FIELD]: 1 } })))?.action).toBe('reject')
    expect((await layer.run(contextFor({ form: { [HONEYPOT_FIELD]: ['x'] } })))?.action).toBe(
      'reject',
    )
  })

  it('names the layer, not the field, in the reason it hands back', async () => {
    // The reason reaches logs and the moderation queue, never the reader — the
    // pipeline replaces it with a generic message. But it must not print the
    // field name into a log the site owner might paste into an issue.
    const outcome = await layer.run(contextFor({ form: { [HONEYPOT_FIELD]: 'x' } }))

    expect(outcome?.reason).not.toContain(HONEYPOT_FIELD)
  })
})
