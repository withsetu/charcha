import { describe, expect, it } from 'vitest'
import {
  DEV_ALLOWED,
  PROD_ALLOWED,
  checkLicences,
  flattenLicenceReport,
  isAllowed,
  parseLockfilePackages,
  tierOf,
} from '../../scripts/licence-policy.mjs'

const split = (key: string) => {
  const at = key.lastIndexOf('@')
  return { name: key.slice(0, at), version: key.slice(at + 1), key }
}

/** A parsed pnpm-lock.yaml, as `parseLockfilePackages` returns one. */
const lockfile = (entries: Array<[string, boolean?]>) => ({
  version: '9.0',
  packages: entries.map(([key, optional = false]) => ({ ...split(key), optional })),
})

/** A flattened `pnpm licenses list --json` report. */
const installed = (entries: Array<[string, unknown]>) =>
  entries.map(([key, licence]) => ({ ...split(key), licence }))

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

describe('parseLockfilePackages', () => {
  // Trimmed from the real pnpm-lock.yaml: one plain package, one platform
  // binary, one wasm-fallback package that carries no platform fields of its
  // own, and the `snapshots:` block that marks the latter two optional.
  const source = [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    '      hono:',
    '        specifier: ^4.12.31',
    '        version: 4.12.31',
    '',
    'packages:',
    '',
    "  '@emnapi/core@1.11.1':",
    '    resolution: {integrity: sha512-aaa==}',
    '',
    "  '@img/sharp-libvips-linux-x64@1.3.1':",
    '    resolution: {integrity: sha512-bbb==}',
    '    cpu: [x64]',
    '    os: [linux]',
    '',
    '  hono@4.12.31:',
    '    resolution: {integrity: sha512-ccc==}',
    "    engines: {node: '>=16.9.0'}",
    '',
    'snapshots:',
    '',
    "  '@emnapi/core@1.11.1':",
    '    dependencies:',
    "      '@emnapi/wasi-threads': 1.2.2",
    '    optional: true',
    '',
    "  '@img/sharp-libvips-linux-x64@1.3.1':",
    '    optional: true',
    '',
    '  hono@4.12.31: {}',
    '',
  ].join('\n')

  it('reads the whole packages block, scoped and unscoped alike', () => {
    const { version, packages } = parseLockfilePackages(source)

    expect(version).toBe('9.0')
    expect(packages.map((entry: { key: string }) => entry.key)).toEqual([
      '@emnapi/core@1.11.1',
      '@img/sharp-libvips-linux-x64@1.3.1',
      'hono@4.12.31',
    ])
  })

  it('splits a scoped identifier at the last @, not the first', () => {
    const { packages } = parseLockfilePackages(source)

    expect(packages[0]).toMatchObject({ name: '@emnapi/core', version: '1.11.1' })
    expect(packages[2]).toMatchObject({ name: 'hono', version: '4.12.31' })
  })

  it('takes optionality from snapshots, so it is transitive rather than per-platform', () => {
    // @emnapi/core has no cpu/os of its own — it is optional only because
    // everything that reaches it is. Reading cpu/os alone would miss it, which
    // is exactly what a licence gate must not do quietly.
    const { packages } = parseLockfilePackages(source)

    expect(packages.map((entry: { optional: boolean }) => entry.optional)).toEqual([
      true,
      true,
      false,
    ])
  })

  it('ignores blocks other than packages and snapshots', () => {
    // `importers:` holds the specifier `^4.12.31` at the same indent shape as a
    // package key; counting it would inflate the total the coverage check uses.
    const { packages } = parseLockfilePackages(source)

    expect(packages).toHaveLength(3)
  })

  it('strips the peer suffix from a snapshot key so it matches its package entry', () => {
    const withPeers = [
      "lockfileVersion: '9.0'",
      'packages:',
      '  vite@8.1.5:',
      '    resolution: {integrity: sha512-ddd==}',
      'snapshots:',
      '  vite@8.1.5(@types/node@22.20.1)(esbuild@0.28.1):',
      '    optional: true',
    ].join('\n')

    expect(parseLockfilePackages(withPeers).packages[0]).toMatchObject({
      key: 'vite@8.1.5',
      optional: true,
    })
  })
})

describe('flattenLicenceReport', () => {
  it('turns the licence-keyed report into one record per name@version', () => {
    const flattened = flattenLicenceReport({
      'MIT OR Apache-2.0': [
        { name: 'wrangler', versions: ['4.114.0'], license: 'MIT OR Apache-2.0' },
      ],
      MIT: [{ name: 'hono', versions: ['4.12.31', '4.12.30'], license: 'MIT' }],
    })

    expect(flattened).toEqual([
      {
        name: 'wrangler',
        version: '4.114.0',
        key: 'wrangler@4.114.0',
        licence: 'MIT OR Apache-2.0',
      },
      { name: 'hono', version: '4.12.31', key: 'hono@4.12.31', licence: 'MIT' },
      { name: 'hono', version: '4.12.30', key: 'hono@4.12.30', licence: 'MIT' },
    ])
  })

  it('falls back to the grouping key when an entry carries no licence of its own', () => {
    expect(flattenLicenceReport({ ISC: [{ name: 'x', versions: ['1.0.0'] }] })).toEqual([
      { name: 'x', version: '1.0.0', key: 'x@1.0.0', licence: 'ISC' },
    ])
  })
})

describe('tierOf', () => {
  it('treats a package in the production graph as production', () => {
    expect(tierOf('hono@4.12.31', new Set(['hono@4.12.31']))).toBe('prod')
  })

  it('treats everything else as development, because only build tooling is left', () => {
    expect(tierOf('eslint@10.7.0', new Set(['hono@4.12.31']))).toBe('dev')
  })

  it('keeps an optional production dependency in the production tier', () => {
    // `pnpm licenses list --prod` covers dependencies *and*
    // optionalDependencies, and a bundler can still reach an optional one.
    expect(tierOf('fsevents@2.3.3', new Set(['fsevents@2.3.3']))).toBe('prod')
  })
})

describe('checkLicences', () => {
  const prodKeys = new Set(['hono@1.0.0'])

  it('passes a tree whose licences are all within policy', () => {
    const result = checkLicences({
      installed: installed([
        ['hono@1.0.0', 'MIT'],
        ['eslint@1.0.0', 'MIT'],
      ]),
      prodKeys,
      lockfile: lockfile([['hono@1.0.0'], ['eslint@1.0.0']]),
    })

    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
    expect(result.counts).toEqual({ prod: 1, dev: 1 })
    expect(result.coverage).toEqual({ inspected: 2, locked: 2, skipped: 0 })
  })

  it('fails a copyleft package in the production tree', () => {
    const result = checkLicences({
      installed: installed([['lightningcss@1.0.0', 'MPL-2.0']]),
      prodKeys: new Set(['lightningcss@1.0.0']),
      lockfile: lockfile([['lightningcss@1.0.0']]),
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
      installed: installed([['lightningcss@1.0.0', 'MPL-2.0']]),
      lockfile: lockfile([['lightningcss@1.0.0']]),
    })

    expect(result.ok).toBe(true)
  })

  it('fails strong copyleft even in the development tree', () => {
    const result = checkLicences({
      installed: installed([['readability-cli@1.0.0', 'GPL-3.0-only']]),
      lockfile: lockfile([['readability-cli@1.0.0']]),
    })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ tier: 'dev', status: 'not-allowed' })
  })

  it('fails a package that declares no licence at all', () => {
    const result = checkLicences({
      installed: installed([['mystery@1.0.0', undefined]]),
      lockfile: lockfile([['mystery@1.0.0']]),
    })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'no-licence', name: 'mystery' })
  })

  it("fails pnpm's 'Unknown' placeholder rather than evaluating it as an identifier", () => {
    const result = checkLicences({
      installed: installed([['mystery@1.0.0', 'Unknown']]),
      lockfile: lockfile([['mystery@1.0.0']]),
    })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'no-licence' })
  })

  it('fails a licence field that is not a string, rather than coercing it', () => {
    // The deprecated `{ type, url }` form. Reading `.type` would be a guess.
    const result = checkLicences({
      installed: installed([['old@1.0.0', { type: 'MIT' }]]),
      lockfile: lockfile([['old@1.0.0']]),
    })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'no-licence' })
  })

  it('fails an unparseable licence expression rather than skipping it', () => {
    const result = checkLicences({
      installed: installed([['weird@1.0.0', 'MIT AND']]),
      lockfile: lockfile([['weird@1.0.0']]),
    })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'unparseable', name: 'weird' })
  })

  it('fails a lockfile it could not parse instead of reporting a clean tree', () => {
    const result = checkLicences({
      installed: installed([['hono@1.0.0', 'MIT']]),
      lockfile: { version: '9.0', packages: null },
    })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'unreadable-lockfile' })
  })

  it('fails a lockfile version the scanner was not written for', () => {
    // A newer pnpm could reshape the file, and a scanner that quietly matched
    // fewer lines would report a smaller tree as a clean one.
    const result = checkLicences({
      installed: installed([['hono@1.0.0', 'MIT']]),
      lockfile: { version: '10.0', packages: [{ ...split('hono@1.0.0'), optional: false }] },
    })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'unsupported-lockfile' })
  })

  it('fails an empty lockfile instead of passing having checked nothing', () => {
    const result = checkLicences({
      installed: installed([['hono@1.0.0', 'MIT']]),
      lockfile: lockfile([]),
    })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'empty-lockfile' })
  })

  it('fails when nothing is installed, rather than passing on an empty report', () => {
    const result = checkLicences({ installed: [], lockfile: lockfile([['hono@1.0.0']]) })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'nothing-installed' })
  })

  it('fails a lockfile entry that is missing from the report and is not optional', () => {
    // The gate reads what is installed, so a partial install — `--prod`,
    // `--no-optional`, an interrupted one — would otherwise look like a small
    // clean tree. This is what keeps the narrowed data source honest.
    const result = checkLicences({
      installed: installed([['hono@1.0.0', 'MIT']]),
      lockfile: lockfile([['hono@1.0.0'], ['eslint@1.0.0']]),
    })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'uncovered', name: 'eslint' })
  })

  it('accepts an optional lockfile entry that this platform cannot install', () => {
    const result = checkLicences({
      installed: installed([['hono@1.0.0', 'MIT']]),
      lockfile: lockfile([['hono@1.0.0'], ['@img/sharp-linux-x64@1.0.0', true]]),
    })

    expect(result.ok).toBe(true)
    expect(result.coverage).toEqual({ inspected: 1, locked: 2, skipped: 1 })
  })

  it('applies a caller-supplied policy, so the tiers are not hard-coded into the walk', () => {
    const result = checkLicences({
      installed: installed([['hono@1.0.0', 'MIT']]),
      prodKeys,
      lockfile: lockfile([['hono@1.0.0']]),
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
