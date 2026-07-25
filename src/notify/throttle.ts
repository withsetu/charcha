// The bound on how many emails a comment burst can produce.
//
// This exists because every comment is a potential email, and the cost of one is
// not ours: it lands on the site owner's Resend quota and their sending domain's
// reputation. Resend's free plan allows 3,000 emails a month and is "limited to 100
// emails per day" (https://resend.com/pricing, checked 2026-07-25), so a burst of
// 200 comments does not merely cost money — it spends the day's allowance and then
// *drops the notifications about real comments* for the rest of it. Bounding the
// sends is what keeps the useful ones deliverable.
//
// **A token bucket in module scope, holding no state anywhere durable.** The
// alternatives were considered and rejected: a D1 counter would spend the write
// budget a comment flood is already attacking (the argument src/admin/throttle.ts
// makes about a login counter), and the platform Rate Limiting binding cannot be
// added from this branch because wrangler.jsonc is not this change's to edit.
//
// The honest limitation: the bucket is per isolate, so N isolates can send N times
// this rate. That is weaker than a global quota and it is not pretending otherwise
// (#126). It is also load-adaptive in the right direction, which is why it is worth
// having rather than nothing: a quiet site gets a cold isolate and a full bucket, so
// every real comment mails, while a flood keeps a small number of isolates hot and
// is exactly the case where the bucket bites.
// Enforced by test/worker/notify/notifier.test.ts.

/**
 * How many emails may go out back to back before the refill rate governs.
 *
 * Five, so an ordinary busy morning — a post doing well, a handful of comments in a
 * few minutes — is not throttled at all.
 */
export const NOTIFY_BURST = 5

/**
 * One token every fifteen minutes: four an hour, 96 a day in steady state.
 *
 * The number is derived from Resend's documented free-plan cap of 100 a day, not
 * chosen for feel. A steady-state rate below the free allowance is what makes "the
 * owner still gets tomorrow's notifications" true after a flood.
 *
 * Precisely: 96 refills plus a full starting bucket is 101 in the first 24 hours of a
 * *fresh* isolate, so the very first day can cross the cap by the burst. Left alone
 * rather than shaved to 95, because the honest bound is the per-isolate one either
 * way (#126), and false precision here would be worse than a stated approximation.
 */
export const NOTIFY_REFILL_INTERVAL_MS = 15 * 60_000

export interface SendBudget {
  /**
   * Takes a token for one send.
   *
   * Returns how many sends were suppressed since the last one this granted — so the
   * email that does go out can say what it stands in for — or `null` when this send
   * must be dropped.
   */
  take(nowMs: number): { suppressed: number } | null
  /**
   * Puts a suppressed count back, because the send it was handed to failed.
   *
   * Without this the digest silently loses comments: `take` clears the counter, the
   * send then 429s — the failure src/notify/resend.ts calls the most likely one — and
   * those comments are never mentioned in any later email, while the log claims they
   * were covered. Found in review.
   *
   * The **token** is deliberately not returned. It was spent on a real outbound
   * attempt, and refunding it would let a failing Resend be retried at unbounded
   * rate, which is the opposite of what this module is for.
   * Enforced by test/worker/notify/notifier.test.ts.
   */
  restore(suppressed: number): void
}

export interface SendBudgetConfig {
  capacity?: number
  refillIntervalMs?: number
}

/**
 * A token bucket over an injected clock. Nothing here reads `Date.now()`, so tests
 * own time — the same rule the data layer follows.
 * Enforced by test/worker/notify/notifier.test.ts.
 */
export function sendBudget(config: SendBudgetConfig = {}): SendBudget {
  const capacity = config.capacity ?? NOTIFY_BURST
  const refillIntervalMs = config.refillIntervalMs ?? NOTIFY_REFILL_INTERVAL_MS

  let tokens = capacity
  let lastRefillMs: number | null = null
  let suppressed = 0

  return {
    take(nowMs: number) {
      // First call anchors the clock rather than assuming an epoch, so a fresh
      // isolate starts with a full bucket and not with a century of backdated
      // refills.
      lastRefillMs ??= nowMs

      const elapsed = nowMs - lastRefillMs
      // A negative elapsed is a clock that moved backwards, and the answer is to do
      // nothing: crediting tokens for it would make the limit resettable by whatever
      // caused it.
      if (elapsed >= refillIntervalMs) {
        const earned = Math.floor(elapsed / refillIntervalMs)
        // Capped at `capacity`, so a long quiet spell does not bank a flood's worth
        // of allowance for the flood to spend.
        tokens = Math.min(capacity, tokens + earned)
        lastRefillMs += earned * refillIntervalMs
      }

      if (tokens <= 0) {
        suppressed += 1
        return null
      }

      tokens -= 1
      const covered = suppressed
      suppressed = 0
      return { suppressed: covered }
    },

    restore(count: number) {
      if (count > 0) suppressed += count
    },
  }
}
