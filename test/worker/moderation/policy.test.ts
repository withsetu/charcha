// The policy vocabulary. Designed on issue #173.
//
// Small on purpose: what it pins is the default and the fail-closed direction, which is
// the one property of this module a mistake anywhere else in the feature would land on.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODERATION_POLICY,
  MODERATION_POLICIES,
  isModerationPolicy,
  parseModerationPolicy,
} from '../../../src/moderation/policy'

describe('the default', () => {
  it('is hold-all, which is the behaviour every deployment already has', () => {
    expect(DEFAULT_MODERATION_POLICY).toBe('hold-all')
  })

  it('is what an unset setting reads as', () => {
    // `readSetting` answers null for a row that is not there, which is every deployment
    // until somebody changes this. A default that came out anywhere else would publish
    // comments on a site that never asked for it.
    expect(parseModerationPolicy(null)).toBe('hold-all')
  })

  it('is the first policy offered, so the safest is the one a reader meets first', () => {
    expect(MODERATION_POLICIES[0]).toBe('hold-all')
  })
})

describe('a value that is not a policy', () => {
  // Every one of these is a real way the row can end up wrong: a hand-edited D1 console,
  // a client sending the wrong type, a rename half-applied. All of them have to land on
  // the policy that holds comments, not on one that publishes them.
  const notPolicies = [
    null,
    undefined,
    '',
    ' hold-all ',
    'HOLD-ALL',
    'trust-Returning',
    'trust-everything',
    'approved',
    0,
    1,
    true,
    ['trust-returning'],
    { policy: 'trust-returning' },
  ]

  it.each(notPolicies)('reads back as hold-all: %o', (value) => {
    expect(parseModerationPolicy(value)).toBe('hold-all')
  })

  it.each(notPolicies)('is refused rather than accepted by the write path: %o', (value) => {
    expect(isModerationPolicy(value)).toBe(false)
  })
})

describe('what is shipped', () => {
  it('is exactly hold-all and trust-returning', () => {
    expect([...MODERATION_POLICIES]).toEqual(['hold-all', 'trust-returning'])
  })

  it('does not include trust-clean', () => {
    // #173 proposes it and it is deliberately not built — see src/moderation/policy.ts
    // for the argument, and #189 for where it is tracked. Asserted rather than merely
    // absent, so that adding it is a decision somebody makes on purpose rather than a
    // line somebody adds to a list.
    expect(isModerationPolicy('trust-clean')).toBe(false)
    expect(parseModerationPolicy('trust-clean')).toBe('hold-all')
  })
})
