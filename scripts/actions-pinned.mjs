// A workflow step runs arbitrary code from someone else's repository with this
// repository's token. `actions/checkout@v7` resolves that code at run time, and
// a tag can be re-pointed by anyone who gains write access to the action —
// GitHub's own guidance is that "pinning an action to a full-length commit SHA
// is currently the only way to use an action as an immutable release".
// Source: https://docs.github.com/en/actions/reference/security/secure-use
//
// Pinning is a one-time edit; *staying* pinned is not. Dependabot bumps the
// SHAs (and the trailing version comment with them — see .github/dependabot.yml)
// but nothing stops the next workflow edit from reintroducing a bare tag. This
// check is what makes the pin an invariant rather than a habit.
//
// The trailing `# vX.Y.Z` comment is required, not decorative: it is what makes
// the pin readable in review, and Dependabot keys its comment updates off it.
//
// This check reads the *shape* of a pin and nothing else. It runs offline, in
// `pnpm check`, and so cannot tell whether a well-formed SHA was ever published
// by the action's own repository — which is a real gap, because GitHub's
// guidance is that "when selecting a SHA, you should verify it is from the
// action's repository and not a repository fork"
// (https://docs.github.com/en/actions/reference/security/secure-use). That half
// needs the network, so it lives in scripts/actions-upstream.mjs and runs as its
// own CI job rather than in `pnpm check`. Neither script is complete alone.
//
// Enforced by test/node/actions-pinned.test.ts.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const WORKFLOW_DIR = '.github/workflows'
const ACTIONS_DIR = '.github/actions'

// `uses:` as a YAML key, with an optional list dash and optional quoting, plus
// whatever trails it on the line so the version comment can be inspected.
const USES_LINE = /^\s*(?:-\s*)?uses\s*:\s*(?:'([^']*)'|"([^"]*)"|([^\s#]+))\s*(.*)$/

const FULL_SHA = /^[0-9a-f]{40}$/
const VERSION_COMMENT = /^#\s*\S/

/**
 * @param {string} source a workflow file's contents
 * @returns {Array<{ line: number, ref: string, trailing: string }>}
 */
export function findUses(source) {
  const found = []
  source.split(/\r?\n/).forEach((text, index) => {
    const match = USES_LINE.exec(text)
    if (match === null) return
    const ref = match[1] ?? match[2] ?? match[3] ?? ''
    found.push({ line: index + 1, ref, trailing: (match[4] ?? '').trim() })
  })
  return found
}

/**
 * @param {{ line: number, ref: string, trailing: string }} use
 * @param {string} file
 * @returns {{ status: string, message: string } | null} null when the use is fine
 */
export function inspectUse(use, file) {
  const at = `${file}:${use.line}`
  const { ref, trailing } = use

  // A local action is this repository's own code, already covered by review.
  if (ref.startsWith('./')) return null

  if (ref.startsWith('docker://')) {
    return ref.includes('@sha256:')
      ? null
      : {
          status: 'unpinned-image',
          message: `${at}: '${ref}' is a mutable image tag — pin it to an @sha256: digest`,
        }
  }

  const separator = ref.lastIndexOf('@')
  if (separator === -1) {
    return {
      status: 'unpinned',
      message: `${at}: '${ref}' has no version at all — pin it to a full commit SHA`,
    }
  }

  const version = ref.slice(separator + 1)
  if (!FULL_SHA.test(version)) {
    return {
      status: 'unpinned',
      message: `${at}: '${ref}' is pinned to the mutable ref '${version}' — a tag can be re-pointed; pin the full 40-character commit SHA`,
    }
  }

  if (!VERSION_COMMENT.test(trailing)) {
    return {
      status: 'no-version-comment',
      message: `${at}: '${ref}' is SHA-pinned but has no trailing '# vX.Y.Z' comment — the pin is unreadable in review and Dependabot keys its comment updates off it`,
    }
  }

  return null
}

/**
 * Every `action.yml` / `action.yaml` beneath `.github/actions`, at any depth,
 * as paths relative to `cwd`. Absent directory means an empty list — composite
 * actions are optional, unlike workflows.
 *
 * @param {string} cwd
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function findActionDefinitions(cwd, dir) {
  let entries
  try {
    entries = await readdir(join(cwd, dir), { withFileTypes: true })
  } catch {
    return []
  }

  const found = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...(await findActionDefinitions(cwd, path)))
    } else if (entry.name === 'action.yml' || entry.name === 'action.yaml') {
      found.push(path)
    }
  }
  return found
}

/**
 * Every `uses:` step this repository is answerable for, across its workflows and
 * its own composite action definitions, in file order.
 *
 * Shared with scripts/actions-upstream.mjs, which resolves the same pins against
 * the GitHub API. Two checkers disagreeing about *which* references exist would
 * be a hole in whichever of them looked at less, so they read one list.
 *
 * `problems` is non-empty only when there was nothing legitimate to read at all;
 * both callers treat that as a failure rather than as an empty pass.
 *
 * @param {{ cwd?: string, dir?: string }} options
 * @returns {Promise<{ files: string[], uses: Array<{ file: string, line: number, ref: string, trailing: string }>, problems: Array<{ status: string, message: string }> }>}
 */
export async function collectUses({ cwd = process.cwd(), dir = WORKFLOW_DIR } = {}) {
  let names
  try {
    names = await readdir(join(cwd, dir))
  } catch {
    names = null
  }

  // No workflows at all is a failure rather than a quiet pass: this repository
  // has CI, so a checker that finds nothing to check is broken, not satisfied.
  if (names === null) {
    return {
      files: [],
      uses: [],
      problems: [
        { status: 'no-workflow-dir', message: `${dir} does not exist — nothing was checked` },
      ],
    }
  }

  const workflows = names.filter((name) => name.endsWith('.yml') || name.endsWith('.yaml')).sort()

  if (workflows.length === 0) {
    return {
      files: [],
      uses: [],
      problems: [
        {
          status: 'no-workflows',
          message: `${dir} contains no workflow files — nothing was checked`,
        },
      ],
    }
  }

  // Local composite actions are exempt as *references* — they are this
  // repository's own reviewed code — but their definitions get scanned, because
  // an `action.yml` can call a third-party action by tag and a workflow that
  // only says `uses: ./.github/actions/setup` would otherwise hide it
  // completely. Exempting the reference without reading the definition is a
  // hole, not a shortcut.
  const files = [
    ...workflows.map((name) => `${dir}/${name}`),
    ...(await findActionDefinitions(cwd, ACTIONS_DIR)),
  ]

  const uses = []
  for (const file of files) {
    const source = await readFile(join(cwd, file), 'utf8')
    for (const use of findUses(source)) uses.push({ file, ...use })
  }

  return { files, uses, problems: [] }
}

/**
 * @param {{ cwd?: string, dir?: string }} options
 * @returns {Promise<{ ok: boolean, checked: number, files: string[], violations: Array<{ status: string, message: string }> }>}
 */
export async function checkWorkflows({ cwd = process.cwd(), dir = WORKFLOW_DIR } = {}) {
  const { files, uses, problems } = await collectUses({ cwd, dir })

  if (problems.length > 0) {
    return { ok: false, checked: 0, files: [], violations: problems }
  }

  const violations = []
  let checked = 0

  for (const use of uses) {
    checked += 1
    const violation = inspectUse(use, use.file)
    if (violation !== null) violations.push(violation)
  }

  // Workflow files that reference no actions at all would also pass vacuously.
  if (checked === 0) {
    violations.push({
      status: 'no-uses',
      message: `no 'uses:' steps found in ${files.length} workflow file(s) — the check matched nothing`,
    })
  }

  return { ok: violations.length === 0, checked, files, violations }
}

const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (isCli) {
  const { ok, checked, files, violations } = await checkWorkflows()

  console.log(
    `[actions] checked ${checked} 'uses:' step(s) across ${files.length} workflow file(s)`,
  )

  for (const violation of violations) {
    console.log(`[${violation.status}] ${violation.message}`)
  }

  if (!ok) {
    console.error(
      `\nactions-pinned: ${violations.length} unpinned or undocumented action reference(s).` +
        '\nUse owner/repo@<40-char-sha> # vX.Y.Z — see scripts/actions-pinned.mjs.',
    )
    process.exit(1)
  }

  console.log('[ok] every action reference is pinned to a full commit SHA')
}
