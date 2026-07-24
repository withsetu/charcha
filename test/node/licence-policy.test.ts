import { describe, expect, it } from 'vitest'
import {
  DEV_ALLOWED,
  PROD_ALLOWED,
  checkLicences,
  isAllowed,
  tierOf,
} from '../../scripts/licence-policy.mjs'

/** A lockfileVersion 3 shaped fixture. */
const lockfile = (packages: Record<string, unknown>) => ({
  name: 'charcha',
  lockfileVersion: 3,
  packages: { '': { name: 'charcha', license: 'MIT' }, ...packages },
})

const pkg = (license: unknown, extra: Record<string, unknown> = {}) => ({
  version: '1.0.0',
  license,
  ...extra,
})

describe('SPDX expression evaluation', () => {
  it('allows a bare identifier on the allowlist', () => {
    expect(isAllowed('MIT', PROD_ALLOWED)).toBe(true)
  })

  it('rejects a bare identifier that is not on the allowlist', () => {
    expect(isAllowed('GPL-3.0-only', PROD_ALLOWED)).toBe(false)
  })

  it('allows a disjunction when either side is allowed, because the licensee picks', () => {
    // Real example: node-forge is published as "(BSD-3-Clause OR GPL-2.0)".
    expect(isAllowed('(BSD-3-Clause OR GPL-2.0)', PROD_ALLOWED)).toBe(true)
    expect(isAllowed('GPL-2.0 OR BSD-3-Clause', PROD_ALLOWED)).toBe(true)
  })

  it('rejects a conjunction unless every side is allowed, because the licensee is bound by both', () => {
    // Real example: @img/sharp-win32-x64 is "Apache-2.0 AND LGPL-3.0-or-later".
    // A substring allowlist would pass this on Apache-2.0 alone. That is the
    // bug this test exists to keep fixed.
    expect(isAllowed('Apache-2.0 AND LGPL-3.0-or-later', PROD_ALLOWED)).toBe(false)
    expect(isAllowed('Apache-2.0 AND LGPL-3.0-or-later', DEV_ALLOWED)).toBe(true)
    expect(isAllowed('MIT AND GPL-3.0-only', DEV_ALLOWED)).toBe(false)
  })

  it('binds AND tighter than OR, per the SPDX default precedence', () => {
    // `GPL-3.0-only OR (MIT AND ISC)` — the parenthesised reading is allowed.
    expect(isAllowed('GPL-3.0-only OR MIT AND ISC', PROD_ALLOWED)).toBe(true)
    // If OR bound tighter this would read `(GPL OR MIT) AND AGPL` and the
    // result would differ; AND-tighter makes it `GPL OR (MIT AND AGPL)`.
    expect(isAllowed('GPL-3.0-only OR MIT AND AGPL-3.0-only', PROD_ALLOWED)).toBe(false)
  })

  it('honours parentheses over the default precedence', () => {
    expect(isAllowed('(GPL-3.0-only OR MIT) AND ISC', PROD_ALLOWED)).toBe(true)
    expect(isAllowed('(GPL-3.0-only OR AGPL-3.0-only) AND MIT', PROD_ALLOWED)).toBe(false)
  })

  it('treats a WITH exception as riding on its base licence', () => {
    expect(isAllowed('Apache-2.0 WITH LLVM-exception', PROD_ALLOWED)).toBe(true)
    expect(isAllowed('GPL-3.0-only WITH Classpath-exception-2.0', PROD_ALLOWED)).toBe(false)
  })

  it('resolves an "or later" suffix to its base identifier', () => {
    expect(isAllowed('Apache-2.0+', PROD_ALLOWED)).toBe(true)
    expect(isAllowed('GPL-2.0+', PROD_ALLOWED)).toBe(false)
  })

  it('matches identifiers and operators case-insensitively', () => {
    expect(isAllowed('mit or gpl-3.0-only', PROD_ALLOWED)).toBe(true)
    expect(isAllowed('mit and gpl-3.0-only', PROD_ALLOWED)).toBe(false)
  })

  it('throws rather than guessing on a malformed expression', () => {
    expect(() => isAllowed('MIT AND', PROD_ALLOWED)).toThrow()
    expect(() => isAllowed('(MIT OR ISC', PROD_ALLOWED)).toThrow()
    expect(() => isAllowed('MIT ISC', PROD_ALLOWED)).toThrow()
    expect(() => isAllowed('', PROD_ALLOWED)).toThrow()
  })

  it('throws on an unparseable operand even when the other side is allowed', () => {
    // Short-circuiting `MIT OR <garbage>` to true would let a malformed
    // expression through unexamined.
    expect(() => isAllowed('MIT OR (', PROD_ALLOWED)).toThrow()
  })
})

describe('tierOf', () => {
  it('treats dev and devOptional packages as development', () => {
    expect(tierOf({ dev: true })).toBe('dev')
    expect(tierOf({ devOptional: true })).toBe('dev')
  })

  it('treats everything else as production, including optional production deps', () => {
    expect(tierOf({})).toBe('prod')
    expect(tierOf({ optional: true })).toBe('prod')
    expect(tierOf({ dev: false })).toBe('prod')
  })
})

describe('checkLicences', () => {
  it('passes a tree whose licences are all within policy', () => {
    const result = checkLicences({
      lockfile: lockfile({
        'node_modules/hono': pkg('MIT'),
        'node_modules/eslint': pkg('MIT', { dev: true }),
      }),
    })

    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
    expect(result.counts).toEqual({ prod: 1, dev: 1 })
  })

  it('fails a copyleft package in the production tree', () => {
    const result = checkLicences({
      lockfile: lockfile({ 'node_modules/lightningcss': pkg('MPL-2.0') }),
    })

    expect(result.ok).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({
      name: 'lightningcss',
      tier: 'prod',
      status: 'not-allowed',
      licence: 'MPL-2.0',
    })
  })

  it('allows that same package when it is only build tooling', () => {
    const result = checkLicences({
      lockfile: lockfile({ 'node_modules/lightningcss': pkg('MPL-2.0', { dev: true }) }),
    })

    expect(result.ok).toBe(true)
  })

  it('fails strong copyleft even in the development tree', () => {
    const result = checkLicences({
      lockfile: lockfile({ 'node_modules/readability-cli': pkg('GPL-3.0-only', { dev: true }) }),
    })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ tier: 'dev', status: 'not-allowed' })
  })

  it('fails a package that declares no licence at all', () => {
    const result = checkLicences({
      lockfile: lockfile({ 'node_modules/mystery': { version: '1.0.0' } }),
    })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'no-licence', name: 'mystery' })
  })

  it('fails a licence field that is not a string, rather than coercing it', () => {
    // The deprecated `{ type, url }` form. Reading `.type` would be a guess.
    const result = checkLicences({
      lockfile: lockfile({ 'node_modules/old': pkg({ type: 'MIT' }) }),
    })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'no-licence' })
  })

  it('fails an unparseable licence expression rather than skipping it', () => {
    const result = checkLicences({
      lockfile: lockfile({ 'node_modules/weird': pkg('MIT AND') }),
    })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'unparseable', name: 'weird' })
  })

  it('fails a lockfile with no packages map instead of reporting a clean tree', () => {
    const result = checkLicences({ lockfile: { name: 'charcha', lockfileVersion: 1 } })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'unreadable-lockfile' })
  })

  it('fails an empty tree instead of passing having checked nothing', () => {
    const result = checkLicences({ lockfile: { lockfileVersion: 3, packages: {} } })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'empty-lockfile' })
  })

  it('skips workspace links so the linked package is not judged twice', () => {
    const result = checkLicences({
      lockfile: lockfile({
        'node_modules/pkg': { link: true, resolved: 'packages/pkg' },
        'packages/pkg': pkg('MIT'),
      }),
    })

    expect(result.ok).toBe(true)
    expect(result.counts.prod).toBe(1)
  })

  it('applies a caller-supplied policy, so the tiers are not hard-coded into the walk', () => {
    const result = checkLicences({
      lockfile: lockfile({ 'node_modules/hono': pkg('MIT') }),
      policy: { prod: ['ISC'], dev: ['ISC'] },
    })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'not-allowed', licence: 'MIT' })
  })
})

describe('the policy itself', () => {
  it('permits no strong-copyleft licence in either tier', () => {
    for (const licence of [
      'GPL-2.0-only',
      'GPL-3.0-only',
      'GPL-3.0-or-later',
      'AGPL-3.0-only',
      'AGPL-3.0-or-later',
      'SSPL-1.0',
      'BUSL-1.1',
    ]) {
      expect(isAllowed(licence, PROD_ALLOWED), `${licence} in prod`).toBe(false)
      expect(isAllowed(licence, DEV_ALLOWED), `${licence} in dev`).toBe(false)
    }
  })

  it('permits no copyleft at all in the production tier', () => {
    for (const licence of ['MPL-2.0', 'LGPL-3.0-or-later', 'EPL-2.0', 'CDDL-1.0']) {
      expect(isAllowed(licence, PROD_ALLOWED), `${licence} in prod`).toBe(false)
    }
  })
})
