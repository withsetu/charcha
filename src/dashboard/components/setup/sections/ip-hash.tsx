import { DOCS, HowToSet, Off, On, OutboundLink, Section, SecretRow } from '../primitives'

/**
 * The per-IP rate limit's key, and the one thing that reports whether it is running.
 *
 * One status line either way. What the secret is for, why an unkeyed hash would be
 * reversible, and which half of the limit still runs without it are all on the page the
 * line links to.
 */
export function IpHashSection({ set }: { set: boolean }) {
  return (
    <Section title="Per-commenter rate limiting" status={set ? <On /> : <Off />}>
      <p>
        {set ? (
          <>
            Repeat comments are counted per commenter, against a hash that cannot be turned back
            into an address.
          </>
        ) : (
          <>
            The per-IP half of rate limiting abstains, so one address can comment as often as it
            likes; the per-thread limit still runs. Generate a value rather than choosing one —{' '}
            <code>openssl rand -hex 32</code>.
          </>
        )}{' '}
        <OutboundLink href={DOCS.rateLimit}>What each half of the limit does</OutboundLink>.
      </p>
      {!set && (
        <>
          <ul className="space-y-1">
            <SecretRow name="IP_HASH_SECRET" set={false} />
          </ul>
          <HowToSet names={['IP_HASH_SECRET']} />
        </>
      )}
    </Section>
  )
}
