// Why `pnpm types` and `pnpm types:check` both carry `--env-file` (#132).
//
// `wrangler types` folds the keys of a local `.dev.vars` into the generated `Env`,
// and `--check` regenerates in memory to compare. So a developer with local secrets
// — which the dashboard *requires*, because `.dev.vars` is the only way to give
// `wrangler dev` a `CHARCHA_DASHBOARD_PASSWORD` — met two failures, and the second
// is the dangerous one:
//
//   1. `pnpm types:check` failed, saying the committed types were out of date when
//      nothing about them was.
//   2. The obvious reaction, `pnpm types`, wrote their own local secret name into
//      `src/worker-configuration.d.ts` as though it were part of the binding
//      contract — and that file is committed.
//
// Both were reproduced against wrangler 4.114.0 and both stop with
// `--env-file /dev/null`, which points type generation at a file that exists and
// holds nothing. It has to be on **both** scripts: on `types:check` alone the
// generated file still absorbs local secrets, and on `types` alone the check still
// false-fails. This file asserts that pairing, because they are one fix in two
// places and dropping either half restores half the bug.
//
// The second test is the artifact-level half: whatever the scripts say, the file
// that is actually committed must not name a secret. That is the outcome #132
// warned about, checked on the thing itself rather than on the command that made it.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declaredSecrets } from '../../scripts/deploy-config.mjs'

const repoRoot = join(import.meta.dirname, '..', '..')

/** `--env-file <path>` or `--env-file=<path>`, whichever form the script uses. */
const ENV_FILE = /--env-file[=\s]+(\S+)/

async function scripts(): Promise<Record<string, string>> {
  const manifest: unknown = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  const found = (manifest as { scripts?: Record<string, string> }).scripts
  return found ?? {}
}

describe('the type-generation scripts', () => {
  it('both point wrangler at an env file, so a local .dev.vars cannot reach the types', async () => {
    const { types, 'types:check': check } = await scripts()

    const generating = ENV_FILE.exec(types ?? '')
    const checking = ENV_FILE.exec(check ?? '')

    expect(generating, '`types` must pass --env-file').not.toBeNull()
    expect(checking, '`types:check` must pass --env-file').not.toBeNull()
    // The same file, or the two disagree about what the contract is and the check
    // fails against types it asked for itself.
    expect(checking?.[1]).toBe(generating?.[1])
  })
})

describe('the committed binding types', () => {
  it('name no secret, so nobody’s local .dev.vars has been generated into the contract', async () => {
    const generated = await readFile(join(repoRoot, 'src', 'worker-configuration.d.ts'), 'utf8')
    const secrets = await declaredSecrets(repoRoot)

    // A guard that found nothing to look for would pass silently, and this project's
    // secrets all live in `declare global` blocks under src/.
    expect(secrets.length).toBeGreaterThan(0)

    for (const secret of secrets) expect(generated).not.toContain(secret.name)
  })
})
