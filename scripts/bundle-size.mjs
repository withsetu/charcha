// The embed ships on other people's sites, so its size is a hard budget rather
// than a target (see CLAUDE.md). This weighs each budgeted bundle the way a
// browser receives it: bundled, minified, gzipped.
//
// The budget below points at source that issue #5 has not written yet. Rather
// than pass quietly until then — a green check that enforces nothing reads
// exactly like a green check that does — the entry is only excused while its
// whole directory is absent. The first file added under `src/embed/` turns the
// check on, and a missing entry point is a failure from that moment.
//
// Enforced by test/node/bundle-size.test.ts.

import { build } from 'esbuild'
import { access } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

export const BUDGETS = [
  {
    name: 'embed',
    dir: 'src/embed',
    entry: 'src/embed/index.ts',
    maxGzipBytes: 10 * 1024,
  },
]

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function gzippedBundleSize(entryPath) {
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  })

  const output = result.outputFiles[0]
  // Level 9: the most favourable gzip a CDN would ever produce, so the budget is
  // never met by measuring more weakly than the network does.
  return gzipSync(output.contents, { level: 9 }).byteLength
}

/**
 * @param {{ cwd?: string, budgets?: typeof BUDGETS }} options
 * @returns {Promise<{ ok: boolean, results: Array<{ name: string, status: string, gzipBytes: number | null, maxGzipBytes: number, message: string }> }>}
 */
export async function checkBudgets({ cwd = process.cwd(), budgets = BUDGETS } = {}) {
  const results = []

  for (const budget of budgets) {
    const entryPath = join(cwd, budget.entry)
    const dirPath = join(cwd, budget.dir)

    if (!(await exists(entryPath))) {
      if (await exists(dirPath)) {
        results.push({
          name: budget.name,
          status: 'missing-entry',
          gzipBytes: null,
          maxGzipBytes: budget.maxGzipBytes,
          message: `${budget.dir} exists but ${budget.entry} does not — the budget cannot be measured`,
        })
      } else {
        results.push({
          name: budget.name,
          status: 'not-written-yet',
          gzipBytes: null,
          maxGzipBytes: budget.maxGzipBytes,
          message: `nothing to weigh: ${budget.dir} does not exist yet, so this budget is not being enforced`,
        })
      }
      continue
    }

    let gzipBytes
    try {
      gzipBytes = await gzippedBundleSize(entryPath)
    } catch (error) {
      results.push({
        name: budget.name,
        status: 'build-failed',
        gzipBytes: null,
        maxGzipBytes: budget.maxGzipBytes,
        message: `could not bundle ${budget.entry}: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }

    const withinBudget = gzipBytes <= budget.maxGzipBytes
    results.push({
      name: budget.name,
      status: withinBudget ? 'within-budget' : 'over-budget',
      gzipBytes,
      maxGzipBytes: budget.maxGzipBytes,
      message: `${budget.entry} is ${gzipBytes} B gzipped of ${budget.maxGzipBytes} B allowed`,
    })
  }

  const failed = new Set(['missing-entry', 'over-budget', 'build-failed'])
  return { ok: results.every((result) => !failed.has(result.status)), results }
}

const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (isCli) {
  const { ok, results } = await checkBudgets()

  for (const result of results) {
    const mark = result.status === 'within-budget' ? 'ok' : result.status
    console.log(`[${mark}] ${result.name}: ${result.message}`)
  }

  if (!ok) {
    console.error('\nbundle-size: budget check failed')
    process.exit(1)
  }
}
