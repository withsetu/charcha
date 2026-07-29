// The assembled spam check: layers 1-6, in the order #1 specifies, behind the
// SpamCheck seam #7 left for it.
//
// The ordering is the design, and the reason is economics rather than taste.
// Layer 7's third-party providers are metered (Akismet allows 500 checks a
// month) and are not built yet — so everything here is free, local, and transmits
// nothing about the reader, and it is ordered cheapest first so that the expensive
// layers only ever see what the cheap ones could not decide:
//
//   1 honeypot     — one string comparison
//   2 timing       — one number comparison
//   3 Turnstile    — one subrequest, and only if the owner configured a secret
//   4 rate limit   — two indexed database reads
//   5 content      — string work, then at most one indexed database read
//   6 classifier   — one indexed database read, then a subrequest only if the site
//                    has trained a model on both classes (#10)
//
// A comment the honeypot catches therefore costs no network call and no database
// read at all. Layer 6 is last of the local layers for the same reason Turnstile
// sits behind the string comparisons: it is the only one that can spend an
// inference call, and its own internals repeat the pattern — the cold-start read
// happens before the embedding, so a deployment that has never moderated anything
// reaches Workers AI zero times.
//
// **Layer 4 sitting ahead of layer 6 is what bounds the neuron budget**, and it is
// the ordering doing security work rather than economics. Workers AI allows 10,000
// neurons a day and answers HTTP 429 after that, so a flood that reached the
// classifier could spend a site's whole allowance and leave layer 6 abstaining for
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
import type { SpamEnv } from './env'
import { honeypotLayer } from './honeypot'
import { runLayers } from './layer'
import type { SpamLayer } from './layer'
import { rateLimitLayer } from './rate-limit'
import type { RateLimitConfig } from './rate-limit'
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
  'content',
  'classifier',
] as const

export interface SpamCheckOverrides {
  turnstile?: Omit<TurnstileConfig, 'secretKey'>
  rateLimit?: Omit<RateLimitConfig, 'ipSecret'>
  content?: ContentConfig
  classifier?: Omit<ClassifierConfig, 'ai'>
}

/**
 * Builds the check the Worker's POST /comments route runs.
 *
 * Configuration comes from `env` — two optional secrets, neither of which a
 * one-click deploy sets — and thresholds come from constants that #66 will move
 * to the `settings` table. `overrides` exists so tests can inject a siteverify
 * stand-in and pin a threshold; nothing in production passes it.
 */
export function createSpamCheck(
  env: SpamEnv,
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
    contentLayer(overrides.content),
    classifierLayer({ ...overrides.classifier, ai: env.AI }),
  ]

  return {
    layers,
    check(context: SpamCheckContext): Promise<SpamVerdict> {
      return runLayers(layers, context)
    },
  }
}
