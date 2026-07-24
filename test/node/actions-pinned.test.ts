import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkWorkflows, findUses, inspectUse } from '../../scripts/actions-pinned.mjs'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'charcha-actions-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1'

async function writeWorkflow(name: string, source: string) {
  await mkdir(join(cwd, '.github/workflows'), { recursive: true })
  await writeFile(join(cwd, '.github/workflows', name), source)
}

const workflow = (steps: string) => `name: CI
on: [push]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
${steps}
`

describe('findUses', () => {
  it('finds uses steps in list, quoted and bare forms', () => {
    const found = findUses(
      [
        '      - uses: actions/checkout@v7',
        "      - uses: 'actions/setup-node@v7'",
        '        uses: "actions/cache@v4"',
      ].join('\n'),
    )

    expect(found.map((use) => use.ref)).toEqual([
      'actions/checkout@v7',
      'actions/setup-node@v7',
      'actions/cache@v4',
    ])
    expect(found.map((use) => use.line)).toEqual([1, 2, 3])
  })

  it('captures the trailing comment separately from the ref', () => {
    const [use] = findUses(`      - uses: actions/checkout@${SHA} # v7.0.1`)

    expect(use?.ref).toBe(`actions/checkout@${SHA}`)
    expect(use?.trailing).toBe('# v7.0.1')
  })
})

describe('inspectUse', () => {
  const use = (ref: string, trailing = '') => ({ line: 1, ref, trailing })

  it('accepts a full SHA pin carrying a version comment', () => {
    expect(inspectUse(use(`actions/checkout@${SHA}`, '# v7.0.1'), 'ci.yml')).toBeNull()
  })

  it('rejects a major tag', () => {
    expect(inspectUse(use('actions/checkout@v7'), 'ci.yml')).toMatchObject({ status: 'unpinned' })
  })

  it('rejects an exact semver tag, which is still mutable', () => {
    expect(inspectUse(use('actions/checkout@v7.0.1'), 'ci.yml')).toMatchObject({
      status: 'unpinned',
    })
  })

  it('rejects a branch name and a bare ref with no version', () => {
    expect(inspectUse(use('actions/checkout@main'), 'ci.yml')).toMatchObject({ status: 'unpinned' })
    expect(inspectUse(use('actions/checkout'), 'ci.yml')).toMatchObject({ status: 'unpinned' })
  })

  it('rejects a truncated SHA, which can be made to collide', () => {
    expect(
      inspectUse(use(`actions/checkout@${SHA.slice(0, 12)}`, '# v7.0.1'), 'ci.yml'),
    ).toMatchObject({ status: 'unpinned' })
  })

  it('rejects a SHA pin with no version comment', () => {
    expect(inspectUse(use(`actions/checkout@${SHA}`), 'ci.yml')).toMatchObject({
      status: 'no-version-comment',
    })
  })

  it('exempts a local action, which is this repository’s own reviewed code', () => {
    expect(inspectUse(use('./.github/actions/setup'), 'ci.yml')).toBeNull()
  })

  it('requires a digest on a docker image reference', () => {
    expect(inspectUse(use('docker://alpine:3.20'), 'ci.yml')).toMatchObject({
      status: 'unpinned-image',
    })
    expect(inspectUse(use('docker://alpine@sha256:' + 'a'.repeat(64)), 'ci.yml')).toBeNull()
  })

  it('accepts a SHA-pinned action living in a subdirectory', () => {
    expect(inspectUse(use(`owner/repo/sub/action@${SHA}`, '# v1.2.3'), 'ci.yml')).toBeNull()
  })
})

describe('checkWorkflows', () => {
  it('passes a workflow whose actions are all SHA-pinned and commented', async () => {
    await writeWorkflow(
      'ci.yml',
      workflow(`      - uses: actions/checkout@${SHA} # v7.0.1\n      - run: npm ci`),
    )

    const result = await checkWorkflows({ cwd })

    expect(result.ok).toBe(true)
    expect(result.checked).toBe(1)
    expect(result.files).toEqual(['.github/workflows/ci.yml'])
  })

  it('fails a workflow that reintroduces a tag', async () => {
    await writeWorkflow('ci.yml', workflow('      - uses: actions/checkout@v7'))

    const result = await checkWorkflows({ cwd })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'unpinned' })
    // The template puts the first step on line 7; the report must name it.
    expect(result.violations[0]?.message).toContain('.github/workflows/ci.yml:7')
  })

  it('reports every offending workflow file, not just the first', async () => {
    await writeWorkflow('ci.yml', workflow('      - uses: actions/checkout@v7'))
    await writeWorkflow('release.yml', workflow('      - uses: actions/setup-node@v7'))

    const result = await checkWorkflows({ cwd })

    expect(result.ok).toBe(false)
    expect(result.violations).toHaveLength(2)
    expect(result.files).toEqual(['.github/workflows/ci.yml', '.github/workflows/release.yml'])
  })

  it('scans a local composite action, which a workflow reference alone would hide', async () => {
    // The workflow only says `uses: ./.github/actions/setup`, which is exempt
    // as a reference. The tag it smuggles lives in the action definition.
    await writeWorkflow('ci.yml', workflow('      - uses: ./.github/actions/setup'))
    await mkdir(join(cwd, '.github/actions/setup'), { recursive: true })
    await writeFile(
      join(cwd, '.github/actions/setup/action.yml'),
      'name: setup\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v7\n',
    )

    const result = await checkWorkflows({ cwd })

    expect(result.ok).toBe(false)
    expect(result.checked).toBe(2)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]?.message).toContain('.github/actions/setup/action.yml:5')
  })

  it('accepts a composite action whose own steps are SHA-pinned', async () => {
    await writeWorkflow('ci.yml', workflow('      - uses: ./.github/actions/setup'))
    await mkdir(join(cwd, '.github/actions/setup'), { recursive: true })
    await writeFile(
      join(cwd, '.github/actions/setup/action.yml'),
      `name: setup\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-node@${SHA} # v7.0.0\n`,
    )

    const result = await checkWorkflows({ cwd })

    expect(result.ok).toBe(true)
    expect(result.checked).toBe(2)
  })

  it('fails when the workflow directory is missing, rather than passing vacuously', async () => {
    const result = await checkWorkflows({ cwd })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'no-workflow-dir' })
  })

  it('fails when the directory holds no workflow files', async () => {
    await mkdir(join(cwd, '.github/workflows'), { recursive: true })
    await writeFile(join(cwd, '.github/workflows/README.md'), 'not a workflow\n')

    const result = await checkWorkflows({ cwd })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'no-workflows' })
  })

  it('fails when the workflows reference no actions, so the regex silently matching nothing is visible', async () => {
    await writeWorkflow('ci.yml', workflow('      - run: npm ci'))

    const result = await checkWorkflows({ cwd })

    expect(result.ok).toBe(false)
    expect(result.violations[0]).toMatchObject({ status: 'no-uses' })
  })
})

describe('this repository', () => {
  it('has every action in its own workflows SHA-pinned', async () => {
    const result = await checkWorkflows({ cwd: process.cwd() })

    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.checked).toBeGreaterThan(0)
  })
})
