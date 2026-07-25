import { env } from 'cloudflare:workers'

// The dashboard's configuration is a secret and a binding on `env`, and both have
// to be moved around to test what happens when they are missing — which is the
// case that matters, because an unconfigured dashboard must refuse rather than
// admit. The pool hands tests the same `env` object the Worker sees, so these
// helpers set it directly rather than plumbing an override through every handler.

const mutable = env as unknown as {
  CHARCHA_DASHBOARD_PASSWORD?: string
  LOGIN_RATE_LIMITER?: RateLimit
}

export const TEST_PASSWORD = 'ThFn6Q7Rf2kZ8pWvB3xTqYuA'

/** The binding the Worker is deployed with, kept so a stub can be undone. */
const realLimiter = mutable.LOGIN_RATE_LIMITER

export function configurePassword(secret: string | undefined): void {
  if (secret === undefined) delete mutable.CHARCHA_DASHBOARD_PASSWORD
  else mutable.CHARCHA_DASHBOARD_PASSWORD = secret
}

/** Replaces the throttle with one that answers `success` to everything. */
export function stubLimiter(success: boolean): { keys: string[] } {
  const keys: string[] = []
  mutable.LOGIN_RATE_LIMITER = {
    limit: (options: { key: string }) => {
      keys.push(options.key)
      return Promise.resolve({ success })
    },
  }
  return { keys }
}

/** Removes the binding entirely, which is the fail-closed case. */
export function removeLimiter(): void {
  delete mutable.LOGIN_RATE_LIMITER
}

export function restoreLimiter(): void {
  mutable.LOGIN_RATE_LIMITER = realLimiter
}
