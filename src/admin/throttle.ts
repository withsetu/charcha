// The brute-force bound on the login endpoint.
//
// **Not #8's rate-limit layer, and that is the important part.** That layer counts
// rows in `comments` by `ip_hash`, and a login attempt creates no comment row — so
// reusing it would mean writing one. A D1-backed attempt counter is actively
// harmful here: a brute-forcer at 10 requests a second spends 864,000 writes a day
// against a 100k/day budget, which does not merely fail to stop them, it takes
// commenting down site-wide for everyone while they work. The platform binding
// stores nothing and costs nothing.
//
// The counters are "permissive, eventually consistent, and intentionally designed
// to not be used as an accurate accounting system", and are "local to the
// Cloudflare location that your Worker runs in"
// (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/,
// checked 2026-07-25). Both are fine for a login throttle and would be wrong for a
// quota: the job is to make guessing slow, not to count precisely.
// Enforced by test/worker/admin/throttle.test.ts.

import { announceOnce } from '../spam/log'
import { clientIp, normaliseIp } from '../spam/ip'

/**
 * The key an unidentifiable client is counted under.
 *
 * Cloudflare overwrites `CF-Connecting-IP` on every request that reaches a Worker,
 * so in production there is always an address. When there is not — `wrangler dev`,
 * a test, something unforeseen — every such request shares one bucket. That is the
 * conservative direction for a login endpoint: the alternative is a per-request
 * bucket, which is no throttle at all, and the cost of this choice falls on a
 * caller the edge could not identify rather than on an ordinary owner.
 */
const UNIDENTIFIED_KEY = 'charcha/login/unidentified'

export interface LoginThrottle {
  /** False when this client has made too many attempts recently. */
  allow(request: Request): Promise<boolean>
}

/**
 * The throttle over the `LOGIN_RATE_LIMITER` binding.
 *
 * **An absent binding refuses every login rather than allowing every login.** The
 * type says it is always there and wrangler.jsonc declares it; neither is a runtime
 * guarantee, and a rate limiter that silently is not running is the failure this
 * project has hit before — src/spam/rate-limit.ts spent a release announcing a
 * guard that wrote nothing. Failing open here would leave the one credential that
 * can delete every comment on the site behind no brute-force bound at all, with
 * every test still green. So it fails closed, and says so once per isolate, which
 * is the only way an owner whose config lost the binding finds out.
 *
 * The trade is honest and worth naming: a deployment that cannot provision the
 * binding cannot sign in. That is a locked door rather than an open one, it is
 * loud rather than silent, and it is the direction card rule 5 chooses. The
 * standing question of whether the binding provisions on the Workers Free plan is
 * on #12; if the answer is no, this is the code that has to change, not the
 * default.
 *
 * The key is `normaliseIp(clientIp(request))`, reusing src/spam/ip.ts so that #8's
 * IPv6 /64 folding applies here too — without it, a residential IPv6 customer is
 * handed 2^64 addresses and the throttle is a counter they reset by incrementing.
 * The raw address is the key rather than a hash of it, and it never leaves this
 * call: the binding stores nothing durable, so there is no `ip_hash`-shaped
 * retention question (#19) to answer.
 * Enforced by test/worker/admin/throttle.test.ts.
 */
export function loginThrottle(limiter: RateLimit | undefined): LoginThrottle {
  return {
    async allow(request: Request): Promise<boolean> {
      if (limiter === undefined) {
        announceOnce('login-throttle-missing', {
          event: 'admin_config',
          guard: 'login-throttle',
          enabled: false,
          reason: 'no LOGIN_RATE_LIMITER binding; refusing every login attempt',
        })
        return false
      }

      const ip = clientIp(request)
      const key = ip === null ? UNIDENTIFIED_KEY : normaliseIp(ip)
      const { success } = await limiter.limit({ key })
      return success
    },
  }
}
