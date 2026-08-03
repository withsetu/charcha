// Layer 8 — the seam a third-party spam service plugs into (#11), and the one
// place in this project where something about a reader leaves the Worker.
//
// **This layer breaks Charcha's posture on purpose, and only when the site owner
// says so.** Layers 1-6 run locally and transmit nothing; this one transmits the
// commenter's IP address, their name, their comment and their browser's user agent
// to a company the reader has no relationship with. That is not a side effect to be
// tucked into a settings screen — it is the feature, and the site owner inherits a
// disclosure obligation the moment they enable it. So the seam is off by default,
// it is off on every one-click deploy, and the text that turns it on says what is
// sent before it says how (README.md, .dev.vars.example).
//
// Two properties make the seam safe to hand to a stranger's deployment:
//
//   - **It can only ever hold a comment for review.** There is no reject branch in
//     this file. See `providerLayer`.
//   - **Every failure is an abstention.** A provider that is down, suspended,
//     misconfigured, slow, or throwing produces `null` — the same answer as a
//     provider that had no opinion. Nobody loses a comment because a third party
//     had a bad day.
//
// Enforced by test/worker/spam/provider.test.ts.

import { clientIp } from './ip'
// The link is built from the owner's site URL and the derived key, never from the URL a
// comment reported — see `permalinkFor`. The queue card (#203) reuses it.
import { permalinkFor } from '../page-key'
import type { LayerOutcome, SpamLayer } from './layer'
import type { SpamCheckContext } from '../submit/spam'

/** The layer's name, as it appears in logs and in `comments.spam_reason`. */
export const PROVIDER_LAYER_NAME = 'provider'

/**
 * What a provider is told about one comment, and deliberately the whole of it.
 *
 * It is a flattened, provider-facing value rather than the `SpamCheckContext`, and
 * that is the seam doing its job: a provider cannot reach `db`, cannot read the raw
 * `form`, and cannot decide for itself what an untrusted field is worth. Adding a
 * field here is the edit that changes what leaves the Worker, so it is the edit
 * that has to change the disclosure text with it.
 * Enforced by test/worker/spam/akismet.test.ts.
 */
export interface ProviderSubmission {
  authorName: string
  /** Present only when the reader actually typed one; the field is optional (#7). */
  authorEmail?: string
  body: string
  /** Whether this is a top-level comment or a reply, which providers categorise on. */
  kind: 'comment' | 'reply'
  /**
   * The commenter's address as Cloudflare reported it — the raw one, not the hash
   * layer 4 counts. It is here because providers require it, and it is the single
   * largest item in the disclosure.
   *
   * `null` when the request carried no `CF-Connecting-IP`. A provider that needs one
   * should abstain rather than guess.
   */
  ip: string | null
  userAgent: string | null
  referrer: string | null
  /**
   * The page the comment was posted on, built from `siteUrl` and the *derived* page
   * key — never from the submitted URL, whose origin is attacker-chosen
   * (src/page-key.ts). `null` when the thread is a `data-thread` id, which is not a
   * path and so names no page.
   * Enforced by test/worker/spam/provider.test.ts.
   */
  permalink: string | null
  /** The site this deployment takes comments for, as the owner configured it. */
  siteUrl: string
  /** Unix seconds, from the pipeline's clock rather than the wall clock. */
  now: number
}

/**
 * What a provider concluded.
 *
 * `blatant-spam` is kept apart from `spam` because Akismet distinguishes them
 * (`X-akismet-pro-tip: discard`) and a moderator triaging a queue can use the
 * difference. It does **not** buy a stronger action here — see `providerLayer`.
 *
 * `unknown` is the answer to every failure, and it is a real answer rather than an
 * error: it says the provider did not tell us anything, which is exactly what the
 * layer does with a provider that is switched off.
 */
export type ProviderVerdict = 'spam' | 'blatant-spam' | 'ham' | 'unknown'

/**
 * One third-party spam service.
 *
 * `check` **never rejects**: a provider reports `unknown` for its own failures, so
 * the layer above it has no error path to get wrong. That is a contract rather than
 * a convention, and `providerLayer` catches anyway — see there.
 */
export interface SpamProvider {
  /** Short, stable, and safe to log — it names the provider, never the comment. */
  readonly name: string
  check(submission: ProviderSubmission): Promise<ProviderVerdict>
}

export interface ProviderLayerConfig {
  /** `null` is the default state of every deployment: nobody has opted in. */
  provider: SpamProvider | null
  /** The site this deployment takes comments for. Absent when nothing is configured. */
  siteUrl?: string
}

/**
 * Builds layer 8 from whichever provider the owner enabled, or from none.
 *
 * **It can only hold a comment for review, and that is what makes it affordable.**
 * The reasoning is a loop that closes, and each half needs the other:
 *
 *   - A provider is a third party's probabilistic judgement about someone else's
 *     site. Layer 7 already refuses to reject on a probability (src/spam/classifier.ts)
 *     for a reason that applies here with more force, not less: a false positive
 *     destroys a real person's comment, a rejected comment is never stored, and the
 *     moderator never learns it happened. The judgement is not even ours to inspect.
 *   - Because it never rejects, it can be `reviewOnly` — and `reviewOnly` is what
 *     bounds the meter. `runLayers` keeps the *first* review's reason, so once any
 *     layer has held a comment, a review-only layer's answer is discarded whatever
 *     it is. Akismet's paid tier allows **500 checks a month**
 *     (https://akismet.com/pricing/, checked 2026-07-29), so a check spent on a
 *     discarded answer is 0.2% of a site's monthly allowance bought by an
 *     unauthenticated caller. #10 found exactly this bug on layer 7, where the
 *     budget was 10,000 neurons a day; here the budget is three orders of magnitude
 *     smaller and resets thirty times more slowly.
 *
 * Reading it the other way is what settles the tempting exception. Acting on
 * Akismet's `discard` pro-tip would mean this layer can reject, which would mean it
 * cannot be `reviewOnly`, which would mean **every already-held comment spends a
 * metered check nobody reads**. The pro-tip is worth one click of a moderator's
 * time; `reviewOnly` is worth the site's allowance. It is not close.
 * Enforced by test/worker/spam/provider.test.ts and test/worker/spam/order.test.ts.
 */
export function providerLayer(config: ProviderLayerConfig): SpamLayer {
  const { provider, siteUrl } = config

  return {
    name: PROVIDER_LAYER_NAME,
    // Its strongest answer is `review`, and it is the most expensive layer in the
    // pipeline. See above, and `SpamLayer.reviewOnly`.
    reviewOnly: true,
    async run(context: SpamCheckContext): Promise<LayerOutcome> {
      // Off by default, and the abstention is the common case rather than an edge
      // one: no one-click deploy configures a provider, and most deployments never
      // will. Nothing is announced here — an announcement would be a nag about the
      // one feature this project does not push. A *half*-configured provider does
      // announce, from the adapter that could not be built (src/spam/akismet.ts).
      if (provider === null || siteUrl === undefined) return null

      // Total, for the reason src/spam/classifier.ts gives: `runLayers` does not
      // catch, so a layer that threw would turn a reader's comment into a 500. A
      // provider promises never to reject, and this is what makes it true rather
      // than merely documented — third-party adapters are exactly the code where an
      // unhandled path survives longest.
      // Enforced by test/worker/spam/provider.test.ts.
      let verdict: ProviderVerdict
      try {
        verdict = await provider.check(submissionFor(context, siteUrl))
      } catch (error) {
        console.error(`spam provider ${provider.name}: check failed`, error)
        return null
      }

      // **`unknown` and `ham` part company here, and that is #189.** They were one
      // answer until a verb existed for the difference. `unknown` is every failure
      // this seam has — a wrong key, a 500, a timeout, a body that did not parse,
      // and a provider switched off — so it must stay `null`: none of those is
      // evidence that a comment is clean, and a third party's outage must never be
      // able to start publishing strangers' comments.
      // Enforced by test/worker/spam/vouch.test.ts.
      if (verdict === 'unknown') return null

      // `ham` is the opposite: a real corpus asked and answered. It is still not a
      // veto — `runLayers` lets any doubt from any layer beat it — and on its own it
      // changes nothing, because the default policy acts on neither this nor `allow`.
      if (verdict === 'ham') return { action: 'vouch', reason: provider.name }

      // **No reject branch, at either strength.** See the doc comment above.
      return {
        action: 'review',
        reason: verdict === 'blatant-spam' ? `${provider.name}-discard` : provider.name,
      }
    },
  }
}

/**
 * Flattens the pipeline's context into the value a provider sees — which is the
 * point where "what leaves the Worker" is decided, and therefore where the list in
 * README.md and .dev.vars.example has to stay true.
 *
 * Built field by field rather than spread from `context`, following
 * src/notify/resend.ts: a field added to `SpamCheckContext` or to
 * `ValidatedComment` must not be able to reach a third party by accident.
 * Enforced by test/worker/spam/provider.test.ts.
 */
function submissionFor(context: SpamCheckContext, siteUrl: string): ProviderSubmission {
  const submission: ProviderSubmission = {
    authorName: context.comment.authorName,
    body: context.comment.body,
    kind: context.comment.parentId === undefined ? 'comment' : 'reply',
    ip: clientIp(context.request),
    userAgent: header(context.request, 'user-agent'),
    referrer: header(context.request, 'referer'),
    permalink: permalinkFor(context.pageKey, siteUrl),
    siteUrl,
    now: context.now,
  }
  if (context.comment.authorEmail !== undefined) {
    submission.authorEmail = context.comment.authorEmail
  }
  return submission
}

function header(request: Request, name: string): string | null {
  const value = request.headers.get(name)?.trim()
  return value === undefined || value === '' ? null : value
}
