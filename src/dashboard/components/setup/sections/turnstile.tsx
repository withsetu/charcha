import { HowToSet, Off, On, Recommended, Section, SecretRow } from '../primitives'

/**
 * Turnstile, whose two halves are set in two different places, and the one item on this
 * tab that is recommended rather than merely reported (#174).
 *
 * **The sitekey paragraphs are shown whether or not the secret is set, and that is the
 * whole reason this section is on the tab.** Charcha cannot see the site's pages, so it
 * cannot tell a correctly configured deployment from #104 — a secret with no
 * `data-turnstile-sitekey` anywhere, where every comment arrived with no token and was
 * held. This is the screen on which somebody would find that out.
 *
 * **They also sit above the command block rather than below it, and that ordering is
 * load-bearing rather than tidy.** #104 is what a *half-followed* recommendation
 * produces, so the surface doing the recommending is the surface most likely to cause
 * it: a reader who has been told this is worth doing starts on the command, and never
 * reaches a paragraph underneath it. Same reason the third-party disclosure stays above
 * the command — "what is sent and to whom, before the switch that turns it on" is a
 * product rule, and a recommendation is exactly the pressure that would push it down.
 * Enforced by test/dashboard/setup.test.tsx.
 *
 * **The argument is in the copy, not in the badge.** *Recommended* on its own is taste;
 * what earns it is the fact that separates this layer from the ones that judge a comment.
 * The honeypot, the timing floor and the content heuristics all measure the absence of
 * something wrong, and a script written for this form passes all three. Turnstile is the
 * only one that asks for evidence. The claim is scoped to those three deliberately: layer
 * 4 is rate limiting (src/spam/index.ts), which bounds how many comments arrive rather
 * than judging any one of them, so "every other layer" would be false.
 *
 * The free-and-unmetered claim is Cloudflare's, and CLAUDE.md's verified-facts table is
 * where it is recorded with its date: https://developers.cloudflare.com/turnstile/plans/
 */
export function TurnstileSection({ set }: { set: boolean }) {
  return (
    <Section
      title="Turnstile bot check"
      status={
        set ? (
          <On />
        ) : (
          // Grouped, because the header row is `justify-between`: two loose children
          // there would space themselves across the whole row and the status badge
          // would stop lining up with the other sections' — which is the column a
          // reader scans down.
          <span className="flex items-center gap-2">
            <Recommended />
            <Off />
          </span>
        )
      }
    >
      {set ? (
        <p>
          <code>TURNSTILE_SECRET_KEY</code> is set, which is the half that lives here.
        </p>
      ) : (
        <>
          <p>
            The invisible bot check is off, and it is the layer worth having. Everything else that
            looks at a comment measures the absence of something wrong — a honeypot left empty, more
            than two seconds spent typing, not too many links — and a script written for this form
            passes all of it. Rate limiting bounds how many arrive, not whether any one of them is
            real. Turnstile is the only layer that asks for something a script cannot make up: a
            token from a browser that solved a real challenge. Without it, everything reaching your
            queue has only managed not to look wrong.
          </p>
          <p>
            It is free and unmetered, and it is on the Cloudflare account you already have —
            deploying Charcha needed one. One widget, and the two keys it gives you.
          </p>
          <p>
            It is also the one thing Charcha can put a third party into a reader’s browser — the
            widget is Cloudflare’s, in an iframe on <code>challenges.cloudflare.com</code> — so read
            what it does before turning it on. Charcha itself still stores nothing in a reader’s
            browser; Turnstile’s <i>pre-clearance</i> setting is the one that would, and it is off
            unless you switch it on yourself.
          </p>
        </>
      )}
      <p>
        <b>The other half is on your site, not here.</b> A widget has two keys and they are not
        interchangeable: the <i>sitekey</i> is public and goes on your page as{' '}
        <code>data-turnstile-sitekey</code>, and it is what puts the widget there. Charcha cannot
        see your pages, so nothing on this screen can tell you whether that is done.
      </p>
      {/*
        The two halves are not symmetrical, and saying so is the point: only one of them
        is #104. The named reason is the one this queue actually shows — `runLayers`
        prefixes the layer (src/spam/layer.ts) and `runSubmission` stores the result on
        the comment, asserted by test/worker/submit/pipeline.test.ts and
        test/worker/spam/turnstile.test.ts. An earlier version of this paragraph said
        "nothing anywhere saying why", which was the #162 class of drift: a signal the
        code goes out of its way to produce, documented as absent.
      */}
      <p>
        Set both or neither, and the two failures are not the same size. A secret key with no
        sitekey means every comment arrives with no token to check and is held for review — a queue
        filling with comments that look perfectly fine. What tells you it is this rather than a
        quiet week is the reason on each one: they arrive marked <b>Held</b>, with{' '}
        <code>turnstile: no-token-unverified-deployment</code> beside them. A sitekey with no secret
        key is the harmless direction: the widget renders, this layer abstains, and comments carry
        on as though Turnstile were off.
      </p>
      {!set && (
        <>
          <ul className="space-y-1">
            <SecretRow name="TURNSTILE_SECRET_KEY" set={false} />
          </ul>
          <p>
            Create a widget at <b>Cloudflare dashboard</b> → <b>Turnstile</b> → <b>Add widget</b>.
            It hands you both keys: the <i>secret key</i> is the one that goes below, and the
            sitekey is the one that goes on your page.
          </p>
          <HowToSet names={['TURNSTILE_SECRET_KEY']} />
        </>
      )}
    </Section>
  )
}
