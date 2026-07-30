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
import { MODERATION_POLICY_SETTING, getModerationPolicy, readSetting, writeSetting } from '../db'
import { MODERATION_POLICIES, isModerationPolicy } from '../moderation/policy'
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

/**
 * The body's shape. Its size cap is readAdminJson's, shared with every admin route.
 *
 * **Both fields are optional, and an absent one is left alone — which is not the PUT
 * semantics the allowlist alone had, and is deliberate (#173).** The two settings are
 * edited from two different surfaces: the allowlist from the header's dialog, the
 * moderation policy from the Setup tab. If the body were the whole document, the origins
 * dialog would send back whatever policy it happened to read when it opened, so an owner
 * who changed the policy in one tab and saved an origin in another would silently undo
 * it — a lost update on the one setting that decides whether comments publish without
 * review. `allowedOrigins`, when it is sent, still replaces the whole list: an owner has
 * to be able to remove an origin.
 *
 * A body with neither field is refused rather than treated as a no-op, because it is a
 * caller asking for nothing and the honest answer is that they sent nothing.
 * Enforced by test/worker/admin/settings.test.ts.
 */
const bodySchema = z
  .object({
    allowedOrigins: z.array(z.string()).optional(),
    // Not `z.enum(MODERATION_POLICIES)`: the caller is the owner, and this endpoint
    // names the value it refused rather than answering "invalid body". See the check
    // in the handler.
    moderationPolicy: z.string().optional(),
  })
  .refine(
    (body) => body.allowedOrigins !== undefined || body.moderationPolicy !== undefined,
    'nothing to save',
  )

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

  return settingsResponse(c)
}

/**
 * `PUT /admin/api/settings` — the owner's settings: the allowlist, and the moderation
 * policy (#173).
 *
 * PUT and not PATCH because a field that is sent is replaced whole: an owner has to be
 * able to *remove* an origin, and an endpoint that only ever added would make de-listing
 * a staging domain impossible from the only surface that can edit it. A field that is
 * *absent* is untouched — see `bodySchema` for why that is not the same compromise.
 *
 * At most one D1 write per field, and only after everything has been validated — so a
 * list with one bad entry stores nothing rather than storing the good half and reporting
 * an error about the rest, and a bad policy leaves the origins in the same body unsaved.
 *
 * **This is the only writer of the moderation policy, and that is the security property
 * rather than an implementation detail.** The setting decides whether a stranger's
 * comment can be published without a human seeing it, so a public endpoint that could
 * reach it would be worse than the feature is worth. `authenticated` is the door and
 * `isCrossOriginRequest` is the other half: a page in another tab riding the owner's
 * session to switch their site to `trust-returning` is exactly the attack CSRF
 * protection is for here.
 * Enforced by test/worker/admin/settings.test.ts.
 */
export async function handleWriteSettings(c: AdminContext): Promise<Response> {
  if (isCrossOriginRequest(c.req.raw)) return forbidden()

  const auth = await authenticated(c.env, c.req.raw, now())
  if (!auth.ok) return auth.response

  const read = await readAdminJson(c.req.raw)
  if (!read.ok) return read.response

  const body = bodySchema.safeParse(read.value)
  if (!body.success) {
    return badRequest('Send allowedOrigins as a list of addresses, or moderationPolicy as one of.')
  }

  // **Refused, not coerced.** `parseModerationPolicy` turns anything unrecognisable into
  // `hold-all`, which is the right answer when reading a stored row on the submission
  // path and the wrong one here: the caller is the owner, and a policy that saved as
  // something other than what they chose — silently, with a 200 — is the setting most
  // worth being told about. The value is named in the message for the same reason a bad
  // origin is.
  const { allowedOrigins, moderationPolicy } = body.data
  if (moderationPolicy !== undefined && !isModerationPolicy(moderationPolicy)) {
    return badRequest(
      `“${moderationPolicy}” is not a moderation policy. It is one of: ${MODERATION_POLICIES.join(', ')}.`,
    )
  }

  if (allowedOrigins === undefined) {
    if (moderationPolicy !== undefined) {
      await writeSetting(c.env.DB, MODERATION_POLICY_SETTING, moderationPolicy, now())
    }
    return settingsResponse(c)
  }

  // **Counted after canonicalising and de-duplicating, not before.** `https://a.example`
  // and `https://a.example/` are one origin, and an owner who pasted a list with a
  // repeat in it should not be told they are over a limit they are not over. The bound
  // that matters is on what gets stored, and this is what gets stored.
  //
  // The loop is still bounded before the cap is checked, because `readAdminJson` bounds
  // the body first: at MAX_BODY_BYTES there is no list long enough for the per-entry
  // work here to be worth anything to an attacker — and the caller is authenticated.
  const origins: string[] = []
  for (const entry of allowedOrigins) {
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

  if (moderationPolicy !== undefined) {
    await writeSetting(c.env.DB, MODERATION_POLICY_SETTING, moderationPolicy, now())
  }
  await writeSetting(c.env.DB, ALLOWED_ORIGINS_SETTING, value, now())

  // The saved settings, read back from the database rather than echoed from the request:
  // the dashboard renders this, and it must show the canonicalised origins the public
  // check will compare against rather than the spelling the owner typed, and the policy
  // the submission path will actually apply rather than the string that was sent.
  return settingsResponse(c)
}

/**
 * The settings as they now stand, for both handlers.
 *
 * One function so the read and the write cannot answer differently-shaped bodies — the
 * dashboard validates neither, and a save that came back without `moderationPolicy`
 * would render as the default having been chosen.
 * Enforced by test/worker/admin/settings.test.ts.
 */
async function settingsResponse(c: AdminContext): Promise<Response> {
  return adminJson({
    // Read back through the same parser the public origin check uses, so the dashboard
    // shows what that check will actually honour rather than what the row happens to
    // contain. A stored value the reader fails closed on would otherwise be displayed
    // as a working allowlist.
    allowedOrigins: parseAllowedOrigins(await readSetting(c.env.DB, ALLOWED_ORIGINS_SETTING)),
    selfOrigin: selfOrigin(c.req.raw) ?? '',
    // Same rule, for the same reason: `getModerationPolicy` is the function the
    // submission path calls, so a row holding something unrecognisable is reported as
    // the policy that will actually be applied rather than as the string stored. The
    // failure this rules out is the dashboard showing a policy nothing enforces.
    moderationPolicy: await getModerationPolicy(c.env.DB),
  })
}
