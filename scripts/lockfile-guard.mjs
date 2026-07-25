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

/**
 * pnpm *major* versions `packageManager` may pin.
 *
 * The same constraint as `SUPPORTED_LOCKFILE_VERSIONS`, one layer up: that one
 * is the lockfile format the build image reads, this one is the pnpm major that
 * writes it. Keeping them adjacent is the only place a reader sees they are one
 * constraint rather than two, and moving one without the other is the mistake
 * both exist to catch.
 *
 * Why the pin needs a gate of its own: the format assertion catches the
 * *symptom*, a lockfile the image cannot read. It does not catch the cause, and
 * it cannot catch it in both directions — pnpm 9 writes lockfileVersion 9.0, so
 * a downgrade to the 9 line passes the format check while dev and CI resolve on
 * a version the deploy container does not run. That is the drift #52 was
 * actually about.
 *
 * A list rather than a hardcoded major, because that is how the transition gets
 * made: when Cloudflare moves the image to pnpm 11 there is a window where both
 * are fine, `['10', '11']` says so in one line, and narrowing back to `['11']`
 * is the deliberate second step.
 *
 * Verified 2026-07-24: the Workers Builds v3 image ships pnpm 10.11.1, and the
 * only override is a `PNPM_VERSION` build variable set in the Cloudflare
 * dashboard — which a site owner clicking Deploy cannot set.
 * Source: https://developers.cloudflare.com/workers/ci-cd/builds/build-image/
 *
 * Enforced by test/node/lockfile-guard.test.ts.
 */
export const SUPPORTED_PNPM_MAJORS = ['10']

// `lockfileVersion: '9.0'` — pnpm quotes it, but bare YAML scalars are valid too.
const LOCKFILE_VERSION = /^lockfileVersion:\s*['"]?([0-9]+(?:\.[0-9]+)*)['"]?\s*$/m

// Deliberately unanchored at the end: `corepack use pnpm` appends an integrity
// hash, as `pnpm@10.34.5+sha512.<hash>`, and that pin is exact and correct.
const PNPM_PIN = /^pnpm@(\d+)\.\d+\.\d+/

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Reads `package.json`'s `packageManager`, keeping "the file did not parse" and
 * "the field is not there" as two different answers rather than one `null` (#75).
 *
 * `unreadable` is the failure text when the file could not be read, parsed, or
 * indexed for the field, and `null` otherwise — so the caller can tell an
 * unanswerable question from an answer of "no field", and say which.
 *
 * The top-level type check is the third route to the same misdiagnosis, and the
 * one `JSON.parse` does not raise for us: reading `.packageManager` off a string
 * or a number yields `undefined`, which would make a structurally broken file
 * look like a repository that merely forgot the field.
 *
 * @param {string} cwd
 * @returns {Promise<{ declared: string | null, unreadable: string | null }>}
 */
async function readDeclaredPackageManager(cwd) {
  let contents
  try {
    contents = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
  } catch (error) {
    return { declared: null, unreadable: error instanceof Error ? error.message : String(error) }
  }

  if (typeof contents !== 'object' || contents === null || Array.isArray(contents)) {
    const kind = contents === null ? 'null' : Array.isArray(contents) ? 'an array' : typeof contents
    return { declared: null, unreadable: `its top level is ${kind}, not an object` }
  }

  return { declared: contents.packageManager ?? null, unreadable: null }
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
  // lockfile has to stay readable by it. That last part is asserted below
  // against SUPPORTED_PNPM_MAJORS, not merely described here.
  // Source: https://developers.cloudflare.com/workers/ci-cd/builds/build-image/
  //
  // `unreadable` is a state of its own rather than `declared = null`, and that is
  // #75. Collapsed onto the same sentinel, a file that did not parse was
  // indistinguishable from one that parsed and simply has no `packageManager`, so
  // the chain below added a second, unfounded violation saying the field was
  // absent — which is *unknown*, not false, and the count then reported one
  // problem as two. Somebody hits this after a bad merge conflict, reads "has no
  // `packageManager` field", and goes looking for a field that is sitting right
  // there. A guard that misdescribes what it caught is worse than one that says
  // less, so nothing about the pin is claimed from a file that did not parse.
  //
  // The chain is one `else if` ladder for the same reason: the four states are
  // mutually exclusive, and exactly one of them is reported.
  // Enforced by test/node/lockfile-guard.test.ts.
  const { declared, unreadable } = await readDeclaredPackageManager(cwd)
  const pin = declared === null ? null : PNPM_PIN.exec(declared)

  if (unreadable !== null) {
    violations.push({
      status: 'unreadable-package-json',
      message:
        `package.json could not be read, so whether it pins a pnpm version is unknown rather ` +
        `than absent — fix the file itself before reading anything else here. The failure was: ` +
        `${unreadable}`,
    })
  } else if (declared === null) {
    violations.push({
      status: 'no-package-manager',
      message:
        'package.json has no `packageManager` field — nothing pins the pnpm version for ' +
        'contributors or CI, which is the drift #52 was caused by',
    })
  } else if (pin === null) {
    violations.push({
      status: 'wrong-package-manager',
      message: `package.json declares packageManager '${declared}' — it must pin an exact pnpm version, as \`pnpm@x.y.z\``,
    })
  } else if (!SUPPORTED_PNPM_MAJORS.includes(pin[1])) {
    violations.push({
      status: 'unsupported-pnpm-major',
      message:
        `package.json pins packageManager '${declared}', and the Cloudflare build image runs pnpm ` +
        `${SUPPORTED_PNPM_MAJORS.map((one) => `${one}.x`).join(', ')}. A different major resolves ` +
        `differently and writes a different lockfileVersion, and pnpm does not fail on a lockfile ` +
        `it cannot read — it warns and resolves fresh, so a one-click deploy would install a tree ` +
        `nobody locked. The number to raise is not this one: confirm what the build image ships ` +
        `(https://developers.cloudflare.com/workers/ci-cd/builds/build-image/), then move ` +
        `SUPPORTED_PNPM_MAJORS and SUPPORTED_LOCKFILE_VERSIONS together. A deployer's only lever ` +
        `is a PNPM_VERSION dashboard variable, which a one-click deploy never sets.`,
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
    `[ok] pnpm is the only lockfile here, its version is pinned to a major the Cloudflare build ` +
      `image runs (${SUPPORTED_PNPM_MAJORS.map((one) => `${one}.x`).join(', ')}), and its format ` +
      `is one that image reads (${SUPPORTED_LOCKFILE_VERSIONS.join(', ')})`,
  )
}
