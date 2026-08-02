// The four secrets the spam layers read, and the one binding.
//
// Neither is a binding in wrangler.jsonc, because both are secrets rather than
// vars — `wrangler secret put TURNSTILE_SECRET_KEY` — and `wrangler types` only
// generates types for what the config file declares. The generated
// src/worker-configuration.d.ts explicitly invites a project to merge its own
// declaration into `Env`, which is what this file does, so the secrets are typed
// without editing a generated file that `pnpm types:check` would then fail on.
//
// Both are OPTIONAL, and that is the design rather than laziness: a deployment
// that configures neither must still accept comments. Each layer abstains when
// its secret is missing instead of rejecting everything, which is the cold-start
// rule from #1 applied to configuration.
// Enforced by test/worker/spam/turnstile.test.ts and test/worker/spam/rate-limit.test.ts.

declare global {
  interface Env {
    /**
     * The Turnstile widget's secret key. Absent means the site owner has not set
     * Turnstile up, and layer 3 abstains.
     * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
     */
    readonly TURNSTILE_SECRET_KEY?: string
    /**
     * The HMAC key that turns a commenter's IP into the `comments.ip_hash` the
     * per-IP rate limit counts. Per deployment, and never derivable from the
     * database — it is the only thing standing between the stored hashes and a
     * map of who commented from where. Absent means the per-IP half of layer 4
     * abstains; the per-thread half still runs.
     */
    readonly IP_HASH_SECRET?: string
    /**
     * An Akismet API key, which switches layer 8 on (#11). Absent means it is off,
     * which is the state of every deployment that has not gone looking for it —
     * and the only state in which Charcha transmits nothing about a reader.
     *
     * Requires `CHARCHA_SITE_URL` as well; either alone is announced and ignored.
     * https://akismet.com/developers/comment-check/
     */
    readonly AKISMET_API_KEY?: string
    /**
     * **Deprecated (#207), read only as a fallback.** The `site_url` setting replaced it,
     * because the public address of the owner's own website is not a secret — it is the
     * same kind of data as the `allowed_origins` row, and collecting it as a credential
     * cost the owner a terminal and a redeploy for a value that is printed on their site.
     * This is read when that row has never been written, so an existing deployment's
     * layer 8 does not switch itself off the day it updates. Removing it is #209.
     *
     * It is Akismet's required `blog` parameter, the identity their account matches a
     * check against, and the base the permalink sent with a check is built from. It
     * cannot be derived — this Worker's own origin is a `workers.dev` address rather than
     * the site, and the URL the embed reports carries an origin anyone can choose
     * (src/page-key.ts).
     */
    readonly CHARCHA_SITE_URL?: string
  }
}

/**
 * Just the parts of `Env` the spam layers are allowed to see.
 *
 * **`AI` is `Partial` where the generated `Env` has it required**, and that is a
 * statement about this seam rather than about the binding. `wrangler types` marks
 * every declared binding as present because the platform provides it; layer 7 must
 * still behave when it is not — on a deployment where provisioning did not happen,
 * and in every test in this project, because Workers AI has no local simulation and
 * a test that reached it would need account credentials and spend real neurons (see
 * vitest.config.ts). Making the absence expressible here is what lets
 * `createSpamCheck({})` stay the shape the other layers' tests already use, and what
 * `classifierLayer` abstains on.
 * Enforced by test/worker/spam/classifier.test.ts.
 */
export type SpamEnv = Pick<Env, 'TURNSTILE_SECRET_KEY' | 'IP_HASH_SECRET' | 'AKISMET_API_KEY'> &
  Partial<Pick<Env, 'AI'>>

/**
 * Everything `createSpamCheck` needs: the secrets above, plus the settings rows the
 * caller has already resolved.
 *
 * **`siteUrl` is not on `env` any more (#207)**, and it is a field here rather than a
 * third parameter so that every existing call site — the tests all pass an env-shaped
 * literal — keeps typechecking. It is the caller's job to resolve it, because resolving
 * it costs a D1 read and the submission route already makes exactly one for every setting
 * this path needs (src/settings.ts).
 */
export interface SpamConfig extends SpamEnv {
  /** The site this deployment takes comments for, from the `site_url` setting. */
  readonly siteUrl?: string | null
}
