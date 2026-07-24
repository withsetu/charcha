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

import { access, readFile } from 'node:fs/promises'
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

/**
 * Lockfile *format* versions the Cloudflare Workers Builds image can read.
 *
 * This is a separate pin from `packageManager`, and it is the one that reaches a
 * one-click deploy. Workers Builds takes its pnpm version from the build image
 * (v3 ships pnpm 10.11.1) or a `PNPM_VERSION` dashboard variable — neither of
 * which a site owner clicking Deploy can set — so charcha has to stay
 * *compatible with* the image rather than dictate to it.
 *
 * The reason this is a gate and not a note: handed a lockfile it cannot read,
 * pnpm emits `WARN Ignoring not compatible lockfile` and **resolves fresh**
 * rather than failing. The deploy goes green having installed a tree nobody
 * locked and nobody tested, and the person it breaks for is a site owner who
 * never sees this repository. Nothing else here would notice.
 *
 * It is checked now because Dependabot rewrites this file on a schedule (see
 * .github/dependabot.yml), and a bot rewriting the format version is not
 * hypothetical: dependabot/dependabot-core#9684 is a 9.0 lockfile regressed to
 * 6.0.
 *
 * Source: https://developers.cloudflare.com/workers/ci-cd/builds/build-image/
 */
export const SUPPORTED_LOCKFILE_VERSIONS = ['9.0']

// `lockfileVersion: '9.0'` — pnpm quotes it, but bare YAML scalars are valid too.
const LOCKFILE_VERSION = /^lockfileVersion:\s*['"]?([0-9]+(?:\.[0-9]+)*)['"]?\s*$/m

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
  } else {
    const lockfile = await readFile(join(cwd, REQUIRED_LOCKFILE), 'utf8')
    const version = LOCKFILE_VERSION.exec(lockfile)?.[1] ?? null

    if (version === null) {
      violations.push({
        status: 'unreadable-lockfile-version',
        message:
          `${REQUIRED_LOCKFILE} declares no \`lockfileVersion\` — the format it is in cannot be ` +
          'established, so it cannot be shown to be one the Cloudflare build image reads',
      })
    } else if (!SUPPORTED_LOCKFILE_VERSIONS.includes(version)) {
      violations.push({
        status: 'unsupported-lockfile-version',
        message:
          `${REQUIRED_LOCKFILE} is lockfileVersion '${version}', and the Cloudflare build image ` +
          `reads ${SUPPORTED_LOCKFILE_VERSIONS.map((one) => `'${one}'`).join(', ')}. pnpm does not ` +
          'fail on a lockfile it cannot read — it warns and resolves fresh, so a one-click deploy ' +
          'would install a tree nobody locked. Re-resolve with pnpm 10.x, or move the pin ' +
          'deliberately.',
      })
    }
  }

  // A `packageManager` field is what pins the pnpm version for contributors
  // (via corepack) and for `pnpm/action-setup` in CI, so that dev and CI run
  // byte-identical tooling. It does *not* reach the Cloudflare build — Workers
  // Builds takes its pnpm version from the build image or a dashboard
  // `PNPM_VERSION` variable, neither of which a one-click deploy can set. That
  // is why the pin must stay on the 10 line: the image ships pnpm 10.x, and the
  // lockfile has to stay readable by it.
  // Source: https://developers.cloudflare.com/workers/ci-cd/builds/build-image/
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
        'contributors or CI, which is the drift #52 was caused by',
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

  console.log(
    `[ok] pnpm is the only lockfile here, its version is pinned, and its format is one the ` +
      `Cloudflare build image reads (${SUPPORTED_LOCKFILE_VERSIONS.join(', ')})`,
  )
}
