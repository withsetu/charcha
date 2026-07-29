// The dashboard password's length floor is written down twice, and this is what keeps
// the two copies the same number (#120).
//
// `MIN_DASHBOARD_PASSWORD_LENGTH` is decided in src/admin/password.ts, which is where the
// Worker decides whether to report a password as short. The Setup tab has to say the same
// number to the owner — and it cannot import it, because the dashboard is a separate
// TypeScript project that does not have `Env` or Hono in it, the same reason
// `SETUP_SECRETS` is restated in src/dashboard/api.ts.
//
// **The failure this exists for is the quiet one.** Raise the floor to 16 in the Worker
// and every worker-side test either passes or fails visibly at the pin — while the
// dashboard goes on telling an owner their password must be at least 15 characters, on
// the one screen they opened to find out. That is a comment-that-suppresses-the-check
// (#107) wearing UI copy, and nothing else in the suite would notice: the dashboard tests
// stub the endpoint, so they never see the Worker's number at all.
//
// A node test rather than a worker one because it reads two files off disk, and reads
// rather than imports because importing the .tsx would need the dashboard's JSX config
// inside this project. Both patterns follow test/node/wrangler-types.test.ts.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(import.meta.dirname, '..', '..')

const DECLARATION = /MIN_DASHBOARD_PASSWORD_LENGTH\s*=\s*(\d+)/

/**
 * The number the named file declares the floor as.
 *
 * Fails loudly when the declaration is absent rather than returning a default: a rename
 * that this regex stopped matching would otherwise make the check pass by finding nothing
 * on both sides, which is the shape of guard that reads as coverage forever.
 */
async function declaredFloor(...path: string[]): Promise<number> {
  const source = await readFile(join(repoRoot, ...path), 'utf8')
  const found = DECLARATION.exec(source)

  expect(found, `${path.join('/')} declares no MIN_DASHBOARD_PASSWORD_LENGTH`).not.toBeNull()
  return Number(found?.[1])
}

describe('the dashboard password floor', () => {
  it('is the same number in the Worker and on the screen that tells the owner', async () => {
    const worker = await declaredFloor('src', 'admin', 'password.ts')
    const tab = await declaredFloor('src', 'dashboard', 'components', 'setup.tsx')

    expect(tab).toBe(worker)
  })

  it('is a real floor, so a copy that had been zeroed would not satisfy the check above', async () => {
    // Two identical zeroes agree with each other and enforce nothing. This is the
    // sanity assertion that makes the equality assertion mean something.
    expect(await declaredFloor('src', 'admin', 'password.ts')).toBeGreaterThan(0)
  })
})
