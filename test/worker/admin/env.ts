import { env } from 'cloudflare:workers'
import { REPORTED_SECRETS, type ReportedSecret } from '../../../src/admin/setup'

// The dashboard's configuration is a secret and a binding on `env`, and both have
// to be moved around to test what happens when they are missing — which is the
// case that matters, because an unconfigured dashboard must refuse rather than
// admit. The pool hands tests the same `env` object the Worker sees, so these
// helpers set it directly rather than plumbing an override through every handler.

const mutable = env as unknown as {
  CHARCHA_DASHBOARD_PASSWORD?: string
  LOGIN_RATE_LIMITER?: RateLimit
  AI?: Ai
}

export const TEST_PASSWORD = 'ThFn6Q7Rf2kZ8pWvB3xTqYuA'

/** The binding the Worker is deployed with, kept so a stub can be undone. */
const realLimiter = mutable.LOGIN_RATE_LIMITER

/**
 * The secret the Worker was deployed with, so a file can put it back exactly.
 *
 * `env` is one object shared by every test file in the isolate, so a file that
 * restored a *constant* rather than what it found would hand the next file a
 * dashboard it did not configure. Read once, at import.
 */
const realPassword = mutable.CHARCHA_DASHBOARD_PASSWORD

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

/** Puts the secret back to whatever the Worker actually has. */
export function restorePassword(): void {
  configurePassword(realPassword)
}

/**
 * The Workers AI binding as this isolate was given it, so its absence can be tested.
 *
 * **Absence is the case that matters and the one nothing else in the suite can reach.**
 * `wrangler.jsonc` declares the `ai` binding, so `env.AI` is present in every test —
 * which is the *provisioned* deployment. A deployment that never got one (the binding
 * removed, or a Worker set up by hand rather than through the Deploy button) is the state
 * #177 exists to make visible, and the only way to stand in it here is to take the
 * binding off `env` and put it back.
 *
 * Nothing here calls it. Workers AI has no local simulation, so a test that reached the
 * binding would need account credentials and spend real neurons — see vitest.config.ts.
 */
const realAi = mutable.AI

/** Removes the binding entirely, which is the never-provisioned deployment. */
export function removeAiBinding(): void {
  delete mutable.AI
}

/** Puts it back to whatever this isolate actually has, which may be nothing. */
export function restoreAiBinding(): void {
  if (realAi === undefined) delete mutable.AI
  else mutable.AI = realAi
}

/**
 * The optional secrets the Setup tab reports on (#158), as they were at import.
 *
 * Read once and restored wholesale for the reason `realPassword` gives: `env` is one
 * object shared by every test file in the isolate, and a file that put back a constant
 * rather than what it found would hand the next file a deployment it did not configure —
 * which for these means a spam layer silently on or off in somebody else's test.
 */
const secrets = env as unknown as Record<ReportedSecret, string | undefined>

const realSecrets = new Map<ReportedSecret, string | undefined>(
  REPORTED_SECRETS.map((name) => [name, secrets[name]]),
)

export function configureSecret(name: ReportedSecret, value: string | undefined): void {
  if (value === undefined) delete secrets[name]
  else secrets[name] = value
}

export function restoreSecrets(): void {
  for (const [name, value] of realSecrets) configureSecret(name, value)
}
