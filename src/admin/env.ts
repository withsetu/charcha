// What the dashboard reads off `env`, and nothing else.
//
// One secret and one binding. The secret is declared here rather than in
// wrangler.jsonc for the reason src/spam/env.ts gives: `wrangler types` only
// generates types for what the config file declares, and a secret is not declared
// there — so the generated src/worker-configuration.d.ts, which invites a project
// to merge its own declaration into `Env`, is extended from here instead of
// edited. The binding *is* in wrangler.jsonc, so it is generated and not
// redeclared.
//
// The secret is OPTIONAL in the type and MANDATORY in effect. Absent means the
// dashboard is unconfigured, and an unconfigured dashboard refuses everything
// including its own login — the opposite of the spam layers, which abstain when a
// secret is missing so that comments still get taken. The difference is what the
// guard protects: abstaining on Turnstile loses a check, abstaining here would
// publish an open door to every comment on the site. Card rule 5, fail closed.
// Enforced by test/worker/admin/session.test.ts.

declare global {
  interface Env {
    /**
     * The one credential for the moderation dashboard, set at deploy time from
     * `.dev.vars.example`. There is no user table and no hash at rest: the secret
     * *is* the credential, and it is also the root of the session signing key
     * (see src/admin/session.ts), so rotating it signs every session out.
     */
    readonly CHARCHA_DASHBOARD_PASSWORD?: string
  }
}

/**
 * Just the parts of `Env` the dashboard is allowed to see.
 *
 * `LOGIN_RATE_LIMITER` is optional *here* although wrangler.jsonc declares it and
 * `wrangler types` types it as required. That is not a disagreement with the
 * generated type — it is this module refusing to assume a binding exists merely
 * because a config file says so. A deployment whose config was edited, or a plan
 * that does not provision the binding, hands the Worker `undefined` at runtime
 * while the type still says otherwise, and the login throttle is the last thing
 * that should discover that by throwing. src/admin/throttle.ts fails closed on it.
 * Enforced by test/worker/admin/throttle.test.ts.
 */
export interface AdminEnv {
  readonly DB: D1Database
  readonly CHARCHA_DASHBOARD_PASSWORD?: string
  readonly LOGIN_RATE_LIMITER?: RateLimit
}
