// Who is asking, decided by an ordered list of authenticators rather than a single
// check — and the list is ordered from the start even though it has one entry.
//
// #108 adds Cloudflare Access, and it has to go **ahead of** the password. If an
// owner puts Access in front of their deployment and the password path is consulted
// first, the deployment is still reachable by anyone holding the password, which is
// the exact thing Access was added to remove. Building the resolver as a list now
// means #108 inserts an entry; building it as an `if` now means #108 inverts a
// condition, and inverted conditions are how that bug happens.
//
// Enforced by test/worker/admin/authenticate.test.ts.

import { announceOnce } from '../spam/log'
import type { AdminEnv } from './env'
import { usableDashboardPassword } from './password'
import { readSessionCookies, verifySession } from './session'

/**
 * The one line an owner whose deployment has no dashboard password ever sees.
 *
 * Announced from here as well as from the login handler, because the commonest way
 * to meet an unconfigured dashboard is to *load* it: #13's shell calls
 * `GET /admin/api/session` before anyone presses a button, and that path never
 * touched the login handler — so the only channel for the fact stayed silent for
 * exactly the owner who needed it. One `announceOnce` key, so it is still said once
 * per isolate however many routes reach it.
 * Enforced by test/worker/admin/route.test.ts.
 */
export function announceSecretUnset(): void {
  announceOnce('dashboard-password-unset', {
    event: 'admin_config',
    guard: 'dashboard-password',
    enabled: false,
    reason: 'CHARCHA_DASHBOARD_PASSWORD is unset or blank; every admin request is refused',
  })
}

/** Who the request is, and which authenticator said so. */
export interface AdminIdentity {
  /** The authenticator's name. Short, stable, and safe to log. */
  readonly via: string
}

export interface AdminAuthenticator {
  readonly name: string
  authenticate(request: Request, now: number): Promise<AdminIdentity | null>
}

/**
 * The order, as data, so a test can assert it rather than infer it — the same
 * device SPAM_LAYER_ORDER uses in src/spam/index.ts and for the same reason.
 *
 * `cloudflare-access` belongs at index 0 when #108 lands. Nothing here reads this
 * constant to decide anything; it exists so that a rearrangement fails a test
 * instead of a review.
 * Enforced by test/worker/admin/authenticate.test.ts.
 */
export const ADMIN_AUTHENTICATOR_ORDER = ['session'] as const

/**
 * The password-session authenticator: the deployment's own cookie, verified
 * against a key derived from CHARCHA_DASHBOARD_PASSWORD.
 *
 * Returns null — never throws, never allows — when the secret is unset or blank.
 * An unconfigured deployment therefore authenticates nobody, which is what makes
 * `/admin` refuse everything rather than admit everyone. Card rule 5.
 * Enforced by test/worker/admin/authenticate.test.ts.
 */
export function sessionAuthenticator(env: AdminEnv): AdminAuthenticator {
  return {
    name: 'session',
    async authenticate(request: Request, now: number): Promise<AdminIdentity | null> {
      const secret = usableDashboardPassword(env.CHARCHA_DASHBOARD_PASSWORD)
      if (secret === null) {
        announceSecretUnset()
        return null
      }

      // Every candidate, not the first. A request may carry several cookies of the
      // same name — `__Secure-` constrains the `Secure` flag and the setting scheme
      // but says nothing about `Domain`, so on a custom domain anything able to write
      // a cookie on a sibling host can plant a junk value. Accepting only the first
      // match would let that value sign the owner out of their own dashboard for as
      // long as it sat there, with a 401 and no explanation.
      // Enforced by test/worker/admin/session.test.ts.
      for (const token of readSessionCookies(request)) {
        if (await verifySession(token, secret, now)) return { via: 'session' }
      }
      return null
    },
  }
}

/**
 * The authenticators this deployment runs, in order.
 *
 * Assembled per request from `env`, following createSpamCheck: the configuration is
 * a secret and a binding on `env`, so there is nothing to build at module scope and
 * nothing to keep in sync with it.
 */
export function adminAuthenticators(env: AdminEnv): AdminAuthenticator[] {
  return [sessionAuthenticator(env)]
}

/**
 * The first identity any authenticator will vouch for, or null.
 *
 * First non-null wins, and nothing after it is asked. That is what makes the order
 * meaningful rather than decorative: a later authenticator cannot override an
 * earlier one's answer, so putting Access first (#108) genuinely removes the
 * password path for a deployment that has Access, instead of merely preferring it.
 *
 * There is deliberately no way for an authenticator to *deny*. A denial would let
 * one entry veto every entry after it, and the list would stop being an ordered
 * fallback — the same rule LayerOutcome states for the spam layers, arrived at from
 * the other direction.
 * Enforced by test/worker/admin/authenticate.test.ts.
 */
export async function resolveIdentity(
  authenticators: readonly AdminAuthenticator[],
  request: Request,
  now: number,
): Promise<AdminIdentity | null> {
  for (const authenticator of authenticators) {
    const identity = await authenticator.authenticate(request, now)
    if (identity !== null) return identity
  }
  return null
}
