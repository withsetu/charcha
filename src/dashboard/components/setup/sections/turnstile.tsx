import {
  DOCS,
  HowToSet,
  Off,
  On,
  OutboundLink,
  Recommended,
  Section,
  SecretRow,
} from '../primitives'

/**
 * Turnstile, whose two halves are set in two different places, and the one item on this
 * tab that is recommended rather than merely reported (#174).
 *
 * **The sitekey paragraph is shown whether or not the secret is set, and that is the
 * whole reason this section is on the tab.** Charcha cannot see the site's pages, so it
 * cannot tell a correctly configured deployment from #104 — a secret with no
 * `data-turnstile-sitekey` anywhere, where every comment arrived with no token and was
 * held. This is the screen on which somebody would find that out.
 *
 * **It also sits above the command block rather than below it, and that ordering is
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
 * only one that asks for evidence. The claim is scoped to the layers that judge a comment
 * deliberately: layer 4 is rate limiting (src/spam/index.ts), which bounds how many
 * comments arrive rather than judging any one of them.
 *
 * **Seven paragraphs became two (#216).** What went is the argument at length — why the
 * absence of something wrong is not evidence, what pre-clearance would store, what a
 * widget costs — all of which charcha.dev carries better. What stayed is this
 * deployment's answer, the trap that answer cannot see, and the command.
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
        <p>
          The invisible bot check is off, and it is the layer worth having: every other layer that
          judges a comment measures the absence of something wrong, and a script written for this
          form passes all of them. Rate limiting bounds how many arrive, not whether any one of them
          is real. It is free and unmetered on the Cloudflare account you already have, and it is
          also the one thing Charcha can put a third party into a reader’s browser — Cloudflare’s
          widget, in an iframe on <code>challenges.cloudflare.com</code>.{' '}
          <OutboundLink href={DOCS.turnstile}>What it does, before you switch it on</OutboundLink>.
        </p>
      )}
      {/*
        Shown in both states, and the two halves are not symmetrical — saying so is the
        point, because only one of them is #104. The named reason is the one this queue
        actually shows: `runLayers` prefixes the layer (src/spam/layer.ts) and
        `runSubmission` stores the result on the comment, asserted by
        test/worker/submit/pipeline.test.ts and test/worker/spam/turnstile.test.ts.

        **It states a fact and gives no instruction, and that is the line between this and
        a nag.** How to obtain a widget is in the `!set` branch below: telling a deployment
        that already has the secret to go and create one is exactly what #158 rules out,
        and this is the first section a finished tab opens on.
      */}
      <p>
        <b>The other half is on your site, not here.</b> A widget has two keys and they are not
        interchangeable: the <i>sitekey</i> is public and goes on your page as{' '}
        <code>data-turnstile-sitekey</code>, and the secret key goes on this Worker. Charcha cannot
        see your pages, so set both or neither — a secret key with no sitekey holds every comment
        for review, marked <code>turnstile: no-token-unverified-deployment</code>, while a sitekey
        with no secret key is the harmless direction.
      </p>
      {!set && (
        <>
          <ul className="space-y-1">
            <SecretRow name="TURNSTILE_SECRET_KEY" set={false} />
          </ul>
          <p>
            Create a widget at <b>Cloudflare dashboard</b> → <b>Turnstile</b> → <b>Add widget</b>.
            It hands you both: the sitekey for your page, and the secret key below.
          </p>
          <HowToSet names={['TURNSTILE_SECRET_KEY']} />
        </>
      )}
    </Section>
  )
}
