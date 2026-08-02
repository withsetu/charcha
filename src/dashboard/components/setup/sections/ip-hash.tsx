import { DOCS, HowToSet, Off, On, OutboundLink, Section, SecretRow } from '../primitives'

/**
 * The per-IP rate limit's key, and the one thing that reports whether it is running.
 *
 * One status line either way (#216). What the secret is for, why an unkeyed hash would be
 * reversible, and which half of the limit still runs without it are all on the page the
 * line links to; what stays here is this deployment's answer and the value to generate.
 */
export function IpHashSection({ set }: { set: boolean }) {
  return (
    <Section title="Per-commenter rate limiting" status={set ? <On /> : <Off />}>
      <p>
        {set ? (
          <>
            <code>IP_HASH_SECRET</code> is set, so repeat comments are counted per commenter against
            a hash that cannot be turned back into an address.
          </>
        ) : (
          <>
            <code>IP_HASH_SECRET</code> is not set, so the per-IP half of rate limiting abstains:
            one address can comment as often as it likes, bounded only by the per-thread limit,
            which still runs. Any long random value will do — <code>openssl rand -hex 32</code> —
            but it is the only thing standing between the stored hashes and a map of who commented
            from where, so generate one rather than choosing it.
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
