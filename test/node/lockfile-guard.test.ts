import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkLockfiles } from '../../scripts/lockfile-guard.mjs'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'charcha-lockfile-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const write = (name: string, contents = '') => writeFile(join(cwd, name), contents)

/** The shape this guard is meant to accept. */
async function writeHealthyRepo() {
  await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
  await write('package.json', JSON.stringify({ name: 'charcha', packageManager: 'pnpm@10.34.5' }))
}

const statuses = (result: { violations: Array<{ status: string }> }) =>
  result.violations.map((violation) => violation.status)

describe('checkLockfiles', () => {
  it('passes a repository with only a pnpm lockfile and a pinned pnpm version', async () => {
    await writeHealthyRepo()

    const result = await checkLockfiles({ cwd })

    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('fails when a stray npm lockfile is present', async () => {
    // The whole point of the guard: `npm install` recreates this file, and the
    // resulting tree omits foreign-platform optionals that Linux CI needs.
    await writeHealthyRepo()
    await write('package-lock.json', '{}')

    const result = await checkLockfiles({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toEqual(['foreign-lockfile'])
    expect(result.violations[0]?.message).toContain('package-lock.json')
  })

  it('fails on a shrinkwrap, a yarn lockfile and a bun lockfile too', async () => {
    await writeHealthyRepo()
    await write('npm-shrinkwrap.json', '{}')
    await write('yarn.lock', '')
    await write('bun.lock', '')

    const result = await checkLockfiles({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toEqual(['foreign-lockfile', 'foreign-lockfile', 'foreign-lockfile'])
  })

  it('fails when the pnpm lockfile is missing, so an unpinned tree is not a pass', async () => {
    await write('package.json', JSON.stringify({ packageManager: 'pnpm@10.34.5' }))

    const result = await checkLockfiles({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toContain('missing-lockfile')
  })

  it('fails when nothing pins the pnpm version', async () => {
    // Unpinned tooling is one of the two causes named on #52: dev and CI
    // resolving with different pnpm versions is its own source of lockfile
    // churn, independent of npm's platform pruning.
    await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
    await write('package.json', JSON.stringify({ name: 'charcha' }))

    const result = await checkLockfiles({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toEqual(['no-package-manager'])
  })

  it('fails a packageManager field naming another package manager', async () => {
    await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
    await write('package.json', JSON.stringify({ packageManager: 'npm@11.6.2' }))

    const result = await checkLockfiles({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toEqual(['wrong-package-manager'])
  })

  it('fails a pnpm pin that is a range rather than an exact version', async () => {
    await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
    await write('package.json', JSON.stringify({ packageManager: 'pnpm@10' }))

    const result = await checkLockfiles({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toEqual(['wrong-package-manager'])
  })

  it('fails an unreadable package.json instead of treating it as unpinned', async () => {
    await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
    await write('package.json', '{ not json')

    const result = await checkLockfiles({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toContain('unreadable-package-json')
  })
})
