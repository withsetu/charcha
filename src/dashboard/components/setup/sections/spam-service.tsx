import { DOCS, HowToSet, Off, On, OutboundLink, Section, SecretRow } from '../primitives'

/**
 * The third-party spam service (#11), and the only section on this tab whose `On` state
 * is the one that needs the most words.
 *
 * Everywhere else here, `On` means a feature works and `Off` means it does not. This one
 * inverts that: `Off` is the private default — layers 1–7 run inside the Worker and
 * transmit nothing — and `On` means comment text, the commenter's address and their email
 * leave this deployment for somebody else's servers.
 *
 * **Both states name what is sent, and #216 shortened neither.** CLAUDE.md's rule is that
 * a UI enabling a provider states what is sent and to whom *before* the toggle, so the
 * `Off` state is the one the rule is actually about — it is the state an owner is reading
 * when they decide. A link would have satisfied a reader who follows it and nobody else,
 * which is the one place on this tab where distilling a paragraph into a pointer is the
 * wrong trade. The `On` state then carries the full field list, because that is the
 * disclosure the owner owes their own readers and it has to be copyable from here.
 * Enforced by test/dashboard/setup.test.tsx.
 *
 * It is a report, not a switch: the key is a secret, so nothing here can enable it. What
 * this section is *for* is #189 — `trust-vouched` acts only on this provider's verdict,
 * so an owner choosing that policy needs somewhere on this tab that says whether one
 * exists at all.
 * Enforced by test/dashboard/setup.test.tsx.
 */
export function SpamServiceSection({ set }: { set: boolean }) {
  return (
    <Section title="Third-party spam service" status={set ? <On /> : <Off />}>
      <p>
        {set ? (
          <>
            <code>AKISMET_API_KEY</code> is set, so comments the seven local layers could not settle
            are sent to Akismet to be checked. A comment stopped earlier is never sent.
          </>
        ) : (
          <>
            No third-party service is connected, and nothing about your readers leaves this
            deployment. The seven local layers still run, and they are what handles spam by default.
            Connecting Akismet is a trade rather than an upgrade: it would send the comment text and
            the name on it, the commenter’s email address and their IP address to Automattic, which
            is a disclosure you would then owe your readers.
          </>
        )}{' '}
        <OutboundLink href={DOCS.spamProviders}>
          {set
            ? 'The paragraph this owes your privacy notice'
            : 'Everything it would send, and to whom'}
        </OutboundLink>
        .
      </p>
      {set ? (
        <p>
          <b>What leaves this deployment:</b> the comment text and the name on it, the commenter’s
          email address if they typed one, their IP address, their browser’s user agent and
          referrer, and the address of the page they commented on. That is a disclosure you owe your
          readers — it is the one thing Charcha does that sends anything about them anywhere.
        </p>
      ) : (
        <>
          <ul className="space-y-1">
            <SecretRow name="AKISMET_API_KEY" set={false} />
          </ul>
          <HowToSet names={['AKISMET_API_KEY']} />
        </>
      )}
    </Section>
  )
}
