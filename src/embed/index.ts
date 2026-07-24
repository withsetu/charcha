// The embed's entry point, and the file `pnpm check:size` weighs against the 10 KB
// gzipped budget (scripts/bundle-size.mjs, card rule 4).
//
// It ships as a **static asset**, not from a Worker route. Requests to static assets
// are free and unlimited and are not billed as Worker invocations
// (https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/,
// checked 2026-07-24), while the read of a page's comments is one billable request.
// Serving this file from the Worker would make every page view cost two requests
// instead of one and halve the site's free-tier ceiling from ~100k to ~50k page
// views a day. See wrangler.jsonc, and note that `run_worker_first` would undo it.
//
// **Nothing optional is imported here.** The relative-time upgrade agreed on #5 is a
// separate entry point precisely so that the budget this file is measured against
// stays the budget every reader on every site actually downloads. An `import` of it
// from this file is the budget being broken, and check:size is what notices.

import { readConfig } from './config'
import { mountConfigError, mountWidget } from './mount'

/**
 * Read at the top level, while it is still readable.
 *
 * `document.currentScript` is the script that is executing right now, and it is null
 * from any callback — so the deployment address has to be taken before the first
 * `await` or listener, not when it is eventually needed.
 */
const scriptSrc = (document.currentScript as HTMLScriptElement | null)?.src ?? null

/**
 * The elements a widget is mounted into.
 *
 * `#charcha` is the id the README's snippet uses, and `[data-charcha]` is for a page
 * that wants more than one — an id may only appear once, and a site with two
 * conversations on a page would otherwise have no way to ask for the second.
 */
function mountPoints(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#charcha,[data-charcha]'))
}

function start(): void {
  mountPoints().forEach((element, index) => {
    const result = readConfig((name) => element.getAttribute(name), scriptSrc)
    if (!result.ok) {
      // Said on the page, not only to the console: this is the site owner's own
      // failure and it happens the first time they paste the snippet, where a widget
      // that renders nothing is indistinguishable from one that has not loaded yet.
      mountConfigError(element, result.message)
      return
    }
    mountWidget(element, result.config, index + 1)
  })
}

// `defer` on the script tag already puts this after parsing, but the snippet is
// copied by hand onto other people's pages and a `<script>` in the middle of the
// body would otherwise find no mount point at all.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true })
} else {
  start()
}
