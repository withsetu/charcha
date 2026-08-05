// The owner's own configuration, as `settings` rows rather than as secrets (#207, #208).
//
// **What moved, and why it is not tidying.** Three of the values this project collected
// as secrets are not secrets: `CHARCHA_SITE_URL` is the public address of the owner's own
// website, `CHARCHA_NOTIFY_FROM` is an address on a domain they verified, and
// `CHARCHA_NOTIFY_TO` is their own inbox. `RESEND_API_KEY` is a credential and stays one.
// `allowed_origins` was already a row and is nearly the same *kind* of data as
// `CHARCHA_SITE_URL` — the owner saying which addresses are theirs — so the split between
// them was the order things were built in rather than a principle.
//
// The cost of the old arrangement was not inconvenience. `CHARCHA_SITE_URL` is optional,
// deliberately off the deploy form (#139), and read only by a spam layer that is also off
// by default — so almost nobody sets it and nobody has a reason to learn it exists. A row
// makes it editable in the dashboard, visible on the Setup tab, and changeable without a
// redeploy.
//
// **One statement for all of it, and that is a requirement rather than an optimisation.**
// Six settings read with `readSetting` are six seeks, and the seventh would be a seventh.
// CLAUDE.md's rule is a *constant* query count, not a low one, because the 50-query
// invocation budget throws rather than slows down. `readSettings` in src/db is the batched
// read; this module is what turns its raw strings into values the rest of the Worker can
// use. `allowed_origins` joined the submission-path list in #224, having been deliberately
// outside it: the browser check reads it before the request is accepted, but that check
// only fires when an `Origin` header arrived, and the submitted `url` has to be checked
// against the owner's addresses either way. `DECLARED_ORIGIN_SETTINGS` is the other read —
// those two rows alone — so `GET /comments` still never pays for the notification settings.
//
// **Everything here is untrusted input, whoever wrote it.** The dashboard is the only
// writer, but `wrangler d1 execute` reaches this table and a row can predate a validator.
// So every value is trimmed, capped, and run back through the *same* predicate the write
// path refuses on — `addressProblem` and `fromNameProblem` from src/notify/from.ts, and
// `siteHomeUrl`'s parser by way of the canonical form the write stored — and dropped
// rather than repaired when it is unusable. That is the same shape
// `getIpHashRetentionDays` and `parseAllowedOrigins` already have, and card rule 5 in the
// one place a settings row reaches an outbound request. The difference from the write path
// is only how it fails: there the owner is standing at the field and is told which
// character was refused; here there is nobody to tell and the value is simply not used.
//
// Enforced by test/worker/settings.test.ts.

import { ALLOWED_ORIGINS_SETTING, normaliseOrigin, parseAllowedOrigins } from './cors'
import { MODERATION_POLICY_SETTING, readSettings } from './db'
import { parseModerationPolicy } from './moderation/policy'
import type { ModerationPolicy } from './moderation/policy'
import {
  MAX_EMAIL_ADDRESS_LENGTH,
  MAX_FROM_NAME_LENGTH,
  addressProblem,
  fromNameProblem,
} from './notify/from'
import { announceOnce } from './spam/log'

/** The `settings` key holding the site this deployment takes comments for (#207). */
export const SITE_URL_SETTING = 'site_url'

/** The `settings` key holding the address notifications are sent from (#207). */
export const NOTIFY_FROM_SETTING = 'notify_from'

/** The `settings` key holding the owner's inbox (#207). */
export const NOTIFY_TO_SETTING = 'notify_to'

/** The `settings` key holding the sender's display name (#208). Empty means none. */
export const NOTIFY_FROM_NAME_SETTING = 'notify_from_name'

/**
 * The longest site URL this will read back.
 *
 * A URL a person typed, not a payload. Past this it is treated as unconfigured rather than
 * parsed, the same rule `MAX_ALLOWED_ORIGINS_LENGTH` states: matching against an unbounded
 * string on a public endpoint is unbounded work, and the value reaches an outbound request
 * to a third party.
 * Enforced by test/worker/settings.test.ts.
 */
export const MAX_SITE_URL_LENGTH = 2048

/**
 * Re-exported so the cap is one number.
 *
 * It is declared beside `addressProblem` in src/notify/from.ts, which is the rule both the
 * dashboard's write path and this module's read path apply — a second constant here would
 * be a second answer to "how long is too long" on the two values that reach a mail header.
 * Enforced by test/worker/settings.test.ts.
 */
export { MAX_EMAIL_ADDRESS_LENGTH }

/**
 * The cap on the *deprecated* `CHARCHA_NOTIFY_FROM` secret, which is wider than an address.
 *
 * That secret documented `Charcha <comments@example.com>` as a legal value, so a
 * deployment still on the fallback (#207) can hand this module a whole `From` value rather
 * than a bare address — an address, a space, a display name and two angle brackets. The
 * `notify_from` row that replaced it holds the address alone and is capped at
 * `MAX_EMAIL_ADDRESS_LENGTH`; this exists only until #209 removes the fallback.
 * Enforced by test/worker/settings.test.ts.
 */
const MAX_LEGACY_NOTIFY_FROM_LENGTH = MAX_EMAIL_ADDRESS_LENGTH + MAX_FROM_NAME_LENGTH + 3

/**
 * Every key the public submission path may need, read together.
 *
 * A list rather than five calls, so adding the sixth costs no query. The moderation policy
 * is in it: it used to be read on its own inside `autoApproved`, conditionally, and folding
 * it in trades a sometimes-query for a share of an always-query while removing the branch
 * that decided which.
 */
export const SUBMISSION_SETTINGS = [
  MODERATION_POLICY_SETTING,
  ALLOWED_ORIGINS_SETTING,
  SITE_URL_SETTING,
  NOTIFY_FROM_SETTING,
  NOTIFY_TO_SETTING,
  NOTIFY_FROM_NAME_SETTING,
] as const

/**
 * The two rows that say which addresses are the owner's (#224).
 *
 * A list of its own as well as being inside `SUBMISSION_SETTINGS`, because the two reads
 * have different shapes and both must be one statement: `resolveOrigin` needs these two
 * and nothing else, on a path shared with `GET /comments` where the notification settings
 * would be dead weight, while the submission path needs them alongside everything else and
 * must not pay a second seek for them.
 */
export const DECLARED_ORIGIN_SETTINGS = [ALLOWED_ORIGINS_SETTING, SITE_URL_SETTING] as const

/**
 * The secrets #207 deprecated, which are still read when their row has never been written.
 *
 * **A migration, not a design.** A deployment that set these before this change keeps
 * working the day it updates rather than losing its notifications silently — which is the
 * one failure worse than the feature being off, because absence is what "off" looks like.
 * Removing the fallback is [#209](https://github.com/withsetu/charcha/issues/209).
 */
export type SettingsFallbackEnv = Partial<
  Pick<Env, 'CHARCHA_SITE_URL' | 'CHARCHA_NOTIFY_FROM' | 'CHARCHA_NOTIFY_TO'>
>

/** The owner's configuration, resolved: rows first, deprecated secrets second. */
export interface SiteSettings {
  /** What happens to a comment no spam layer objected to (#173). Never null — see below. */
  moderationPolicy: ModerationPolicy
  /**
   * The `allowed_origins` row, parsed (#224).
   *
   * Read on this path as well as by `resolveOrigin` because the two questions are
   * different: that one asks which *page* may post, and this one is half of which
   * *addresses* a comment may claim to be from — a question a request with no `Origin`
   * header has to answer too, and the header is the only thing CORS can see.
   */
  allowedOrigins: string[]
  /** The site this deployment takes comments for, or null when the owner has set none. */
  siteUrl: string | null
  /**
   * The address notifications are sent from.
   *
   * May be a whole `Name <address>` value rather than a bare address, because the
   * deprecated secret documented that shape — see `formatFrom` in src/notify/from.ts,
   * which is what has to cope with it.
   */
  notifyFrom: string | null
  /** The owner's inbox. Null is how the owner stops the emails; there is nobody else to. */
  notifyTo: string | null
  /** The sender's display name (#208), or null for the bare address every deployment has today. */
  notifyFromName: string | null
}

/** The trimmed value, or null — the same answer `configured` gives in src/notify/index.ts. */
function usable(value: string | undefined | null, maxLength: number): string | null {
  const trimmed = (value ?? '').trim()
  if (trimmed === '' || trimmed.length > maxLength) return null
  return trimmed
}

/**
 * One value: the row when there is one, the deprecated secret when there is not.
 *
 * **`has`, not a truthiness check on the value.** A row the owner emptied means "none" and
 * must not fall back — otherwise clearing a field in the dashboard silently restores the
 * secret it replaced, having shown the owner a successful save. That is the whole reason
 * `readSettings` returns a Map.
 *
 * The fallback announces once per isolate. A deployment still running on a secret is
 * running on something this project intends to remove (#209), and the owner has no other
 * way to find that out.
 * Enforced by test/worker/settings.test.ts.
 */
function rowOrSecret(
  values: Map<string, string>,
  key: string,
  secretName: string,
  secretValue: string | undefined,
  maxLength: number,
): string | null {
  if (values.has(key)) return usable(values.get(key), maxLength)

  const fromSecret = usable(secretValue, maxLength)
  if (fromSecret !== null) {
    announceOnce(`settings-fallback:${key}`, {
      event: 'settings_config',
      setting: key,
      problem: `${secretName} is still being read as a secret, because the ${key} setting has never been saved`,
      fix: `save it on the Setup tab of your Charcha dashboard, then \`wrangler secret delete ${secretName}\``,
    })
  }
  return fromSecret
}

/**
 * The address, or null when it is not one this project will send to or from.
 *
 * `allowDisplayName` is the deprecated secret's shape, and it is a *narrow* exemption
 * rather than a looser check: the value must parse as `Something <bare@address>` and the
 * part inside the brackets is what `addressProblem` then judges. So a comma'd or
 * space-separated value is refused either way, and only the one documented legacy spelling
 * survives.
 * Enforced by test/worker/settings.test.ts.
 */
function usableAddress(value: string | null, { allowDisplayName }: { allowDisplayName: boolean }) {
  if (value === null) return null

  const inner = /^[^<>]*<([^<>]+)>$/.exec(value)?.[1]
  if (inner !== undefined) {
    if (!allowDisplayName) return null
    return addressProblem(inner.trim()) === null ? value : null
  }
  return addressProblem(value) === null ? value : null
}

/**
 * Turns the raw rows into the owner's configuration.
 *
 * Pure and separate from the read, so the resolution rules — the fallback, the caps, the
 * refusal of an unusable display name — are testable without a database and are the same
 * rules the admin endpoint's response is built from.
 * Enforced by test/worker/settings.test.ts.
 */
export function resolveSiteSettings(
  values: Map<string, string>,
  env: SettingsFallbackEnv,
): SiteSettings {
  // Through `parseModerationPolicy`, which is what the submission path acts on: a row
  // holding something unrecognisable is reported as the policy that will actually be
  // applied rather than as the string that is stored. See src/moderation/policy.ts.
  const moderationPolicy = parseModerationPolicy(values.get(MODERATION_POLICY_SETTING) ?? null)

  // Refused rather than repaired, and null rather than a partial name: a display name that
  // silently lost a character is the failure src/notify/from.ts refuses to ship, and this
  // is the same decision on the read side.
  // Capped before `fromNameProblem` sees it rather than left to that function's own
  // check, so nothing here trims and scans a string whose only bound is the D1 column.
  // Nothing on a public path writes this row, so it is habit rather than a live hole —
  // and it is the habit card rule 5 is.
  const storedName = usable(values.get(NOTIFY_FROM_NAME_SETTING), MAX_FROM_NAME_LENGTH)
  const notifyFromName =
    storedName !== null && fromNameProblem(storedName) === null ? storedName : null

  return {
    moderationPolicy,
    // Through the same parser the dashboard reads back and the origin check compares
    // against, so a row this would fail closed on is not reported as a working list.
    allowedOrigins: parseAllowedOrigins(values.get(ALLOWED_ORIGINS_SETTING) ?? null),
    siteUrl: rowOrSecret(
      values,
      SITE_URL_SETTING,
      'CHARCHA_SITE_URL',
      env.CHARCHA_SITE_URL,
      MAX_SITE_URL_LENGTH,
    ),
    // **Run back through the write path's own validator, and that is the same
    // second-layer argument src/notify/from.ts makes for the display name.** A row can
    // predate the check or be written straight into D1 with `wrangler d1 execute`, and
    // these two go into the Resend payload's `from` and `to` — so an address the
    // dashboard would have refused is dropped here rather than sent. Card rule 5 does not
    // stop at the commenter.
    //
    // `notifyFrom` is checked only when it is a bare address: the deprecated secret
    // documented `Name <address>`, which `addressProblem` refuses by design, and refusing
    // it here would switch off the notifications of exactly the deployments the fallback
    // exists for. `formatFrom` is what copes with that shape.
    notifyFrom: usableAddress(
      rowOrSecret(
        values,
        NOTIFY_FROM_SETTING,
        'CHARCHA_NOTIFY_FROM',
        env.CHARCHA_NOTIFY_FROM,
        MAX_LEGACY_NOTIFY_FROM_LENGTH,
      ),
      { allowDisplayName: true },
    ),
    notifyTo: usableAddress(
      rowOrSecret(
        values,
        NOTIFY_TO_SETTING,
        'CHARCHA_NOTIFY_TO',
        env.CHARCHA_NOTIFY_TO,
        MAX_EMAIL_ADDRESS_LENGTH,
      ),
      { allowDisplayName: false },
    ),
    notifyFromName,
  }
}

/**
 * Everything the submission path needs from `settings`, in one statement.
 *
 * Called once per `POST /comments`, before the spam check is assembled, so that layer 8's
 * site URL and the notifier's addresses come from the same read as the moderation policy.
 * Enforced by test/worker/settings.test.ts for what it resolves, and by
 * test/worker/submit/trust.test.ts and test/worker/notify/route-wiring.test.ts for the
 * count — both of which assert that exactly one of a submission's statements reads
 * `settings`, rather than only pinning the total. A total alone would be satisfied by two
 * settings reads and one fewer somewhere else.
 */
export async function readSiteSettings(
  db: D1Database,
  env: SettingsFallbackEnv,
): Promise<SiteSettings> {
  return resolveSiteSettings(await readSettings(db, SUBMISSION_SETTINGS), env)
}

/**
 * Every address the owner has said is theirs (#224): the allowlist, and the origin of
 * their site address.
 *
 * **The site address contributes its origin, not its URL.** An owner types a home page —
 * `https://maya.build/blog/` is a legitimate answer — and what the origin check compares is
 * an origin. `normaliseOrigin` is the same canonicalisation the allowlist entries went
 * through, so the two halves cannot disagree about what one address means, and a stored
 * value that is not a web address at all contributes nothing rather than throwing.
 *
 * This is deliberately not `selfOrigin`'s business: that one is derived per request from
 * `request.url` and is added by the caller that has a request (see src/cors.ts).
 * Enforced by test/worker/cors.test.ts.
 */
export function declaredOrigins(settings: Pick<SiteSettings, 'allowedOrigins' | 'siteUrl'>) {
  const origins = [...settings.allowedOrigins]
  const fromSiteUrl = settings.siteUrl === null ? null : normaliseOrigin(settings.siteUrl)
  if (fromSiteUrl !== null && !origins.includes(fromSiteUrl)) origins.push(fromSiteUrl)
  return origins
}

/**
 * The declared origins alone, in one statement, for `resolveOrigin`.
 *
 * Passed to it rather than imported by it: src/cors.ts is imported *by* this module, and
 * importing it back would be a module cycle whose two constant lists read each other before
 * either exists. See the note on `resolveOrigin`.
 *
 * **It resolves the site address exactly as the submission path does, deprecated secret and
 * all, and the alternative was worse than the duplication it avoids.** Leaving
 * `CHARCHA_SITE_URL` out here would give a deployment still running on that secret two
 * different answers to "which addresses are the owner's": the reported `url` would be
 * accepted and a browser on that same site refused, with the Setup tab showing the
 * migration notice for a value that half-works. The rule is one answer, in both places,
 * for as long as the fallback exists (#209 removes it).
 * Enforced by test/worker/cors.test.ts.
 */
export async function readDeclaredOrigins(
  db: D1Database,
  env: SettingsFallbackEnv,
): Promise<readonly string[]> {
  const values = await readSettings(db, DECLARED_ORIGIN_SETTINGS)
  return declaredOrigins({
    allowedOrigins: parseAllowedOrigins(values.get(ALLOWED_ORIGINS_SETTING) ?? null),
    siteUrl: rowOrSecret(
      values,
      SITE_URL_SETTING,
      'CHARCHA_SITE_URL',
      env.CHARCHA_SITE_URL,
      MAX_SITE_URL_LENGTH,
    ),
  })
}
