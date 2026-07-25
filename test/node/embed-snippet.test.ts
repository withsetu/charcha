// The integration snippet exists in two places that cannot import each other, and this
// is the join between them.
//
// It used to join three: the README, docs/theming.md, and `embedSnippet` in
// src/root/page.ts, which printed the snippet on the status page at `/` with the
// deployment's own origin filled in. #145 removed that page's copy — a public,
// unauthenticated address should not hand a stranger the integration surface — and with
// it the only copy a type system could see.
//
// **That is exactly the point at which this test could have quietly stopped testing
// anything**, which is why it was rewritten rather than deleted. The hazard #140 named
// — "a snippet that differs from the documented one is worse than none" — did not go
// away with the third copy; two prose copies drift from each other just as happily, and
// this test never watched that pair at all. It does now.
//
// Every assertion below compares a page against SNIPPET rather than against the other
// page. Comparing the two extractions to each other reads as the stronger test and is
// the weaker one: with the snippet missing from both files, both sides are `undefined`
// and the equality passes. A literal cannot go absent.
//
// It runs in the node project because it reads the filesystem.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Through `fileURLToPath` rather than handing `readFileSync` a `URL`: this project is
// in both the Workers and the Node type worlds, and their `URL` types are structurally
// different, so the URL overload does not typecheck here.
const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

/**
 * The snippet, written out once so that changing the contract means changing it here,
 * in front of the reason for it, rather than by editing two markdown files that agree.
 *
 * The example origin is the only part a deployer replaces.
 */
const SNIPPET =
  '<div id="charcha"></div>\n' +
  '<script src="https://your-worker.example.workers.dev/embed.js" defer></script>'

const PAGES = ['README.md', 'docs/theming.md'] as const

/**
 * Every copy of the snippet in one document.
 *
 * Deliberately loose about the address and tight about everything else: `id="charcha"`
 * and the script's `defer` are the contract, and the origin is what varies.
 */
function snippetsIn(markdown: string): string[] {
  return markdown.match(/<div id="charcha"><\/div>\n<script src="[^"]+" defer><\/script>/g) ?? []
}

describe('the integration snippet, everywhere it is written down', () => {
  it.each(PAGES)('appears in %s exactly once, and exactly as written here', (page) => {
    // One assertion covering presence, wording and uniqueness: a page that lost the
    // snippet, reworded it, or grew a second copy all land here. A second copy matters
    // because it is a second thing to keep in step with nothing watching it.
    expect(snippetsIn(read(page))).toEqual([SNIPPET])
  })

  it.each(PAGES)('shows no other script tag to paste in %s', (page) => {
    const scriptTags = read(page).match(/<script src="[^"]*embed\.js"[^>]*>/g) ?? []

    expect(scriptTags).toHaveLength(1)
  })

  // The other half of the contract, and the half no test held after #145 removed
  // `embedSnippet`: the snippet names a mount element, and something has to still look
  // for it. `src/embed/index.ts` is the entry point that runs on a reader's page, and
  // test/dom exercises `mount` directly rather than through it — so renaming this
  // selector would leave both prose copies documenting a snippet that mounts nothing,
  // with every other test green.
  it('names a mount element the embed still looks for', () => {
    expect(read('src/embed/index.ts')).toContain("'#charcha,[data-charcha]'")
  })
})
