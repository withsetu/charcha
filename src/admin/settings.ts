// The allowed-origins setting, as an owner-facing surface. Designed on issue #57.
//
// **Why this file exists at all.** The allowlist in `settings` decided which pages may
// post into a deployment's moderation queue, and until now nothing could write it: not
// the deploy button, not the dashboard, not the Worker. The documented workaround was
// `wrangler d1 execute --remote`, which needs a checkout, wrangler, and an API token
// with D1 on it — none of which somebody who clicked Deploy has, and one of which the
// owner of this project turned out not to have either. So the only route from a
// successful deploy to a comment box that accepts their own site ran through tooling
// the intended audience does not own.
//
// **It is behind the same door as the moderation queue, and that is the point.** An
// allowlist a stranger can widen is not an allowlist: this endpoint decides which
// origins the public write endpoint trusts, so an unauthenticated caller reaching it
// would be worse than the missing feature it replaces. `authenticated` guards both
// halves; `isCrossOriginRequest` guards the write as well, because a page in another
// tab riding the owner's session to add itself to the list is exactly the attack the
// list is for.
//
// **And it refuses a typo rather than dropping it.** `parseAllowedOrigins` drops a
// malformed entry, which is correct on the read path — one typo must not take a site's
// real origin down with it. Here the caller is the owner and can be told, and an
// origin that silently did not save is a comment box that silently does not work.
//
// Enforced by test/worker/admin/settings.test.ts.

import type { Context } from 'hono'
import { z } from 'zod'
import {
  ALLOWED_ORIGINS_SETTING,
  MAX_ALLOWED_ORIGINS,
  MAX_ALLOWED_ORIGINS_LENGTH,
  normaliseOrigin,
  parseAllowedOrigins,
  selfOrigin,
} from '../cors'
import { readSetting, writeSetting } from '../db'
import { adminJson, badRequest, forbidden, readAdminJson } from './api'
import { authenticated } from './authenticate'
import { isCrossOriginRequest } from './csrf'

/** The route, as a constant, so src/index.ts and the tests name the same string. */
export const SETTINGS_PATH = '/admin/api/settings'

type AdminContext = Context<{ Bindings: Env }>

/**
 * The separator the list is stored with.
 *
 * A newline, because `parseAllowedOrigins` splits on commas *and* whitespace and this
 * is the form that reads back as one origin per line in the D1 console — which is
 * where an owner debugging a deployment will eventually look at it.
 */
const SEPARATOR = '\n'

/** The body's shape. Its size cap is readAdminJson's, shared with every admin route. */
const bodySchema = z.object({
  allowedOrigins: z.array(z.string()),
})

/** The clock, read once per handler, the way every other write in this project does. */
function now(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * `GET /admin/api/settings` — what the origin policy currently is.
 *
 * `selfOrigin` rides along because the dashboard has to be able to say the true thing:
 * this deployment's own address is allowed whether or not it is on the list, and an
 * owner who could not see that would add it by hand and reasonably conclude the list
 * was the whole rule. It is not a disclosure — the caller is signed in, and it is the
 * address they typed to get here.
 * Enforced by test/worker/admin/settings.test.ts.
 */
export async function handleReadSettings(c: AdminContext): Promise<Response> {
  const auth = await authenticated(c.env, c.req.raw, now())
  if (!auth.ok) return auth.response

  return adminJson({
    // Read back through the same parser the public origin check uses, so the dashboard
    // shows what that check will actually honour rather than what the row happens to
    // contain. A stored value the reader fails closed on would otherwise be displayed
    // as a working allowlist.
    allowedOrigins: parseAllowedOrigins(await readSetting(c.env.DB, ALLOWED_ORIGINS_SETTING)),
    selfOrigin: selfOrigin(c.req.raw) ?? '',
  })
}

/**
 * `PUT /admin/api/settings` — replace the allowlist.
 *
 * PUT and not PATCH because the body is the whole list: an owner has to be able to
 * *remove* an origin, and an endpoint that only ever added would make de-listing a
 * staging domain impossible from the only surface that can edit it.
 *
 * One D1 write, and only after every entry has been validated — so a list with one bad
 * entry stores nothing rather than storing the good half and reporting an error about
 * the rest.
 * Enforced by test/worker/admin/settings.test.ts.
 */
export async function handleWriteSettings(c: AdminContext): Promise<Response> {
  if (isCrossOriginRequest(c.req.raw)) return forbidden()

  const auth = await authenticated(c.env, c.req.raw, now())
  if (!auth.ok) return auth.response

  const read = await readAdminJson(c.req.raw)
  if (!read.ok) return read.response

  const body = bodySchema.safeParse(read.value)
  if (!body.success) return badRequest('Send allowedOrigins as a list of addresses.')

  // **Counted after canonicalising and de-duplicating, not before.** `https://a.example`
  // and `https://a.example/` are one origin, and an owner who pasted a list with a
  // repeat in it should not be told they are over a limit they are not over. The bound
  // that matters is on what gets stored, and this is what gets stored.
  //
  // The loop is still bounded before the cap is checked, because `readAdminJson` bounds
  // the body first: at MAX_BODY_BYTES there is no list long enough for the per-entry
  // work here to be worth anything to an attacker — and the caller is authenticated.
  const origins: string[] = []
  for (const entry of body.data.allowedOrigins) {
    const trimmed = entry.trim()
    if (trimmed === '') continue

    const origin = normaliseOrigin(trimmed)
    // Named in the message. "One of these is wrong" on a list of twenty is a message
    // that makes the owner check twenty of them.
    if (origin === null) {
      return badRequest(
        `“${trimmed}” is not an address a browser sends. It needs the scheme: https://example.com`,
      )
    }
    if (!origins.includes(origin)) origins.push(origin)
  }

  if (origins.length > MAX_ALLOWED_ORIGINS) {
    return badRequest(
      `That is more than ${String(MAX_ALLOWED_ORIGINS)} addresses. One site is usually an apex, a www and a staging host.`,
    )
  }

  const value = origins.join(SEPARATOR)
  // The stored value has to be one the public reader will accept back.
  // `parseAllowedOrigins` treats anything past this length as unconfigured, so without
  // this check the dashboard could report a saved allowlist while the origin check
  // silently refused every origin on it — the #107 failure, in the one place it would
  // be invisible until a reader complained.
  if (value.length > MAX_ALLOWED_ORIGINS_LENGTH) {
    return badRequest('Those addresses are too long to store together. Use fewer, or shorter ones.')
  }

  await writeSetting(c.env.DB, ALLOWED_ORIGINS_SETTING, value, now())

  // The saved list, read back from what was written rather than echoing the request:
  // the dashboard renders this, and it must show the canonicalised form the origin
  // check will compare against, not the spelling the owner typed.
  return adminJson({ allowedOrigins: origins, selfOrigin: selfOrigin(c.req.raw) ?? '' })
}
