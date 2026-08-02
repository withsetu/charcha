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
 * TypeScript project. It is interpolated into the copy below rather than typed into a
 * sentence, because a warning that says "shorter than 15 characters" while the Worker
 * uses a different number is exactly the comment-that-suppresses-the-check failure,
 * aimed at the one screen an owner goes to to find out.
 *
 * The two copies are asserted equal by test/node/password-floor.test.ts, which reads
 * both files — the only cross-project check available when an import is not.
 */
const MIN_DASHBOARD_PASSWORD_LENGTH = 15

/**
 * The dashboard password, when it is shorter than the floor (#120).
 *
 * **Rendered only when there is something to say, and that is the design rather than
 * brevity.** A permanent row saying the password is fine would be a line that is never
 * news, and one more place a credential is named beside a status — the same argument
 * `REPORTED_SECRETS` makes for leaving the password off the list entirely. A deployment
 * with a generated password has no password section here at all.
 *
 * **It warns and it never blocks, because blocking would be a lockout.** There is no
 * reset, no second factor and no account: a floor enforced on the login would 401 every
 * deployment already running on a short password, permanently, delivered in a routine
 * update. So the copy's second job is to say plainly that nothing has changed, because a
 * warning about a credential reads as a threat to it otherwise.
 *
 * **Nothing here is a measurement.** The endpoint answers one boolean
 * (src/admin/setup.ts), so there is no length, prefix or value on this side to render —
 * and the copy does not invent one either: no "your 4-character password", no meter.
 * What it does disclose is the floor, to a reader who has already proved they hold the
 * password.
 *
 * Five paragraphs became two (#216). The floor's citation and the sign-out consequence
 * both stayed, because a warning that leaves either out is a worse warning; what went is
 * the reasoning about why a length check is only a length check, which charcha.dev now
 * carries.
 * Enforced by test/dashboard/setup.test.tsx.
 */
export function DashboardPasswordSection() {
  return (
    <Section title="Dashboard password" status={<Badge>Short</Badge>}>
      <p>
        Your <code>CHARCHA_DASHBOARD_PASSWORD</code> is shorter than the{' '}
        {MIN_DASHBOARD_PASSWORD_LENGTH} characters{' '}
        <OutboundLink href={NIST_PASSWORD_URL}>NIST states</OutboundLink> for a password used on its
        own. It is the only credential for this dashboard — no second user, no second factor and no
        reset — and everything behind it can approve, hide and delete comments on your site.
      </p>
      <p>
        <b>Nothing has stopped working and nothing will</b>: a deployment locked out of its own
        dashboard would have no way back in. Replace it with a generated value —{' '}
        <code>openssl rand -base64 24</code> — kept in a password manager, and expect that to{' '}
        <b>sign out every open session, including this one</b>.{' '}
        <OutboundLink href={DOCS.password}>Why there is no reset</OutboundLink>.
      </p>
      <HowToSet names={['CHARCHA_DASHBOARD_PASSWORD']} verb="Replace" />
    </Section>
  )
}
