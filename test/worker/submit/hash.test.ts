import { describe, expect, it } from 'vitest'
import { computeBodyHash } from '../../../src/submit/hash'

// The DB requires a body_hash on every insert and indexes (thread_id, body_hash)
// for duplicate detection (#8, layer 6). So the only property that matters here is
// that identical bodies hash identically and different bodies (almost) never do —
// not secrecy. SHA-256 gives that deterministically and without a dependency.
describe('computeBodyHash', () => {
  it('is stable — the same body always hashes to the same value', async () => {
    const a = await computeBodyHash('The part people underestimate is the export.')
    const b = await computeBodyHash('The part people underestimate is the export.')

    expect(a).toBe(b)
  })

  it('is a lowercase hex SHA-256 digest, so it fits the TEXT column as-is', async () => {
    const hash = await computeBodyHash('hello')

    // Known SHA-256 of "hello".
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('separates two different bodies, so a duplicate is a real duplicate', async () => {
    const a = await computeBodyHash('buy pills')
    const b = await computeBodyHash('buy pills now')

    expect(a).not.toBe(b)
  })

  it('does not collapse a body and its whitespace-trimmed form — the caller trims first', async () => {
    // The pipeline hashes the *stored* (already-trimmed) body, so this function
    // must not trim on its own, or two different stored strings could collide.
    const spaced = await computeBodyHash('  spaced  ')
    const tight = await computeBodyHash('spaced')

    expect(spaced).not.toBe(tight)
  })
})
