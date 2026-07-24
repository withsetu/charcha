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
// Enforced by test/node/licence-policy.test.ts.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

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
 * because npm metadata is not consistent about them; identifiers are compared
 * case-insensitively too, per the SPDX spec's case-insensitive identifiers.
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

/**
 * Which allowlist applies to a lockfile entry.
 *
 * `dev` marks a package reachable only from devDependencies; `devOptional`,
 * one reachable only from dev or optional edges. Anything else is treated as
 * production — including plain `optional` production deps, which a bundler can
 * still reach. Defaulting to the stricter tier is the fail-closed direction.
 *
 * @param {Record<string, unknown>} entry
 * @returns {'dev' | 'prod'}
 */
export function tierOf(entry) {
  return entry.dev === true || entry.devOptional === true ? 'dev' : 'prod'
}

/**
 * @param {{ lockfile: Record<string, any>, policy?: typeof POLICY }} options
 * @returns {{ ok: boolean, violations: Array<object>, counts: Record<string, number> }}
 */
export function checkLicences({ lockfile, policy = POLICY }) {
  const violations = []
  const counts = { prod: 0, dev: 0 }

  const packages = lockfile?.packages

  // A lockfile this script cannot read is not a pass. `packages` is absent in
  // lockfileVersion 1, and an empty map means the checker is inspecting nothing
  // while reporting success — the failure mode this gate exists to avoid.
  if (packages === undefined || packages === null || typeof packages !== 'object') {
    return {
      ok: false,
      counts,
      violations: [
        {
          name: '(lockfile)',
          version: null,
          tier: 'prod',
          licence: null,
          status: 'unreadable-lockfile',
          message:
            'package-lock.json has no `packages` map — lockfileVersion 2 or 3 is required for licence data',
        },
      ],
    }
  }

  const entries = Object.entries(packages).filter(([path]) => path !== '')

  if (entries.length === 0) {
    return {
      ok: false,
      counts,
      violations: [
        {
          name: '(lockfile)',
          version: null,
          tier: 'prod',
          licence: null,
          status: 'empty-lockfile',
          message: 'no packages found in the lockfile — nothing was checked',
        },
      ],
    }
  }

  for (const [path, entry] of entries) {
    // A workspace link is a pointer; the linked package is checked at its own
    // path and would otherwise be counted, and reported, twice.
    if (entry.link === true) continue

    const tier = tierOf(entry)
    const allowedList = policy[tier]
    const name = entry.name ?? path.replace(/^.*node_modules\//, '')
    const version = entry.version ?? null
    counts[tier] += 1

    const licence = entry.license

    if (typeof licence !== 'string' || licence.trim() === '') {
      violations.push({
        name,
        version,
        tier,
        licence: licence === undefined ? null : licence,
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

  return { ok: violations.length === 0, violations, counts }
}

/**
 * @param {{ cwd?: string }} options
 */
export async function readLockfile({ cwd = process.cwd() } = {}) {
  const raw = await readFile(join(cwd, 'package-lock.json'), 'utf8')
  return JSON.parse(raw)
}

const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (isCli) {
  let lockfile
  try {
    lockfile = await readLockfile()
  } catch (error) {
    console.error(
      `licence-policy: could not read package-lock.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exit(1)
  }

  const { ok, violations, counts } = checkLicences({ lockfile })

  console.log(
    `[licences] checked ${counts.prod} production and ${counts.dev} development packages from package-lock.json`,
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
