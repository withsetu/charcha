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
 * Turnstile, and the one item on this tab that is recommended rather than merely reported
 * (#174).
 *
 * **The sitekey warning is what this section is for.** Charcha cannot see the site's
 * pages, so it cannot tell a correctly configured deployment from #104 — a secret key with
 * no `data-turnstile-sitekey` anywhere, where every comment arrives with no token and is
 * held. It renders in the `On` state, which is exactly where it is invisible otherwise; in
 * the `Off` state the widget route says the same thing while there is still something to
 * do about it.
 *
 * **What went in #216:** the argument for the layer at length, and the disclosure of what
 * Cloudflare's widget puts in a reader's browser. Both are on charcha.dev, which is the
 * page a reader is on when they decide to create a widget — this screen cannot create one.
 * The link's text promises the browser half rather than describing the layer, because card
 * rule 8 is the fact somebody comes here to check.
 * Enforced by test/dashboard/setup.test.tsx.
 *
 * The free claim is Cloudflare's, recorded with its date in CLAUDE.md's verified-facts
 * table: https://developers.cloudflare.com/turnstile/plans/
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
          // there would space themselves across the whole row and the status badge would
          // stop lining up with the other sections' — the column a reader scans down.
          <span className="flex items-center gap-2">
            <Recommended />
            <Off />
          </span>
        )
      }
    >
      {set ? (
        <>
          <p>
            <code>TURNSTILE_SECRET_KEY</code> is set, which is the half that lives here.{' '}
            <OutboundLink href={DOCS.turnstile}>What it puts in a reader’s browser</OutboundLink>.
          </p>
          {/*
            The trap, stated as a fact with no instruction — telling a deployment that
            already has the secret to go and create a widget is the nagging #158 rules out.
            The reason token is the one this queue actually shows: `runLayers` prefixes the
            layer (src/spam/layer.ts), asserted by test/worker/spam/turnstile.test.ts.
          */}
          <p>
            <b>Charcha cannot see your pages</b>, so if <code>data-turnstile-sitekey</code> is not
            on them every comment is held, marked{' '}
            <code>turnstile: no-token-unverified-deployment</code>.{' '}
            <OutboundLink href={DOCS.turnstileKeys}>Where each key goes</OutboundLink>.
          </p>
        </>
      ) : (
        <>
          <p>
            The invisible bot check, free on the Cloudflare account you already have, and the only
            layer that asks for evidence rather than measuring the absence of something wrong.{' '}
            <OutboundLink href={DOCS.turnstile}>What it puts in a reader’s browser</OutboundLink>.
          </p>
          <ul className="space-y-1">
            <SecretRow name="TURNSTILE_SECRET_KEY" set={false} />
          </ul>
          <p>
            Create a widget at <b>Cloudflare dashboard</b> → <b>Turnstile</b> → <b>Add widget</b>.
            It hands you both halves: the sitekey goes on your page as{' '}
            <code>data-turnstile-sitekey</code>, the secret key below. Set both or neither.
          </p>
          <HowToSet names={['TURNSTILE_SECRET_KEY']} />
        </>
      )}
    </Section>
  )
}
