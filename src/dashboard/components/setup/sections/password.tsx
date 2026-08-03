import { DOCS, HowToSet, OutboundLink, Section } from '../primitives'
import { Badge } from '../../../ui/badge'

/**
 * The source of the fifteen-character floor (#120), linked rather than asserted.
 *
 * A number in a warning about somebody's credential invites "says who", and the honest
 * answer is a citable one: "Verifiers and CSPs SHALL require passwords that are used as
 * a single-factor authentication mechanism to be a minimum of 15 characters in length"
 * (checked 2026-07-29).
 */
const NIST_PASSWORD_URL = 'https://pages.nist.gov/800-63-4/sp800-63b.html'

/**
 * The floor, restated because it cannot be imported.
 *
 * `MIN_DASHBOARD_PASSWORD_LENGTH` in src/admin/password.ts is where the number is
 * *decided*; this is a second copy, for the reason `SETUP_SECRETS` in ../../../api.ts
 * gives — that module names `Env` and imports Hono, neither of which exists in this
 * TypeScript project. It is interpolated into the copy rather than typed into a sentence,
 * because a warning that says "shorter than 15 characters" while the Worker uses a
 * different number is exactly the comment-that-suppresses-the-check failure, aimed at the
 * one screen an owner goes to to find out.
 *
 * The two copies are asserted equal by test/node/password-floor.test.ts, which reads both
 * files — the only cross-project check available when an import is not.
 */
const MIN_DASHBOARD_PASSWORD_LENGTH = 15

/**
 * The dashboard password, when it is shorter than the floor (#120).
 *
 * **Rendered only when there is something to say.** A permanent row saying the password is
 * fine would be a line that is never news, and one more place a credential is named beside
 * a status. A deployment with a generated password has no password section at all.
 *
 * **It warns and it never blocks**, because there is no reset and no second factor: a
 * floor enforced on the login would 401 every deployment already running on a short
 * password, permanently, delivered in a routine update. So the copy has to say plainly
 * that nothing has changed, and that replacing it signs the reader out — a warning missing
 * either is a worse warning. Both survive the #216 cut; the reasoning about why a length
 * check is only a length check is on charcha.dev.
 *
 * **Nothing here is a measurement.** The endpoint answers one boolean, so there is no
 * length, prefix or value on this side to render, and the copy invents none.
 * Enforced by test/dashboard/setup.test.tsx.
 */
export function DashboardPasswordSection() {
  return (
    <Section title="Dashboard password" status={<Badge>Short</Badge>}>
      <p>
        Shorter than the {MIN_DASHBOARD_PASSWORD_LENGTH} characters{' '}
        <OutboundLink href={NIST_PASSWORD_URL}>NIST requires</OutboundLink>, and it is the only
        credential this dashboard has. <b>Nothing has stopped working and nothing will</b> —
        replacing it with <code>openssl rand -base64 24</code> will{' '}
        <b>sign out every open session, including this one</b>.{' '}
        <OutboundLink href={DOCS.password}>Why there is no reset</OutboundLink>.
      </p>
      <HowToSet names={['CHARCHA_DASHBOARD_PASSWORD']} verb="Replace" />
    </Section>
  )
}
