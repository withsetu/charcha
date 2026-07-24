// The assembled spam check: layers 1-5, in the order #1 specifies, behind the
// SpamCheck seam #7 left for it.
//
// The ordering is the design, and the reason is economics rather than taste.
// Layer 7's third-party providers are metered (Akismet allows 500 checks a
// month), and layers 6 and 7 are not built yet — so everything here is free,
// local, and transmits nothing about the reader, and it is ordered cheapest
// first so that the expensive layers only ever see what the cheap ones could not
// decide:
//
//   1 honeypot     — one string comparison
//   2 timing       — one number comparison
//   3 Turnstile    — one subrequest, and only if the owner configured a secret
//   4 rate limit   — two indexed database reads
//   5 content      — string work, then at most one indexed database read
//
// A comment the honeypot catches therefore costs no network call and no database
// read at all. Enforced by test/worker/spam/order.test.ts.

import type { SpamCheck, SpamCheckContext, SpamVerdict } from '../submit/spam'
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
] as const

export interface SpamCheckOverrides {
  turnstile?: Omit<TurnstileConfig, 'secretKey'>
  rateLimit?: Omit<RateLimitConfig, 'ipSecret'>
  content?: ContentConfig
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
  ]

  return {
    layers,
    check(context: SpamCheckContext): Promise<SpamVerdict> {
      return runLayers(layers, context)
    },
  }
}
