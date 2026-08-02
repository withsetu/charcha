// The assembled spam check: layers 1-8, in the order #1 specifies, behind the
// SpamCheck seam #7 left for it.
//
// The ordering is the design, and the reason is economics rather than taste. It is
// ordered cheapest first, so that the expensive layers only ever see what the cheap
// ones could not decide:
//
//   1 honeypot        — one string comparison
//   2 timing          — one number comparison
//   3 Turnstile       — one subrequest, and only if the owner configured a secret
//   4 rate limit      — two indexed database reads
//   5 repeat offender — one indexed database read, and only if the deployment has an
//                       IP_HASH_SECRET to recognise anybody by (#184)
//   6 content         — string work, then at most one indexed database read
//   7 classifier      — one indexed database read, then a subrequest only if the site
//                       has trained a model on both classes (#10)
//   8 provider        — one subrequest to a third party, and only if the owner opted
//                       in and nothing above has already held the comment (#11)
//
// A comment the honeypot catches therefore costs no network call and no database
// read at all. Layer 7 is last of the local layers for the same reason Turnstile
// sits behind the string comparisons: it is the only one that can spend an
// inference call, and its own internals repeat the pattern — the cold-start read
// happens before the embedding, so a deployment that has never moderated anything
// reaches Workers AI zero times.
//
// **Layer 5 is priced with the reads, not with the string work, which is why it is
// there and not first.** It is the only layer whose evidence is the owner's own
// explicit decision rather than the absence of something wrong (#184), so it is
// tempting to put it at the front — but it costs an HMAC and an indexed read, and the
// ordering is about price rather than about strength. A comment the honeypot catches
// still costs nothing.
//
// **Layer 8 is last because it is the only layer that is not ours to spend.** Layers
// 1-7 are free, local, and transmit nothing about the reader; a third-party provider
// is metered — Akismet's paid tier allows 500 checks a month
// (https://akismet.com/pricing/, checked 2026-07-29) — and it is the site owner's
// money and their reader's data. So it sees only what seven layers could not decide,
// it is `reviewOnly` so a comment already held never reaches it at all, and it is
// off unless the owner switched it on. See src/spam/provider.ts.
//
// **Layer 4 sitting ahead of layer 7 is what bounds the neuron budget**, and it is
// the ordering doing security work rather than economics. Workers AI allows 10,000
// neurons a day and answers HTTP 429 after that, so a flood that reached the
// classifier could spend a site's whole allowance and leave layer 7 abstaining for
// the rest of the day. It cannot: the per-IP limit answers `reject`, and `runLayers`
// stops at the first reject without asking anything after it. The per-thread limit
// answers `review` and so does not short-circuit — by design, since review must not
// be a way to skip later layers — which leaves a distributed flood at one embedding
// per admitted comment. That is the same bound the write budget already imposes, and
// the failure it degrades to is this layer having no opinion.
// Enforced by test/worker/spam/order.test.ts and test/worker/spam/rate-limit.test.ts.

import type { SpamCheck, SpamCheckContext, SpamVerdict } from '../submit/spam'
import { classifierLayer } from './classifier'
import type { ClassifierConfig } from './classifier'
import { contentLayer } from './content'
import type { ContentConfig } from './content'
import type { SpamConfig } from './env'
import { honeypotLayer } from './honeypot'
import { runLayers } from './layer'
import type { SpamLayer } from './layer'
import { rateLimitLayer } from './rate-limit'
import type { RateLimitConfig } from './rate-limit'
import { repeatOffenderLayer } from './repeat-offender'
import { akismetProvider } from './akismet'
import { providerLayer } from './provider'
import type { SpamProvider } from './provider'
import { timingLayer } from './timing'
import { turnstileLayer } from './turnstile'
import type { TurnstileConfig } from './turnstile'

/**
 * The order, as data, so a test can assert it rather than infer it.
 *
 * Without this a rearrangement — Turnstile ahead of timing, content ahead of rate
 * limiting — breaks no test, and "the ordering is the design" becomes a comment
 * rather than a property.
 * Enforced by test/worker/spam/order.test.ts.
 */
export const SPAM_LAYER_ORDER = [
  'honeypot',
  'timing',
  'turnstile',
  'rate-limit',
  'repeat-offender',
  'content',
  'classifier',
  'provider',
] as const

export interface SpamCheckOverrides {
  turnstile?: Omit<TurnstileConfig, 'secretKey'>
  rateLimit?: Omit<RateLimitConfig, 'ipSecret'>
  content?: ContentConfig
  classifier?: Omit<ClassifierConfig, 'ai'>
  /**
   * A stand-in for layer 8, so no test reaches Akismet and no fixture carries a
   * key. The whole config rather than just the provider, because a provider with
   * no site URL is a layer that abstains. Nothing in production passes it.
   */
  provider?: { provider: SpamProvider | null; siteUrl?: string }
}

/**
 * Builds the check the Worker's POST /comments route runs.
 *
 * Configuration comes from three optional secrets, none of which a one-click deploy sets,
 * plus the `site_url` setting the caller resolved (#207) — and thresholds come from
 * constants that #66 will move to the `settings` table. `overrides` exists so tests can
 * inject a siteverify stand-in, pin a threshold, and stand in for the third-party
 * provider; nothing in production passes it.
 */
export function createSpamCheck(
  env: SpamConfig,
  overrides: SpamCheckOverrides = {},
): SpamCheck & {
  /** The assembled order, for the test that pins it. Never branched on. */
  readonly layers: readonly SpamLayer[]
} {
  const layers: SpamLayer[] = [
    honeypotLayer(),
    timingLayer(),
    turnstileLayer({ ...overrides.turnstile, secretKey: env.TURNSTILE_SECRET_KEY }),
    rateLimitLayer({ ...overrides.rateLimit, ipSecret: env.IP_HASH_SECRET }),
    repeatOffenderLayer({ ipSecret: env.IP_HASH_SECRET }),
    contentLayer(overrides.content),
    classifierLayer({ ...overrides.classifier, ai: env.AI }),
    providerLayer(
      overrides.provider ?? {
        provider: akismetProvider({
          apiKey: env.AKISMET_API_KEY,
          // The `site_url` setting, resolved by the caller (#207) — including the
          // fallback to the deprecated `CHARCHA_SITE_URL` secret, which happens in
          // src/settings.ts so that this file has one source for it rather than two.
          siteUrl: env.siteUrl ?? undefined,
        }),
        siteUrl: env.siteUrl ?? undefined,
      },
    ),
  ]

  return {
    layers,
    check(context: SpamCheckContext): Promise<SpamVerdict> {
      return runLayers(layers, context)
    },
  }
}
