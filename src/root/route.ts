// The HTTP boundary for `GET /` (#140).
//
// It owns two things and nothing else: one D1 statement asking whether this
// deployment's database has been migrated, and this Worker's own origin. The page is
// src/root/page.ts, which is pure.
//
// **One query, always** — the same discipline the read path keeps. `/` is a public
// address that crawlers and scanners will hit, so its cost has to be a constant, and
// it is: `databaseStatus` reads one row of SQLite's schema table and no application
// data. It is deliberately not free, because a status page that could not tell a
// migrated database from an empty one would answer green on the one deploy failure
// this page exists to catch (#129).
//
// Enforced by test/worker/root/page.test.ts.

import type { Context } from 'hono'
import { selfOrigin } from '../cors'
import { databaseStatus } from '../db'
import { ROOT_PAGE_HEADERS, renderRootPage } from './page'

export async function handleRoot(c: Context<{ Bindings: Env }>): Promise<Response> {
  const html = renderRootPage({
    // The same derivation the origin policy uses, from `request.url` — so the snippet
    // names the address this request actually arrived on, which is the address the
    // deployer is looking at. A deployment reachable on both a custom domain and
    // workers.dev shows whichever one they used.
    origin: selfOrigin(c.req.raw),
    database: await databaseStatus(c.env.DB),
  })

  return c.body(html, 200, ROOT_PAGE_HEADERS)
}
