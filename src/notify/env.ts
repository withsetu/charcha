// The three values email notifications read off `env`, and nothing else.
//
// None is a binding in wrangler.jsonc, for the reason src/spam/env.ts gives: the
// API key is a secret rather than a var — `wrangler secret put RESEND_API_KEY` —
// and `wrangler types` only generates types for what the config file declares. The
// generated src/worker-configuration.d.ts invites a project to merge its own
// declaration into `Env`, which is what this file does, so these are typed without
// editing a generated file that `pnpm types:check` would then fail on.
//
// All three are OPTIONAL, and all three are required *together*. Absence is a
// valid state and the feature is simply off (#14) — not a startup error, not a
// broken send path, and nothing announced to the reader. That is the same
// abstain-when-unconfigured rule the spam layers follow, and for a stronger
// reason: notifications are a convenience for the site owner, and a deployment
// that cannot email must still take comments.
// Enforced by test/worker/notify/notifier.test.ts.

declare global {
  interface Env {
    /**
     * A Resend API key. Absent means notifications are off.
     * https://resend.com/docs/api-reference/introduction
     */
    readonly RESEND_API_KEY?: string
    /**
     * The `from` address, which must be on a domain verified in the Resend
     * account that issued the key — Resend's `resend.dev` sender can only mail
     * the account holder's own address, and mailing anyone else from an
     * unverified domain answers 403.
     * https://resend.com/docs/knowledge-base/403-error-resend-dev-domain
     */
    readonly CHARCHA_NOTIFY_FROM?: string
    /**
     * Where new-comment notifications go — the site owner's own inbox. This is
     * the only recipient Charcha ever mails, and unsetting it is how the owner
     * stops the emails: there is no account to log into and no unsubscribe link,
     * because there is no recipient other than the person who set this value.
     */
    readonly CHARCHA_NOTIFY_TO?: string
  }
}

/** Just the parts of `Env` the notifier is allowed to see. */
export type NotifyEnv = Pick<Env, 'RESEND_API_KEY' | 'CHARCHA_NOTIFY_FROM' | 'CHARCHA_NOTIFY_TO'>
