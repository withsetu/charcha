// This repository resolves dependencies with pnpm, and the reason is a bug, not
// a preference. npm's `package-lock.json` records the tree that was installed on
// the resolving machine: on macOS/arm64 npm resolves sharp's native binary and
// *omits* the wasm fallback's `@emnapi/*` dependencies, the Linux runner needs
// them, and `npm ci` fails closed before a single test runs. It broke CI twice
// (6a9abc3, 91266cc) before #52 moved the project to pnpm, whose lockfile is a
// complete, platform-independent resolution graph with nothing to prune.
//
// A single `npm install` in this directory recreates `package-lock.json` and
// reintroduces all of that. `.gitignore` would only hide it — the stray lockfile
// would still be what a contributor's next `npm ci` reads, and the failure would
// still surface in CI rather than here. So this fails loudly instead, and does
// it in `check`, which is the command CLAUDE.md tells every session to run
// before pushing.
//
// Enforced by test/node/lockfile-guard.test.ts.

import { access } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Lockfiles from package managers this project does not use. */
export const FOREIGN_LOCKFILES = [
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'npm-shrinkwrap.json', manager: 'npm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'bun.lock', manager: 'bun' },
]

export const REQUIRED_LOCKFILE = 'pnpm-lock.yaml'

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * @param {{ cwd?: string }} options
 * @returns {Promise<{ ok: boolean, violations: Array<{ status: string, message: string }> }>}
 */
export async function checkLockfiles({ cwd = process.cwd() } = {}) {
  const violations = []

  for (const { file, manager } of FOREIGN_LOCKFILES) {
    if (!(await exists(join(cwd, file)))) continue
    violations.push({
      status: 'foreign-lockfile',
      message:
        `${file} exists — this project resolves with pnpm, and ${manager === 'npm' ? 'an' : 'a'} ${manager} lockfile here is ` +
        `platform-tainted (see #52). Delete it and run \`pnpm install\`.`,
    })
  }

  if (!(await exists(join(cwd, REQUIRED_LOCKFILE)))) {
    violations.push({
      status: 'missing-lockfile',
      message: `${REQUIRED_LOCKFILE} does not exist — the dependency tree is unpinned`,
    })
  }

  // A `packageManager` field is what pins the pnpm version for contributors,
  // for `pnpm/action-setup` in CI, and for Cloudflare Workers Builds, whose v3
  // build system does not infer a pnpm version from the lockfile.
  // Source: https://developers.cloudflare.com/pages/configuration/build-image/
  let declared = null
  try {
    declared = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).packageManager ?? null
  } catch (error) {
    violations.push({
      status: 'unreadable-package-json',
      message: `package.json could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
  }

  if (declared !== null && !/^pnpm@\d+\.\d+\.\d+/.test(declared)) {
    violations.push({
      status: 'wrong-package-manager',
      message: `package.json declares packageManager '${declared}' — it must pin an exact pnpm version, as \`pnpm@x.y.z\``,
    })
  } else if (declared === null) {
    violations.push({
      status: 'no-package-manager',
      message:
        'package.json has no `packageManager` field — nothing pins the pnpm version for ' +
        'contributors, CI, or the Cloudflare Deploy button',
    })
  }

  return { ok: violations.length === 0, violations }
}

const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (isCli) {
  const { ok, violations } = await checkLockfiles()

  for (const violation of violations) {
    console.log(`[${violation.status}] ${violation.message}`)
  }

  if (!ok) {
    console.error(
      `\nlockfile-guard: ${violations.length} problem(s) with the package manager setup.`,
    )
    process.exit(1)
  }

  console.log('[ok] pnpm is the only lockfile here, and its version is pinned')
}
