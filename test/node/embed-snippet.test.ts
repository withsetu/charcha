// The embed snippet exists in two places that cannot import each other: the README,
// which is prose, and the status page at `/` (#140), which fills the deployment's own
// origin into it. Two copies of an integration snippet is exactly the failure #140
// names — "a snippet that differs from the documented one is worse than none" — and
// nothing in a type system or a Worker test can see the README.
//
// So this is the join. It runs in the node project because it reads the filesystem.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { embedSnippet } from '../../src/root/page'

// Through `fileURLToPath` rather than handing `readFileSync` a `URL`: this project is
// in both the Workers and the Node type worlds, and their `URL` types are structurally
// different, so the URL overload does not typecheck here.
const README = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../README.md'),
  'utf8',
)

/** The origin the README's example uses, which is the only part that differs. */
const README_ORIGIN = 'https://your-worker.example.workers.dev'

describe('the snippet on the status page and the snippet in the README', () => {
  it('are the same snippet', () => {
    expect(README).toContain(embedSnippet(README_ORIGIN))
  })

  it('is the only integration snippet the README shows, so there is nothing else to drift from', () => {
    const scriptTags = README.match(/<script src="[^"]*embed\.js"[^>]*>/g) ?? []

    expect(scriptTags).toHaveLength(1)
  })
})
