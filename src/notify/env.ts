// What email notifications read off `env`, which since #207 is one credential and two
// deprecated addresses.
//
// **The trio split, and that is correct rather than a compromise.** `RESEND_API_KEY` can
// send mail as the owner, so it is a secret and stays one. The address notifications come
// *from* and the inbox they go *to* are the owner's own configuration — the same kind of
// data as the `allowed_origins` row that has been editable in the dashboard since #57 —
// so they are `settings` rows now, resolved by src/settings.ts. A display name joins them
// there (#208).
//
// `RESEND_API_KEY` is not a binding in wrangler.jsonc, for the reason src/spam/env.ts
// gives: it is a secret rather than a var — `wrangler secret put RESEND_API_KEY` — and
// `wrangler types` only generates types for what the config file declares. The generated
// src/worker-configuration.d.ts invites a project to merge its own declaration into `Env`,
// which is what this file does, so it is typed without editing a generated file that
// `pnpm types:check` would then fail on.
//
// Everything here is OPTIONAL, and the key and the two addresses are still required
// *together*. Absence is a valid state and the feature is simply off (#14) — not a startup
// error, not a broken send path, and nothing announced to the reader. That is the same
// abstain-when-unconfigured rule the spam layers follow, and for a stronger reason:
// notifications are a convenience for the site owner, and a deployment that cannot email
// must still take comments.
// Enforced by test/worker/notify/notifier.test.ts.

declare global {
  interface Env {
    /**
     * A Resend API key. Absent means notifications are off.
     *
     * The one value of the three that is genuinely a credential, and the only one still
     * read from here.
     * https://resend.com/docs/api-reference/introduction
     */
    readonly RESEND_API_KEY?: string
    /**
     * **Deprecated (#207), read only as a fallback.** The `notify_from` setting replaced
     * it; this is read when that row has never been written, so an existing deployment
     * does not lose its notifications the day it updates. Removing it is #209.
     *
     * It may carry a whole `Name <address>` value, because that is what it documented —
     * which is why `formatFrom` in src/notify/from.ts has to cope with being handed one.
     * https://resend.com/docs/knowledge-base/403-error-resend-dev-domain
     */
    readonly CHARCHA_NOTIFY_FROM?: string
    /**
     * **Deprecated (#207), read only as a fallback.** The `notify_to` setting replaced it,
     * on the same terms as `CHARCHA_NOTIFY_FROM` above. Removing it is #209.
     */
    readonly CHARCHA_NOTIFY_TO?: string
  }
}

/**
 * Just the parts of `Env` the notifier is allowed to see, which is now one field.
 *
 * The addresses are not here, and their absence is the seam moving rather than an
 * omission: `createNotifier` takes them as a resolved `NotifySettings` argument, so
 * nothing in src/notify can read a deprecated secret by reflex. The one place that reads
 * them is src/settings.ts, where the fallback and its deprecation notice live together.
 */
export type NotifyEnv = Pick<Env, 'RESEND_API_KEY'>

/**
 * The owner's notification configuration, as the settings rows resolved it (#207, #208).
 *
 * Separate from `NotifyEnv` because the two have different lifetimes and different owners:
 * one is a deployment secret set once with wrangler, the other is three rows the owner can
 * change from the dashboard between one comment and the next.
 */
export interface NotifySettings {
  /** The address to send from, or null when the owner has set none. May carry a name. */
  from: string | null
  /** The owner's inbox, or null. Clearing it is how the emails stop; there is no other reader. */
  to: string | null
  /** The sender's display name (#208), or null for the bare address every deployment had. */
  fromName: string | null
}
