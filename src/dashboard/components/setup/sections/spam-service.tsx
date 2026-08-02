import { HowToSet, Off, On, Section, SecretRow } from '../primitives'

/**
 * The third-party spam service (#11), and the only section on this tab whose `On` state
 * is the one that needs the most words.
 *
 * Everywhere else here, `On` means a feature works and `Off` means it does not. This one
 * inverts that: `Off` is the private default — layers 1–7 run inside the Worker and
 * transmit nothing — and `On` means comment text, the commenter's address and their email
 * leave this deployment for somebody else's servers. CLAUDE.md requires that disclosure
 * to be plain and to sit where the feature is presented, so the `On` state spends its
 * length on what is sent rather than on congratulating the deployer.
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
      {set ? (
        <>
          <p>
            <code>AKISMET_API_KEY</code> is set, so comments the local layers could not decide are
            sent to Akismet to be checked.
          </p>
          <p>
            <b>What leaves this deployment:</b> the comment text and the name on it, the commenter’s
            email address if they typed one, their IP address, their browser’s user agent and
            referrer, and the address of the page they commented on. That is a disclosure you owe
            your readers — it is the one thing Charcha does that sends anything about them anywhere.
          </p>
          <p>
            It runs last, and only on comments the free local layers did not already settle, so a
            comment stopped earlier is never sent.
          </p>
        </>
      ) : (
        <>
          <p>
            No third-party service is connected, and nothing about your readers leaves this
            deployment. The seven local layers still run — they are what handles spam by default.
          </p>
          <ul className="space-y-1">
            <SecretRow name="AKISMET_API_KEY" set={false} />
          </ul>
          <p>
            Connecting one is a real trade rather than an upgrade: it would send comment text, email
            addresses and IP addresses to Akismet, and Akismet’s paid tier allows 500 checks a
            month. It is worth reading what it sends before turning it on.
          </p>
          <HowToSet names={['AKISMET_API_KEY']} />
        </>
      )}
    </Section>
  )
}
