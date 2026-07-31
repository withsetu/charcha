// What the owner's moderation policy may be, in one place. Designed on issue #173.
//
// **It is its own module because two TypeScript projects need it and neither can import
// the other's**, the same arrangement as src/cascade.ts and for the same reason. The
// Worker reads the setting and decides a comment's status with it (src/db/index.ts,
// src/submit/pipeline.ts); the dashboard renders the choice and writes it
// (src/dashboard/components/setup.tsx), and lives in src/dashboard/tsconfig.json, which
// has no Cloudflare types. So this file imports nothing, which is what lets both
// programs have it — a second copy of the union would let the dashboard offer a value
// the Worker parses back to the default, and nothing would notice.
//
// Enforced by test/worker/moderation/policy.test.ts.

/**
 * The policies, in the order the dashboard offers them: safest first.
 *
 * **`hold-all` is index 0 and is the default, and both facts are load-bearing.** Every
 * deployment that has never touched this setting behaves exactly as it did before #173 —
 * every public comment held, the moderation queue the only way out — and an unreadable,
 * misspelt or hand-edited `settings` row lands here too rather than anywhere further
 * down the list. See `parseModerationPolicy`.
 *
 * **`trust-clean` is still deliberately not on this list, and `trust-vouched` is not
 * it under another name.** #173 proposed auto-approving whenever no layer objected,
 * and that remains unshipped for the reason it was declined: `allow` means *nothing
 * flagged this*, not *this is genuine*. Six of the layers measure the absence of
 * badness and a script written against this form passes all of them
 * (src/spam/index.ts, #184), so on a deployment that configured nothing, `allow` is
 * mostly the sound of layers not running.
 *
 * `trust-vouched` (#189) acts on a strictly narrower signal: a `vouch`, which only a
 * layer that asked a real classifier for a real verdict can produce, and only from a
 * positive answer. A provider that is off, that errored or that answered `unknown`
 * produces `null` and therefore an `allow`, which this policy does not act on — so on
 * the deployment most likely to reach for it, the one with nothing configured, it
 * publishes nothing. That self-limiting property is the whole difference, and it is
 * asserted rather than described: test/worker/submit/vouched.test.ts.
 * Enforced by test/worker/moderation/policy.test.ts.
 */
export const MODERATION_POLICIES = ['hold-all', 'trust-returning', 'trust-vouched'] as const

export type ModerationPolicy = (typeof MODERATION_POLICIES)[number]

/**
 * Today's behaviour, and what every unset, unknown or unparseable value becomes.
 *
 * The fail-closed direction, and the one that card rule 5 requires of a setting that can
 * publish a stranger's comment without a human seeing it: the failure of *this* value is
 * a comment held that need not have been, which is what happens on every deployment
 * today and costs nobody anything they were not already paying.
 */
export const DEFAULT_MODERATION_POLICY: ModerationPolicy = 'hold-all'

/**
 * A stored or submitted value as a policy, or the default when it is not one.
 *
 * Takes `unknown` rather than `string` on purpose: both callers hand it something they
 * did not create — a free-text `settings` row on one side and a parsed JSON body on the
 * other — and a signature that accepted only `string` would push the type check out to
 * the call sites, where the second one would forget it.
 *
 * **It never throws and never returns null.** A caller given null would have to decide
 * what to do about it on the public submission path, and there is exactly one safe
 * answer; returning it here means the answer cannot be got wrong twice. The dashboard's
 * write path does *not* use this — it rejects an unknown value loudly, because there the
 * caller is the owner and a policy that silently saved as something else is worse than an
 * error. See src/admin/settings.ts.
 * Enforced by test/worker/moderation/policy.test.ts.
 */
export function parseModerationPolicy(value: unknown): ModerationPolicy {
  return isModerationPolicy(value) ? value : DEFAULT_MODERATION_POLICY
}

/** Whether a value is one of the policies, for the write path that must refuse instead. */
export function isModerationPolicy(value: unknown): value is ModerationPolicy {
  return typeof value === 'string' && (MODERATION_POLICIES as readonly string[]).includes(value)
}
