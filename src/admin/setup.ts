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
import { readSpamModelStatus } from '../db'
import { classifierStatus } from '../spam/status'
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
  // `CHARCHA_NOTIFY_FROM` and `CHARCHA_NOTIFY_TO` are deliberately gone (#207). They are
  // `settings` rows now, and a row is not a secret: it is editable, so the Setup tab shows
  // it in a field with a Save button rather than as a status word beside a
  // `wrangler secret put` line, and it comes from `GET /admin/api/settings` where the rest
  // of the owner's configuration already lives. Reporting it here as well would be a
  // second answer to one question, which is the reason the allowlist was never in this
  // list either — see `handleReadSetup`.
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
 * Whether this deployment has the Workers AI binding layer 7 needs (#177).
 *
 * **`Partial` where the generated `Env` has `AI` required**, which is the same statement
 * `SpamEnv` makes in src/spam/env.ts and for the same reason: `wrangler types` marks
 * every declared binding as present because the platform provides it, and this endpoint's
 * entire job at this point is to describe a deployment where it is not. A one-click
 * deploy provisions Workers AI automatically (wrangler.jsonc), so the absence is a Worker
 * put together by hand or a binding since removed — rare, silent, and until now announced
 * only as one `spam_layer_inactive` line per isolate.
 *
 * It reads the binding and is **intended** never to call it: Workers AI has no local
 * simulation and every call spends neurons, so "is it there" is the only question this
 * surface may ask of it — a health check here would bill the owner for opening a settings
 * screen. Worded as intent rather than fact on purpose. No test can catch a call added
 * later, because no test in this project may touch `env.AI` at all (vitest.config.ts), so
 * a spy here would need account credentials to prove anything. What the tests do cover is
 * the *absence* case, in test/worker/admin/setup.test.ts.
 */
function hasAiBinding(env: Partial<Pick<Env, 'AI'>>): boolean {
  return env.AI !== undefined
}

/**
 * `GET /admin/api/setup` — which optional features this deployment has been given what
 * they need, and where the self-training spam classifier stands.
 *
 * **One D1 query, and it is a rowid seek** (#177). Everything else here is on `env`; the
 * classifier's state cannot be, because it is a history of the owner's own moderation
 * decisions and those live in `spam_model`. `readSpamModelStatus` deliberately does not
 * select the weights — see src/db.
 *
 * The seek is asserted in test/worker/spam/query-plan.test.ts. The *count* is intent
 * rather than an enforced invariant — nothing here spies on D1 — and it is worth holding
 * anyway: this handler answers a tab the owner opens repeatedly, and every read added
 * here is one more thing that can fail after `authenticated` has already succeeded.
 *
 * **It reads that row and nothing here can write it.** The row is written by exactly one
 * thing, a human moderation decision through src/spam/train.ts, which is the whole of
 * #28's answer to what counts as a training label. A control on this surface that could
 * reset or seed it would be a second writer.
 * Enforced by test/worker/admin/setup.test.ts.
 *
 * The allowlist, which is the one piece of setup that genuinely lives in the database
 * alongside it, is deliberately **not** folded in — it already has
 * `GET /admin/api/settings` (#57), and a second endpoint reporting the same setting is a
 * second answer that can disagree with the first.
 */
export async function handleReadSetup(c: AdminContext): Promise<Response> {
  const auth = await authenticated(c.env, c.req.raw, Math.floor(Date.now() / 1000))
  if (!auth.ok) return auth.response

  const model = await readSpamModelStatus(c.env.DB)

  return adminJson({
    secrets: secretReport(c.env),
    shortPassword: dashboardPasswordIsShort(c.env.CHARCHA_DASHBOARD_PASSWORD),
    classifier: classifierStatus(model, hasAiBinding(c.env)),
  })
}
