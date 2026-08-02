// The owner's settings, as an owner-facing surface. Designed on issue #57, and grown by
// #173 (the moderation policy) and #207/#208 (the site address and the notification
// addresses, which used to be secrets).
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
// origin that silently did not save is a comment box that silently does not work. Since
// #207 that rule covers five more fields, and one of them is the highest-risk string this
// project sends: the `From:` display name, refused here by the same function that refuses
// it on the way out (src/notify/from.ts).
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
import { MODERATION_POLICY_SETTING, readSettings, writeSetting } from '../db'
import { MODERATION_POLICIES, isModerationPolicy } from '../moderation/policy'
import { MAX_FROM_NAME_LENGTH, fromNameProblem } from '../notify/from'
import {
  MAX_EMAIL_ADDRESS_LENGTH,
  MAX_SITE_URL_LENGTH,
  NOTIFY_FROM_NAME_SETTING,
  NOTIFY_FROM_SETTING,
  NOTIFY_TO_SETTING,
  SITE_URL_SETTING,
  SUBMISSION_SETTINGS,
  resolveSiteSettings,
} from '../settings'
import { siteHomeUrl } from '../spam/akismet'
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
    // The four rows #207 and #208 moved off `env`. Typed as plain strings for the same
    // reason the policy is: each is checked below by the function the *reader* uses, so
    // the refusal can name the value and the character rather than answering "invalid
    // body" about a field the owner is standing at.
    //
    // An empty string is a value here and means "clear this". It is not the same as an
    // absent field, which leaves the row alone — and it is not the same as no row at all,
    // because a row the owner emptied deliberately does not fall back to the deprecated
    // secret (src/settings.ts).
    siteUrl: z.string().optional(),
    notifyFrom: z.string().optional(),
    notifyTo: z.string().optional(),
    notifyFromName: z.string().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), 'nothing to save')

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
    return badRequest(
      'Send allowedOrigins as a list of addresses, or moderationPolicy, siteUrl, notifyFrom, notifyTo or notifyFromName as a string.',
    )
  }

  // **Everything is validated before anything is written, and that is what the two
  // passes below are for.** A list with one bad entry must store nothing rather than
  // storing the good half and reporting an error about the rest — and since #207 the same
  // has to hold across six fields, so a refused site URL cannot leave a saved recipient
  // behind it.
  const { allowedOrigins, moderationPolicy } = body.data

  // **Refused, not coerced.** `parseModerationPolicy` turns anything unrecognisable into
  // `hold-all`, which is the right answer when reading a stored row on the submission
  // path and the wrong one here: the caller is the owner, and a policy that saved as
  // something other than what they chose — silently, with a 200 — is the setting most
  // worth being told about. The value is named in the message for the same reason a bad
  // origin is.
  if (moderationPolicy !== undefined && !isModerationPolicy(moderationPolicy)) {
    return badRequest(
      `“${moderationPolicy}” is not a moderation policy. It is one of: ${MODERATION_POLICIES.join(', ')}.`,
    )
  }

  /** The rows this request will write, once every field in it has been checked. */
  const writes: [key: string, value: string][] = []
  if (moderationPolicy !== undefined) writes.push([MODERATION_POLICY_SETTING, moderationPolicy])

  const checked = checkedRows(body.data)
  if ('problem' in checked) return badRequest(checked.problem)
  writes.push(...checked.rows)

  if (allowedOrigins !== undefined) {
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
      return badRequest(
        'Those addresses are too long to store together. Use fewer, or shorter ones.',
      )
    }
    writes.push([ALLOWED_ORIGINS_SETTING, value])
  }

  // One statement per field that was sent, and none until every field has passed.
  // `writeSetting` is one upsert, so this is at most six writes on a request one
  // authenticated person makes by clicking Save.
  const at = now()
  for (const [key, value] of writes) await writeSetting(c.env.DB, key, value, at)

  // The saved settings, read back from the database rather than echoed from the request:
  // the dashboard renders this, and it must show the canonicalised origins the public
  // check will compare against rather than the spelling the owner typed, and the policy
  // the submission path will actually apply rather than the string that was sent.
  return settingsResponse(c)
}

/**
 * The four rows #207 and #208 moved off `env`, checked and turned into writes — or the
 * one sentence explaining what was refused.
 *
 * **Refused loudly, exactly as an unknown moderation policy is, and for the same reason.**
 * The reader-side resolution in src/settings.ts drops an unusable value and carries on,
 * which is right on the submission path where there is nobody to tell. Here the caller is
 * the owner, standing at the field, and a value that saved as something other than what
 * they typed — or saved and then silently did nothing — is the #107 failure aimed at the
 * one screen they would go to to check.
 *
 * **Each is checked by the function that will later *read* it.** `siteHomeUrl` is layer
 * 8's own canonicaliser (src/spam/akismet.ts) and `fromNameProblem` is what
 * src/notify/from.ts refuses on, so the dashboard cannot accept a value the Worker will
 * then ignore. A second validator here would be two rules that can disagree.
 *
 * An **empty string clears the row**, and clearing is not the same as never having set it:
 * an emptied row does not fall back to the deprecated secret. That is how an owner turns
 * notifications off on a deployment that still has `CHARCHA_NOTIFY_TO` set.
 * Enforced by test/worker/admin/settings.test.ts.
 */
function checkedRows(data: {
  siteUrl?: string
  notifyFrom?: string
  notifyTo?: string
  notifyFromName?: string
}): { rows: [string, string][] } | { problem: string } {
  const rows: [string, string][] = []

  if (data.siteUrl !== undefined) {
    const trimmed = data.siteUrl.trim()
    if (trimmed === '') rows.push([SITE_URL_SETTING, ''])
    else {
      const home = siteHomeUrl(trimmed)
      if (home === null) {
        return {
          problem: `“${trimmed}” is not a web address. It needs the scheme: https://example.com`,
        }
      }
      if (home.length > MAX_SITE_URL_LENGTH) {
        return { problem: 'That address is too long to store. Use your site’s home page.' }
      }
      rows.push([SITE_URL_SETTING, home])
    }
  }

  for (const [key, value, label] of [
    [NOTIFY_FROM_SETTING, data.notifyFrom, 'The address notifications are sent from'],
    [NOTIFY_TO_SETTING, data.notifyTo, 'The address notifications are sent to'],
  ] as const) {
    if (value === undefined) continue
    const trimmed = value.trim()
    if (trimmed === '') {
      rows.push([key, ''])
      continue
    }
    const problem = addressProblem(trimmed, label)
    if (problem !== null) return { problem }
    rows.push([key, trimmed])
  }

  if (data.notifyFromName !== undefined) {
    const trimmed = data.notifyFromName.trim()
    // Checked even when it is blank, which costs nothing and means the one validator runs
    // on every path rather than on the path somebody remembered.
    const problem = fromNameProblem(trimmed)
    if (problem !== null) return { problem }
    rows.push([NOTIFY_FROM_NAME_SETTING, trimmed])
  }

  return { rows }
}

/**
 * Why this is not an address a notification can use, or null when it is.
 *
 * **Deliberately not an RFC 5322 parser.** The failure this has to prevent is a value that
 * would change what the `From:` header means or that the provider will simply reject, and
 * the shape that does both is the same short list src/notify/from.ts refuses in a display
 * name: whitespace, angle brackets, quotes and the separators. Beyond that, whether
 * `a.b+c@example.co.uk` is deliverable is Resend's question and not this project's, and a
 * stricter check here would refuse working addresses to no benefit — the symptom of which
 * is an owner who cannot save the address that works.
 *
 * The one *positive* requirement is a single `@` with something either side, because a
 * value without one is not an address by any reading and is the typo worth catching at the
 * field rather than in a 403 from Resend three days later.
 * Enforced by test/worker/admin/settings.test.ts.
 */
function addressProblem(value: string, label: string): string | null {
  if (value.length > MAX_EMAIL_ADDRESS_LENGTH) {
    return `${label} is longer than ${String(MAX_EMAIL_ADDRESS_LENGTH)} characters, which is not an email address.`
  }
  if (/[\s<>"\\,;:]/.test(value)) {
    return `${label} cannot contain spaces, angle brackets, quotes or separators. Put a sender name in the name field instead — it holds up to ${String(MAX_FROM_NAME_LENGTH)} characters.`
  }
  const at = value.indexOf('@')
  if (at < 1 || at !== value.lastIndexOf('@') || at === value.length - 1) {
    return `“${value}” is not an email address. It needs one @, with a name before it and a domain after it.`
  }
  return null
}

/**
 * The settings as they now stand, for both handlers.
 *
 * One function so the read and the write cannot answer differently-shaped bodies — the
 * dashboard validates neither, and a save that came back without `moderationPolicy`
 * would render as the default having been chosen.
 *
 * **One statement for all seven values (#207).** It used to be two `readSetting` seeks and
 * would now be seven; `readSettings` is the batched read. This is the authenticated path
 * rather than the hot one, so the argument is consistency with the submission path rather
 * than the invocation budget — but a settings endpoint that costs a query per setting is
 * the shape that makes the next setting free to add and expensive to have.
 *
 * **It reports the *rows*, never the deprecated secret's value.** A field prefilled with
 * something the owner never typed into it is a value they would save without deciding to,
 * and #158's rule is that this surface renders no secret's value at all. What it does
 * report is `fromDeprecatedSecrets`, which names the settings still being served by one —
 * enough for the dashboard to say "this is where your value is coming from, save it here
 * to move it" without printing it.
 * Enforced by test/worker/admin/settings.test.ts.
 */
async function settingsResponse(c: AdminContext): Promise<Response> {
  const values = await readSettings(c.env.DB, [ALLOWED_ORIGINS_SETTING, ...SUBMISSION_SETTINGS])
  const resolved = resolveSiteSettings(values, c.env)

  return adminJson({
    // Read back through the same parser the public origin check uses, so the dashboard
    // shows what that check will actually honour rather than what the row happens to
    // contain. A stored value the reader fails closed on would otherwise be displayed
    // as a working allowlist.
    allowedOrigins: parseAllowedOrigins(values.get(ALLOWED_ORIGINS_SETTING) ?? null),
    selfOrigin: selfOrigin(c.req.raw) ?? '',
    // Same rule, for the same reason: `resolveSiteSettings` runs the row through the
    // parser the submission path calls, so a row holding something unrecognisable is
    // reported as the policy that will actually be applied rather than as the string
    // stored. The failure this rules out is the dashboard showing a policy nothing
    // enforces.
    moderationPolicy: resolved.moderationPolicy,
    // The rows, as the owner saved them — `''` for a row that is unset or that they
    // cleared. Trimmed and capped by the same resolution the reader uses, so an edit that
    // could not be honoured is not shown back as if it had been.
    siteUrl: rowValue(values, SITE_URL_SETTING, resolved.siteUrl),
    notifyFrom: rowValue(values, NOTIFY_FROM_SETTING, resolved.notifyFrom),
    notifyTo: rowValue(values, NOTIFY_TO_SETTING, resolved.notifyTo),
    notifyFromName: rowValue(values, NOTIFY_FROM_NAME_SETTING, resolved.notifyFromName),
    fromDeprecatedSecrets: [
      SITE_URL_SETTING,
      NOTIFY_FROM_SETTING,
      NOTIFY_TO_SETTING,
      // A setting is being served by a secret exactly when there is no row and something
      // came out anyway. Derived rather than listed, so it cannot claim a fallback that
      // the resolver did not actually use — a blank or over-long secret resolves to null
      // and is not a fallback at all.
    ].filter((key) => !values.has(key) && resolvedFor(resolved, key) !== null),
  })
}

/** The saved row, or `''` — never the deprecated secret standing in for it. */
function rowValue(values: Map<string, string>, key: string, resolved: string | null): string {
  if (!values.has(key)) return ''
  return resolved ?? ''
}

/** What the resolver produced for one of the three settings a secret can still serve. */
function resolvedFor(resolved: { siteUrl: string | null; notifyFrom: string | null; notifyTo: string | null }, key: string): string | null {
  if (key === SITE_URL_SETTING) return resolved.siteUrl
  if (key === NOTIFY_FROM_SETTING) return resolved.notifyFrom
  return resolved.notifyTo
}
