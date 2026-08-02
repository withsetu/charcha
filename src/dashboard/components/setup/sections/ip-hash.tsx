import { HowToSet, Off, On, Section, SecretRow } from '../primitives'

/** The per-IP rate limit's key, and the one thing that reports whether it is running. */
export function IpHashSection({ set }: { set: boolean }) {
  return (
    <Section title="Per-commenter rate limiting" status={set ? <On /> : <Off />}>
      {set ? (
        <p>
          <code>IP_HASH_SECRET</code> is set, so repeat comments are counted per commenter against a
          hash that cannot be turned back into an address.
        </p>
      ) : (
        <>
          <p>
            The per-IP half of rate limiting abstains: one address can post as often as it likes,
            bounded only by the per-thread limit, which still runs. Nothing on your site says so —
            the Worker writes one line to its log about it, which you would have to be tailing to
            see.
          </p>
          <ul className="space-y-1">
            <SecretRow name="IP_HASH_SECRET" set={false} />
          </ul>
          <p>
            Any long random value will do — <code>openssl rand -hex 32</code>, the same line the
            README and the deploy form give for it. It is the only thing standing between the stored
            hashes and a map of who commented from where, so it is per deployment and worth
            generating rather than choosing.
          </p>
          <HowToSet names={['IP_HASH_SECRET']} />
        </>
      )}
    </Section>
  )
}
