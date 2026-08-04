import { DOCS, HowToSet, Off, On, OutboundLink, Section, SecretRow } from '../primitives'

/**
 * The third-party spam service (#11) — the one feature that sends anything about a reader
 * anywhere, and the only section here whose `Off` is the state to be pleased about.
 *
 * **The full disclosure is one click away rather than on this screen, and #216 is the
 * correction that put it there.** CLAUDE.md's rule is that a UI *enabling* a provider
 * states what is sent and to whom before the toggle. There is no toggle here — the key is
 * a secret, so this section can only report — and the screen an owner actually decides on
 * is charcha.dev's, which is where the whole field list, the recipient and the paragraph
 * they owe their privacy notice belong, at length. What stays is the recipient and the two
 * fields nobody expects to be sent, in both states, and a link whose text promises the
 * rest.
 * Enforced by test/dashboard/setup.test.tsx.
 */
export function SpamServiceSection({ set }: { set: boolean }) {
  return (
    <Section title="Third-party spam service" status={set ? <On /> : <Off />}>
      <p>
        {set ? (
          <>
            Comments the local layers could not settle go to Akismet, at Automattic — with the
            commenter’s IP address, and their email address if they gave one.
          </>
        ) : (
          <>
            Not connected, so nothing about your readers leaves this deployment. Akismet would send
            the comment, the commenter’s IP address, and their email address if they gave one, to
            Automattic.
          </>
        )}{' '}
        <OutboundLink href={DOCS.spamProviders}>
          {set
            ? 'Everything it sends, and the paragraph you owe your readers'
            : 'What it would send'}
        </OutboundLink>
        .
      </p>
      {!set && (
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
