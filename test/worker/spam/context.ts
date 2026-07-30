// One place to build the SpamCheckContext the seam hands a layer, so each test
// states only the thing it is about and nothing else.

import { env } from 'cloudflare:workers'
import type { SpamCheckContext } from '../../../src/submit/spam'

export const db = env.DB

/** A fixed clock in unix seconds, so no test depends on the wall clock. */
export const t0 = 1_753_300_000

export const validBody =
  'The part people underestimate is the export, and the fact that nobody checks it until the day they leave.'

export interface ContextOverrides {
  form?: Record<string, unknown>
  body?: string
  authorName?: string
  authorEmail?: string
  pageKey?: string
  ip?: string | null
  now?: number
}

export function contextFor(overrides: ContextOverrides = {}): SpamCheckContext {
  const headers = new Headers()
  if (overrides.ip !== null) headers.set('CF-Connecting-IP', overrides.ip ?? '198.51.100.7')

  return {
    comment: {
      authorName: overrides.authorName ?? 'Rahul Kanwar',
      // Absent unless a test asks for one, because most real comments have none —
      // a default address here would give every fixture half of #173's identity.
      ...(overrides.authorEmail === undefined ? {} : { authorEmail: overrides.authorEmail }),
      body: overrides.body ?? validBody,
    },
    form: overrides.form ?? {},
    pageKey: overrides.pageKey ?? '/notes/leaving',
    pageUrl: 'https://maya.build/notes/leaving',
    request: new Request('https://charcha.example/comments', { method: 'POST', headers }),
    db,
    now: overrides.now ?? t0,
  }
}
