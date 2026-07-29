// The two secrets the spam layers read, and the one binding.
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
  }
}

/**
 * Just the parts of `Env` the spam layers are allowed to see.
 *
 * **`AI` is `Partial` where the generated `Env` has it required**, and that is a
 * statement about this seam rather than about the binding. `wrangler types` marks
 * every declared binding as present because the platform provides it; layer 6 must
 * still behave when it is not — on a deployment where provisioning did not happen,
 * and in every test in this project, because Workers AI has no local simulation and
 * a test that reached it would need account credentials and spend real neurons (see
 * vitest.config.ts). Making the absence expressible here is what lets
 * `createSpamCheck({})` stay the shape the other layers' tests already use, and what
 * `classifierLayer` abstains on.
 * Enforced by test/worker/spam/classifier.test.ts.
 */
export type SpamEnv = Pick<Env, 'TURNSTILE_SECRET_KEY' | 'IP_HASH_SECRET'> &
  Partial<Pick<Env, 'AI'>>
