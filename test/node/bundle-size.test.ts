import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkBudgets } from '../../scripts/bundle-size.mjs'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'charcha-budget-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const budget = (maxGzipBytes: number) => [
  { name: 'embed', dir: 'src/embed', entry: 'src/embed/index.ts', maxGzipBytes },
]

async function writeEntry(source: string) {
  await mkdir(join(cwd, 'src/embed'), { recursive: true })
  await writeFile(join(cwd, 'src/embed/index.ts'), source)
}

function only<T>(results: T[]): T {
  expect(results).toHaveLength(1)
  const [first] = results
  if (first === undefined) throw new Error('expected exactly one budget result')
  return first
}

describe('checkBudgets', () => {
  it('passes a bundle that fits, and reports what it weighed', async () => {
    await writeEntry('export const mount = () => document.title\n')

    const result = await checkBudgets({ cwd, budgets: budget(10 * 1024) })

    expect(result.ok).toBe(true)
    expect(only(result.results).status).toBe('within-budget')
    expect(only(result.results).gzipBytes ?? 0).toBeGreaterThan(0)
  })

  it('fails a bundle that is over budget', async () => {
    await writeEntry(
      `export const payload = ${JSON.stringify(
        Array.from({ length: 4000 }, (_, i) => `phrase-number-${i}-of-many`),
      )}\n`,
    )

    const result = await checkBudgets({ cwd, budgets: budget(1024) })

    expect(result.ok).toBe(false)
    expect(only(result.results).status).toBe('over-budget')
    expect(only(result.results).gzipBytes ?? 0).toBeGreaterThan(1024)
  })

  it('fails when budgeted source exists but its entry point does not', async () => {
    await mkdir(join(cwd, 'src/embed'), { recursive: true })
    await writeFile(join(cwd, 'src/embed/somewhere-else.ts'), 'export const x = 1\n')

    const result = await checkBudgets({ cwd, budgets: budget(10 * 1024) })

    expect(result.ok).toBe(false)
    expect(only(result.results).status).toBe('missing-entry')
  })

  it('passes with an explicit notice while the budgeted source does not exist yet', async () => {
    const result = await checkBudgets({ cwd, budgets: budget(10 * 1024) })

    expect(result.ok).toBe(true)
    expect(only(result.results).status).toBe('not-written-yet')
    expect(only(result.results).message).toContain('src/embed')
  })

  it('fails a build error rather than reporting a size', async () => {
    await writeEntry('export const broken = (\n')

    const result = await checkBudgets({ cwd, budgets: budget(10 * 1024) })

    expect(result.ok).toBe(false)
    expect(only(result.results).status).toBe('build-failed')
  })
})
