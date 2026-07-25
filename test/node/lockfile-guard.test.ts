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

  // #75. `toEqual`, not `toContain`: the bug was a *second*, unfounded violation
  // riding along. A file that did not parse cannot be shown to lack
  // `packageManager` — that is unknown, not false — and reporting it as false
  // sends the reader hunting for a field that may be sitting right there, at the
  // moment they are already confused. One problem must also read as one problem,
  // because the CLI prints the count.
  describe('an unreadable package.json', () => {
    const malformed = '{ not json'

    it('is the only violation reported, rather than also being called unpinned', async () => {
      await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
      await write('package.json', malformed)

      const result = await checkLockfiles({ cwd })

      expect(result.ok).toBe(false)
      expect(statuses(result)).toEqual(['unreadable-package-json'])
    })

    it('says the pin is unknown rather than absent, and quotes the parse failure', async () => {
      await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
      await write('package.json', malformed)

      const [violation] = (await checkLockfiles({ cwd })).violations

      expect(violation?.message).toContain('package.json')
      expect(violation?.message).toMatch(/unknown/i)
      // The underlying reason, not just "something went wrong": this is the whole
      // reason the message is worth reading.
      expect(violation?.message).toMatch(/JSON/)
      expect(violation?.message).not.toMatch(/has no `packageManager` field/)
    })

    it('is diagnosed differently from a readable file that is genuinely unpinned', async () => {
      await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
      await write('package.json', malformed)
      const unreadable = await checkLockfiles({ cwd })

      await write('package.json', JSON.stringify({ name: 'charcha' }))
      const unpinned = await checkLockfiles({ cwd })

      expect(unreadable.ok).toBe(false)
      expect(unpinned.ok).toBe(false)
      // Disjoint, not merely unequal: the collapsed sentinel made the unreadable
      // case a superset of the unpinned one, which is "different" while still
      // telling the reader the wrong thing.
      expect(statuses(unreadable).filter((one) => statuses(unpinned).includes(one))).toEqual([])
      expect(unreadable.violations[0]?.message).not.toBe(unpinned.violations[0]?.message)
    })

    it('reports a package.json that parses but is not an object', async () => {
      // The same misdiagnosis by a third route, and the one route `JSON.parse`
      // does not catch for us: `"a string".packageManager` is simply `undefined`,
      // so a file whose top level is not an object would read as a repository
      // that merely forgot the field. It is not — nothing about the pin can be
      // established from it either.
      await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
      await write('package.json', '"not an object"')

      const result = await checkLockfiles({ cwd })

      expect(result.ok).toBe(false)
      expect(statuses(result)).toEqual(['unreadable-package-json'])
      expect(result.violations[0]?.message).toMatch(/object/)
    })

    it('reports a package.json that is not there at all, rather than passing it', async () => {
      // Same collapsed sentinel, reached by a different route: `readFile` throws
      // ENOENT and the catch is the same one. A repository with no package.json
      // is not an unpinned repository, it is a broken one.
      await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")

      const result = await checkLockfiles({ cwd })

      expect(result.ok).toBe(false)
      expect(statuses(result)).toEqual(['unreadable-package-json'])
    })
  })

  // The Cloudflare build image ships pnpm 10.11.1 and reads lockfileVersion
  // 9.0. On a lockfile it cannot read, pnpm *warns* and resolves fresh rather
  // than failing — so a one-click deploy would go green having installed a tree
  // nobody locked. Nothing else in this repository would notice.
  describe('lockfile format version', () => {
    it('accepts the version the Cloudflare build image reads', async () => {
      await writeHealthyRepo()

      expect((await checkLockfiles({ cwd })).ok).toBe(true)
    })

    it('accepts it unquoted, which is also valid YAML', async () => {
      await write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
      await write('package.json', JSON.stringify({ packageManager: 'pnpm@10.34.5' }))

      expect((await checkLockfiles({ cwd })).ok).toBe(true)
    })

    it('fails a newer lockfile format, which the deploy image would silently ignore', async () => {
      await write('pnpm-lock.yaml', "lockfileVersion: '10.0'\n")
      await write('package.json', JSON.stringify({ packageManager: 'pnpm@10.34.5' }))

      const result = await checkLockfiles({ cwd })

      expect(result.ok).toBe(false)
      expect(statuses(result)).toEqual(['unsupported-lockfile-version'])
      expect(result.violations[0]?.message).toContain('10.0')
    })

    // dependabot/dependabot-core#9684: Dependabot rewrote a 9.0 lockfile as 6.0.
    it('fails an older lockfile format, which is how a bot rewrite has regressed before', async () => {
      await write('pnpm-lock.yaml', "lockfileVersion: '6.0'\n")
      await write('package.json', JSON.stringify({ packageManager: 'pnpm@10.34.5' }))

      const result = await checkLockfiles({ cwd })

      expect(result.ok).toBe(false)
      expect(statuses(result)).toEqual(['unsupported-lockfile-version'])
    })

    it('fails a lockfile with no version at all rather than assuming one', async () => {
      await write('pnpm-lock.yaml', 'settings:\n  autoInstallPeers: true\n')
      await write('package.json', JSON.stringify({ packageManager: 'pnpm@10.34.5' }))

      const result = await checkLockfiles({ cwd })

      expect(result.ok).toBe(false)
      expect(statuses(result)).toEqual(['unreadable-lockfile-version'])
    })
  })

  // The lockfile-format assertion above catches the symptom — a lockfile the
  // build image cannot read. This catches the cause: `packageManager` moving off
  // the major the image actually runs. Both directions matter and, before #67,
  // only one was guarded.
  describe('pnpm major version', () => {
    // No plain "accepts pnpm 10" case here: `writeHealthyRepo` already pins
    // 10.34.5, so the suite's first test covers it. A second one would pass with
    // this guard deleted, which is the shape card rule 6 exists to keep out.
    it('accepts the corepack integrity hash that may follow the version', async () => {
      // `corepack use pnpm` writes `pnpm@10.34.5+sha512.<hash>`. The pin is
      // still exact and still on 10; rejecting it would fail a repository that
      // is correct.
      await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
      await write(
        'package.json',
        JSON.stringify({ packageManager: 'pnpm@10.34.5+sha512.abc123def456' }),
      )

      expect((await checkLockfiles({ cwd })).ok).toBe(true)
    })

    it('fails a newer major, which would write a lockfile the deploy image resolves past', async () => {
      await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
      await write('package.json', JSON.stringify({ packageManager: 'pnpm@11.0.0' }))

      const result = await checkLockfiles({ cwd })

      expect(result.ok).toBe(false)
      expect(statuses(result)).toEqual(['unsupported-pnpm-major'])
    })

    // pnpm 9 writes lockfileVersion 9.0, so the format assertion passes it. Dev
    // and CI would still be resolving on a version the deploy container does not
    // run, which is the drift #52 was about — a ceiling check would miss it.
    it('fails an older major, which the lockfile-format assertion alone would let through', async () => {
      await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
      await write('package.json', JSON.stringify({ packageManager: 'pnpm@9.15.9' }))

      const result = await checkLockfiles({ cwd })

      expect(result.ok).toBe(false)
      expect(statuses(result)).toEqual(['unsupported-pnpm-major'])
    })

    it('does not also report a shape violation, so one problem reads as one problem', async () => {
      await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
      await write('package.json', JSON.stringify({ packageManager: 'pnpm@11.0.0' }))

      expect(statuses(await checkLockfiles({ cwd }))).not.toContain('wrong-package-manager')
    })

    // #67: the next person to hit this gate must read it as "confirm what
    // Cloudflare ships, then move the constant", not "raise the number until CI
    // is green". That only happens if the message says where the truth lives.
    it('names the build image and the override, rather than just the wrong version', async () => {
      await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
      await write('package.json', JSON.stringify({ packageManager: 'pnpm@11.0.0' }))

      const [violation] = (await checkLockfiles({ cwd })).violations

      expect(violation?.message).toContain('11.0.0')
      expect(violation?.message).toContain('PNPM_VERSION')
      expect(violation?.message).toContain('developers.cloudflare.com')
    })
  })
})
