// What this deployment has and has not been configured with, as booleans. The Setup
// tab's data source (#158).
//
// **Why it has to exist at all.** The dashboard is a React client in a browser, so it
// cannot read `env`. Until this endpoint, the only way to learn that email notifications
// were off was to notice you never got one — configured, unconfigured and broken all
// looked identical from the outside, which is the silent-absence failure this project
// keeps finding elsewhere.
//
// **Booleans, never values, and the shape of the code is what holds that.** The report
// is built by mapping REPORTED_SECRETS through `isConfigured`: the only expression here
// that touches a secret is that call's argument, and its return type is `boolean`. So
// nothing a caller hands this module can reach the response as a string — the wrong
// object would produce a wrong boolean, which is a bug rather than a disclosure. Nothing
// is masked or truncated either: a masked field is unproofreadable — that is what #139
// took off the deploy form — and a first-four-characters preview is a disclosure with a
// smaller number attached, not a smaller disclosure.
// Enforced by test/worker/admin/setup.test.ts, which sets every reported secret to one
// sentinel string and asserts the response body does not contain it.
//
// **`shortPassword` is the one field outside that map, and it holds the same line by
// the same means** (#120). It is a `boolean` returned by `dashboardPasswordIsShort`
// (src/admin/password.ts), so the value cannot reach the response through it either —
// not a length, not a prefix, not a score. It is a genuine disclosure and a deliberate
// one: it says one bit about the credential to a caller who has already proved they
// hold it, and the alternative is a deployment running on a four-character password
// that nothing anywhere ever mentions. Nothing here refuses anything on the strength
// of it; see that function on why a floor on the login path would be a lockout.
// Enforced by test/worker/admin/setup.test.ts — the sentinel test above covers only the
// five in the map, so `never carries the password, whatever it is` is the case that
// covers this field, and it sets the password to the sentinel rather than the secrets.
//
// **Behind the same door as the moderation queue.** An unauthenticated caller learning
// which of a deployment's defences are switched off is a reconnaissance gift: "Turnstile
// is not set" tells a spammer exactly where their afternoon is best spent. The refusal
// carries no report either, so the 401 cannot be read as the answer.
// Enforced by test/worker/admin/setup.test.ts.
//
// **This surface is deliberately asymmetric with the root page, and it must stay that
// way.** #145 removed exactly this kind of operational readout from `GET /`, because
// that address is public and a stranger following the deploy-success link lands on it.
// Here the caller has already proved they hold the dashboard password, and telling them
// what they have not finished setting up is the entire job. Making the two consistent —
// in either direction — breaks one of them: `/` would leak, or the dashboard would go
// back to being unable to say anything useful.

import type { Context } from 'hono'
import { adminJson } from './api'
import { authenticated } from './authenticate'
import { dashboardPasswordIsShort } from './password'

/** The route, as a constant, so src/index.ts and the tests name the same string. */
export const SETUP_PATH = '/admin/api/setup'

type AdminContext = Context<{ Bindings: Env }>

/**
 * The secrets the Setup tab reports on.
 *
 * A list rather than an object literal per secret, because the literal is the place a
 * value could be typed by mistake and this is not: everything below maps over it.
 *
 * `CHARCHA_DASHBOARD_PASSWORD` is deliberately absent. Reaching this endpoint at all
 * proves it is set — an unconfigured dashboard authenticates nobody (src/admin/env.ts) —
 * so a row for it could only ever say "set", which is a row that teaches nothing and one
 * more place a credential is named beside a status. The question worth asking about it
 * is a different one, and it is answered separately as `shortPassword` (#120): set is
 * not the same as long enough, and only the second can still be news.
 */
export const REPORTED_SECRETS = [
  'RESEND_API_KEY',
  'CHARCHA_NOTIFY_FROM',
  'CHARCHA_NOTIFY_TO',
  'TURNSTILE_SECRET_KEY',
  'IP_HASH_SECRET',
  // Reported for the same reason `IP_HASH_SECRET` is (#107, #189): the Moderation
  // section offers `trust-vouched`, and without a provider configured nothing can ever
  // produce the `vouch` that policy acts on. A setting that reads as on and does
  // nothing is the failure this report exists to make impossible to ship.
  'AKISMET_API_KEY',
] as const

export type ReportedSecret = (typeof REPORTED_SECRETS)[number]

/**
 * The parts of `Env` this endpoint reads.
 *
 * A declaration of what is read, not an enforced restriction on what is passed:
 * `handleReadSetup` hands over the whole `c.env` and structural typing accepts it. The
 * guarantee that no value escapes is `isConfigured`'s return type, above — not this.
 */
export type SetupEnv = Pick<Env, ReportedSecret>

/** The answer: one boolean per reported secret, and nothing else. */
export type SecretReport = Record<ReportedSecret, boolean>

/**
 * Whether a secret holds a value the code that reads it would actually use.
 *
 * Trimmed, and blank counts as absent, so this agrees with `usableDashboardPassword`
 * (src/admin/password.ts), `usableIpSecret` (src/spam/ip.ts) and `configured`
 * (src/notify/index.ts) rather than inventing a fourth answer. A secret that is one
 * stray newline from `wrangler secret put` is one every feature reading it abstains on,
 * and a Setup tab calling that "set" would be the #107 failure in the one place someone
 * goes to check.
 * Enforced by test/worker/admin/setup.test.ts.
 */
function isConfigured(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * The report, built from the list so that no branch can put a value where a boolean
 * belongs.
 *
 * Exported for the tests, and pure: it reads `env` and returns booleans, which is the
 * whole of the endpoint's logic with the door taken off.
 */
export function secretReport(env: SetupEnv): SecretReport {
  return Object.fromEntries(
    REPORTED_SECRETS.map((name) => [name, isConfigured(env[name])]),
  ) as SecretReport
}

/**
 * `GET /admin/api/setup` — which optional features this deployment has been given what
 * they need.
 *
 * No D1 query at all: everything here is on `env`. The allowlist, which is the one piece
 * of setup that genuinely lives in the database, is deliberately **not** folded in — it
 * already has `GET /admin/api/settings` (#57), and a second endpoint reporting the same
 * setting is a second answer that can disagree with the first.
 * Enforced by test/worker/admin/setup.test.ts.
 */
export async function handleReadSetup(c: AdminContext): Promise<Response> {
  const auth = await authenticated(c.env, c.req.raw, Math.floor(Date.now() / 1000))
  if (!auth.ok) return auth.response

  return adminJson({
    secrets: secretReport(c.env),
    shortPassword: dashboardPasswordIsShort(c.env.CHARCHA_DASHBOARD_PASSWORD),
  })
}
