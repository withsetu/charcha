// Charcha ships under MIT and every site owner redeploys this Worker into their
// own Cloudflare account. The licences in this tree are therefore *their*
// redistribution terms, not only ours, and a copyleft transitive dependency
// would otherwise arrive silently on a `wrangler` bump.
//
// Two tiers, because the obligation is not the same in both:
//
//   prod — reachable from `dependencies`. This is what a bundler can pull into
//          the deployed Worker and what a self-deployer redistributes. Strict
//          permissive allowlist.
//   dev  — reachable only from `devDependencies` (or only through optional
//          deps). Build tooling: it runs in CI and on maintainer machines and
//          is never redistributed, so weak/file-level copyleft is acceptable
//          here. Strong copyleft (GPL, AGPL, SSPL, BUSL) is not, in either
//          tier — it is a signal that something is wrong with the tree.
//
// Unknown, missing or unparseable licences fail. Widening either allowlist is a
// deliberate edit to this file and shows up in review, which is the point.
//
// Where the data comes from, and why it changed with #52
// ------------------------------------------------------
// This script used to parse `package-lock.json`, which carried a `license` field
// per entry, so macOS and the Linux runner judged an identical package set.
// `pnpm-lock.yaml` carries no licence metadata at all — `grep -ci license` over
// it returns 0 — so parsing the lockfile cannot implement this policy, whatever
// YAML parser were added. Licences come from `pnpm licenses list --json`, which
// reads what is *installed*, and that is a real narrowing: foreign-platform
// optional binaries (`@esbuild/*`, `@img/sharp-*`, `lightningcss-*`, the
// `@emnapi/*` wasm chain) are absent from any one machine's install.
//
// So the lockfile is still read — for the package *set*, which it does record
// completely and platform-independently. Every lockfile entry not covered by the
// licence report must be one the lockfile itself marks `optional`, meaning
// reachable only through optional edges and so legitimately absent here. An
// uncovered entry that is *not* optional means the install is partial —
// `--prod`, `--no-optional`, a half-finished install — and the gate fails rather
// than reporting a clean tree it never looked at.
//
// Enforced by test/node/licence-policy.test.ts.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Permissive only. Every entry may be sublicensed under MIT by a site owner
// redeploying this Worker, needing at most attribution.
export const PROD_ALLOWED = [
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Unlicense',
]

// Build tooling only. The additions here are weak or file-level copyleft: they
// bind the tool's own files, not the Worker that the tool happens to build.
// Present in the tree today via `wrangler` — `lightningcss` (MPL-2.0) and
// `@img/sharp-libvips-*` (LGPL-3.0-or-later).
export const DEV_ALLOWED = [
  ...PROD_ALLOWED,
  'Artistic-2.0',
  'CC-BY-4.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MPL-2.0',
  'Python-2.0',
]

export const POLICY = { prod: PROD_ALLOWED, dev: DEV_ALLOWED }

/**
 * Tokenises an SPDX licence expression. Operators are matched case-insensitively
 * because registry metadata is not consistent about them; identifiers are
 * compared case-insensitively too, per the SPDX spec's case-insensitive
 * identifiers.
 *
 * @param {string} expression
 * @returns {string[]}
 */
function tokenise(expression) {
  return expression
    .replace(/([()])/g, ' $1 ')
    .split(/\s+/)
    .filter((token) => token !== '')
}

/**
 * Evaluates an SPDX licence expression against a set of allowed identifiers.
 *
 * Operator precedence is the SPDX default, `+ WITH AND OR` — AND binds tighter
 * than OR. That ordering is load-bearing rather than incidental:
 *
 *   `MIT OR GPL-3.0-only`  is satisfiable — the licensee picks MIT.
 *   `MIT AND GPL-3.0-only` is not — the licensee is bound by both.
 *
 * A naive substring allowlist passes the second one, which is the whole failure
 * this function exists to prevent.
 *
 * Source: https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/
 *
 * @param {string} expression
 * @param {Set<string>} allowed lower-cased allowed identifiers
 * @returns {boolean}
 * @throws {Error} if the expression cannot be parsed
 */
export function evaluateExpression(expression, allowed) {
  const tokens = tokenise(expression)
  let position = 0

  const peek = () => tokens[position]
  const isOperator = (word) => (peek() ?? '').toUpperCase() === word

  function parseOr() {
    let value = parseAnd()
    while (isOperator('OR')) {
      position += 1
      // Both sides are always parsed: an unparseable right operand must throw
      // rather than be short-circuited away by an allowed left operand.
      const right = parseAnd()
      value = value || right
    }
    return value
  }

  function parseAnd() {
    let value = parseUnary()
    while (isOperator('AND')) {
      position += 1
      const right = parseUnary()
      value = value && right
    }
    return value
  }

  function parseUnary() {
    const token = peek()
    if (token === undefined) throw new Error('unexpected end of expression')

    if (token === '(') {
      position += 1
      const value = parseOr()
      if (peek() !== ')') throw new Error('unbalanced parentheses')
      position += 1
      return value
    }

    if (token === ')' || isOperator('AND') || isOperator('OR') || isOperator('WITH')) {
      throw new Error(`unexpected token '${token}'`)
    }

    position += 1
    // `WITH <exception>` only ever grants additional permission on top of the
    // base licence, so an allowed base licence stays allowed. The full
    // `<id> WITH <exception>` string is checked first so a policy may still name
    // one explicitly.
    if (isOperator('WITH')) {
      position += 1
      const exception = peek()
      if (exception === undefined) throw new Error("'WITH' with no exception")
      position += 1
      if (allowed.has(`${token} with ${exception}`.toLowerCase())) return true
    }

    // A trailing `+` means "or any later version"; the base identifier decides.
    const identifier = token.replace(/\+$/, '').toLowerCase()
    return allowed.has(token.toLowerCase()) || allowed.has(identifier)
  }

  const result = parseOr()
  if (position !== tokens.length) throw new Error(`unexpected trailing token '${peek()}'`)
  return result
}

/**
 * @param {string} expression
 * @param {string[]} allowedList
 */
export function isAllowed(expression, allowedList) {
  const allowed = new Set(allowedList.map((entry) => entry.toLowerCase()))
  return evaluateExpression(expression, allowed)
}

/** A 2-space-indented block key, quoted or bare. */
const BLOCK_KEY = /^ {2}(?! )(?:'([^']+)'|"([^"]+)"|([^\s:][^:]*)):\s*$/

/**
 * The complete package set recorded by a `pnpm-lock.yaml`, with whether the
 * lockfile marks each entry optional.
 *
 * Two blocks are read, and the split matters:
 *
 *   `packages:`  the resolution graph — every platform's variant, recorded
 *                regardless of where the install ran. This is the set npm's
 *                lockfile could not be trusted to hold (#52), and the reason
 *                this file can still speak about a whole tree.
 *   `snapshots:` the same identifiers with peer suffixes, carrying
 *                `optional: true` on anything reachable only through optional
 *                edges.
 *
 * `optional` rather than `cpu:`/`os:` is what marks an entry as legitimately
 * absent from an install, because it is transitive: `@emnapi/core` has no
 * platform fields of its own and is reached only through `@img/sharp-wasm32`,
 * which does. pnpm has already computed that closure; recomputing it here would
 * be a worse copy of it.
 *
 * A line scanner rather than a YAML dependency, deliberately. Three field names
 * are needed from a file this repository generates itself with a pnpm version
 * pinned by `packageManager`, and a supply-chain gate that adds supply-chain
 * surface in order to run is a poor trade. The cost is that the scanner must
 * fail loudly on a shape it does not recognise rather than quietly return less —
 * hence the lockfileVersion guard and the empty-result failure in
 * `checkLicences`.
 *
 * @param {string} source contents of pnpm-lock.yaml
 * @returns {{ version: string | null, packages: Array<{ name: string, version: string, key: string, optional: boolean }> }}
 */
export function parseLockfilePackages(source) {
  const lines = source.split(/\r?\n/)

  const versionLine = lines.find((line) => line.startsWith('lockfileVersion:'))
  const version =
    versionLine === undefined
      ? null
      : versionLine.slice('lockfileVersion:'.length).trim().replace(/['"]/g, '')

  const packages = new Map()
  const optionalKeys = new Set()
  let block = null
  let current = null

  for (const line of lines) {
    if (/^\S/.test(line)) {
      const name = line.slice(0, line.indexOf(':'))
      block = name === 'packages' || name === 'snapshots' ? name : null
      current = null
      continue
    }
    if (block === null) continue

    const entry = BLOCK_KEY.exec(line)
    if (entry !== null) {
      // A snapshot key carries its peer resolutions —
      // `vite@8.1.5(esbuild@0.28.1)` — which the `packages:` key does not.
      const raw = entry[1] ?? entry[2] ?? entry[3] ?? ''
      const parenthesis = raw.indexOf('(')
      current = parenthesis === -1 ? raw : raw.slice(0, parenthesis)

      if (block === 'packages' && !packages.has(current)) {
        const at = current.lastIndexOf('@')
        packages.set(current, {
          name: at > 0 ? current.slice(0, at) : current,
          version: at > 0 ? current.slice(at + 1) : '',
          key: current,
          optional: false,
        })
      }
      continue
    }

    if (block === 'snapshots' && current !== null && /^ {4}optional:\s*true\s*$/.test(line)) {
      optionalKeys.add(current)
    }
  }

  for (const key of optionalKeys) {
    const entry = packages.get(key)
    if (entry !== undefined) entry.optional = true
  }

  return { version, packages: [...packages.values()] }
}

/**
 * Flattens `pnpm licenses list --json` — which is keyed by licence expression,
 * with one entry per package and an array of versions — into one record per
 * name@version.
 *
 * @param {Record<string, Array<{ name: string, versions?: string[], license?: string }>>} report
 * @returns {Array<{ name: string, version: string, key: string, licence: string }>}
 */
export function flattenLicenceReport(report) {
  const flattened = []
  for (const [expression, entries] of Object.entries(report ?? {})) {
    for (const entry of entries ?? []) {
      for (const version of entry.versions ?? []) {
        flattened.push({
          name: entry.name,
          version,
          key: `${entry.name}@${version}`,
          licence: entry.license ?? expression,
        })
      }
    }
  }
  return flattened
}

/**
 * Which allowlist applies to an installed package.
 *
 * `pnpm licenses list --prod` reports the production graph — `dependencies`
 * plus `optionalDependencies` — computed from the lockfile importers. Anything
 * in it is production, including a plain optional production dep, which a
 * bundler can still reach. Everything else is reachable only as build tooling.
 *
 * @param {string} key `name@version`
 * @param {Set<string>} prodKeys
 * @returns {'dev' | 'prod'}
 */
export function tierOf(key, prodKeys) {
  return prodKeys.has(key) ? 'prod' : 'dev'
}

/**
 * Both inputs are validated rather than trusted, so they are typed as the loose
 * shapes a caller might actually hand over: an unreadable lockfile and an empty
 * report are results this function reports, not preconditions it may assume
 * away.
 *
 * @param {{
 *   installed: unknown,
 *   prodKeys?: Set<string>,
 *   lockfile: { version?: unknown, packages?: unknown } | null | undefined,
 *   policy?: typeof POLICY,
 * }} options
 * @returns {{ ok: boolean, violations: Array<any>, counts: Record<string, number>, coverage: { inspected: number, locked: number, skipped: number } }}
 */
export function checkLicences({ installed, prodKeys = new Set(), lockfile, policy = POLICY }) {
  const violations = []
  const counts = { prod: 0, dev: 0 }
  const locked = lockfile?.packages
  const coverage = { inspected: 0, locked: Array.isArray(locked) ? locked.length : 0, skipped: 0 }

  const fail = (status, message) => ({
    ok: false,
    counts,
    coverage,
    violations: [
      { name: '(lockfile)', version: null, tier: 'prod', licence: null, status, message },
    ],
  })

  // A lockfile this script cannot read is not a pass. Neither is one written in
  // a shape the scanner above was not built for: it would return fewer
  // packages, and fewer packages is indistinguishable from a clean tree.
  if (!Array.isArray(locked)) {
    return fail('unreadable-lockfile', 'pnpm-lock.yaml could not be parsed — nothing was checked')
  }

  if (typeof lockfile?.version !== 'string' || !/^9\./.test(lockfile.version)) {
    return fail(
      'unsupported-lockfile',
      `pnpm-lock.yaml is lockfileVersion '${lockfile?.version}', and this checker only reads 9.x — ` +
        'update scripts/licence-policy.mjs for the new shape rather than trusting a partial read',
    )
  }

  if (locked.length === 0) {
    return fail('empty-lockfile', 'no packages found in pnpm-lock.yaml — nothing was checked')
  }

  if (!Array.isArray(installed) || installed.length === 0) {
    return fail(
      'nothing-installed',
      'pnpm licenses list reported no packages — run `pnpm install` before the licence gate',
    )
  }

  for (const entry of installed) {
    const { name, version, key, licence } = entry
    const tier = tierOf(key, prodKeys)
    const allowedList = policy[tier]
    counts[tier] += 1
    coverage.inspected += 1

    // pnpm reports a package with no `license` field as the string 'Unknown'.
    if (typeof licence !== 'string' || licence.trim() === '' || licence === 'Unknown') {
      violations.push({
        name,
        version,
        tier,
        licence: typeof licence === 'string' ? licence : null,
        status: 'no-licence',
        message: `${name}@${version} (${tier}) declares no licence — it cannot be redistributed on trust`,
      })
      continue
    }

    let permitted
    try {
      permitted = isAllowed(licence, allowedList)
    } catch (error) {
      violations.push({
        name,
        version,
        tier,
        licence,
        status: 'unparseable',
        message: `${name}@${version} (${tier}) has an unparseable licence expression '${licence}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      })
      continue
    }

    if (!permitted) {
      violations.push({
        name,
        version,
        tier,
        licence,
        status: 'not-allowed',
        message: `${name}@${version} (${tier}) is '${licence}', which the ${tier} allowlist does not permit`,
      })
    }
  }

  // Coverage. A licence report is only as good as the install it was taken
  // from, and a partial install would otherwise read as a small clean tree.
  const inspectedKeys = new Set(installed.map((entry) => entry.key))
  for (const entry of locked) {
    if (inspectedKeys.has(entry.key)) continue
    if (entry.optional) {
      coverage.skipped += 1
      continue
    }
    violations.push({
      name: entry.name,
      version: entry.version,
      tier: 'prod',
      licence: null,
      status: 'uncovered',
      message: `${entry.key} is a non-optional entry in pnpm-lock.yaml but was not installed — the licence report is incomplete, so nothing can be concluded from it`,
    })
  }

  return { ok: violations.length === 0, violations, counts, coverage }
}

/**
 * @param {{ cwd?: string }} options
 */
export async function readLockfile({ cwd = process.cwd() } = {}) {
  return parseLockfilePackages(await readFile(join(cwd, 'pnpm-lock.yaml'), 'utf8'))
}

/**
 * @param {{ cwd?: string, prod?: boolean }} options
 */
export async function readInstalledLicences({ cwd = process.cwd(), prod = false } = {}) {
  const args = ['licenses', 'list', '--json']
  if (prod) args.push('--prod')
  const { stdout } = await run('pnpm', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return flattenLicenceReport(JSON.parse(stdout))
}

const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (isCli) {
  let lockfile
  let installed
  let prodKeys
  try {
    lockfile = await readLockfile()
    installed = await readInstalledLicences()
    prodKeys = new Set((await readInstalledLicences({ prod: true })).map((entry) => entry.key))
  } catch (error) {
    console.error(
      `licence-policy: could not read the dependency tree: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exit(1)
  }

  const { ok, violations, counts, coverage } = checkLicences({ installed, prodKeys, lockfile })

  console.log(
    `[licences] checked ${counts.prod} production and ${counts.dev} development packages ` +
      `(${coverage.inspected} of ${coverage.locked} in pnpm-lock.yaml; ` +
      `${coverage.skipped} not installable on this platform)`,
  )

  for (const violation of violations) {
    console.log(`[${violation.status}] ${violation.message}`)
  }

  if (!ok) {
    console.error(
      `\nlicence-policy: ${violations.length} package(s) outside the allowlist.` +
        '\nEither drop the dependency, or widen the allowlist in scripts/licence-policy.mjs' +
        '\nas a deliberate, reviewed change.',
    )
    process.exit(1)
  }

  console.log('[ok] every package licence is within policy')
}
