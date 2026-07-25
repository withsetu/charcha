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
// this test never watched that pair at all. It does now. If the remaining copies ever
// disagree, a deployer following one page and reading the other sees two different
// integrations.
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

const PAGES = {
  'README.md': read('README.md'),
  'docs/theming.md': read('docs/theming.md'),
}

/**
 * Every copy of the snippet in one document.
 *
 * Deliberately loose about the address and tight about everything else: the origin is
 * the one part a deployer replaces, and `id="charcha"` plus the script's `defer` are
 * the whole contract — src/embed/index.ts mounts into `#charcha,[data-charcha]`, and
 * src/embed/config.ts derives the API base from `document.currentScript.src` when no
 * `data-api` is given.
 */
function snippetsIn(markdown: string): string[] {
  return markdown.match(/<div id="charcha"><\/div>\n<script src="[^"]+" defer><\/script>/g) ?? []
}

describe('the integration snippet, everywhere it is written down', () => {
  it.each(Object.keys(PAGES))('appears exactly once in %s', (page) => {
    // Not a style rule: a second copy on the same page is a second thing to keep in
    // step, and nothing would be watching it.
    expect(snippetsIn(PAGES[page as keyof typeof PAGES])).toHaveLength(1)
  })

  it('is the same snippet in the README as in the theming guide', () => {
    const [readme] = snippetsIn(PAGES['README.md'])
    const [theming] = snippetsIn(PAGES['docs/theming.md'])

    expect(readme).toBe(theming)
  })

  it('is the mount element and a deferred script, and nothing else', () => {
    // Pinned literally so that a change to the contract has to be made here, in front
    // of the reason for it, rather than by editing two markdown files that agree.
    expect(snippetsIn(PAGES['README.md'])[0]).toBe(
      '<div id="charcha"></div>\n' +
        '<script src="https://your-worker.example.workers.dev/embed.js" defer></script>',
    )
  })

  it('is the only script tag either page tells anyone to paste', () => {
    for (const [page, markdown] of Object.entries(PAGES)) {
      const scriptTags = markdown.match(/<script src="[^"]*embed\.js"[^>]*>/g) ?? []

      expect(scriptTags, page).toHaveLength(1)
    }
  })
})
