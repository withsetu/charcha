import { TriangleAlertIcon } from 'lucide-react'

import type { Settings } from '../../../api'
import { servedBySecret } from '../../../api'
import { Alert, AlertDescription, AlertTitle } from '../../../ui/alert'
import { Badge } from '../../../ui/badge'
import { DOCS, OutboundLink, Section } from '../primitives'

/**
 * Whether this deployment has told Charcha which addresses are the owner's (#224).
 *
 * **The site address counts even when the field is empty**, because a deployment still
 * running on the deprecated `CHARCHA_SITE_URL` secret has a working value the dashboard
 * refuses to print (#207). Without this clause the loudest warning on the screen would be
 * shown to a deployment that is accepting comments perfectly well — which is the
 * comment-that-suppresses-the-check failure aimed at a warning instead of a comment.
 *
 * **"Perfectly well" is a claim about the Worker and it has to stay true there.** Both
 * gates resolve that secret — the reported-address check through `readSiteSettings` and the
 * browser check through `readDeclaredOrigins` — which is asserted by
 * test/worker/submit/declared-origin.test.ts. A change that dropped the fallback from
 * either one would make this clause hide a deployment that really is refusing everything.
 * Enforced by test/dashboard/setup.test.tsx.
 */
export function hasDeclaredAddress(settings: Settings): boolean {
  return (
    settings.allowedOrigins.length > 0 ||
    settings.siteUrl !== '' ||
    servedBySecret(settings, 'site_url')
  )
}

/**
 * The one state in which this deployment accepts no comments at all (#224).
 *
 * **Why a deployment can be in that state, and why saying so is the whole feature.** A
 * comment's address is whatever the page reported, so Charcha checks it against the
 * addresses the owner declared — and a deployment that has declared none has nothing to
 * check against and refuses everything but its own pages. Fail closed, card rule 5.
 *
 * That is only defensible because of this notice. #57 was not "a deployment refused
 * comments"; #57 was a deployment that refused comments and **explained nothing**, whose
 * owner went looking for the setting, found Turnstile's hostname screen, and had no way to
 * tell they were in the wrong product. So this is the first thing on the tab, above the
 * password and above every optional feature, in the register the short-password warning
 * uses — and it names exactly one action.
 *
 * **It disappears the moment an address is declared** (#158's no-nagging rule): a
 * deployment that has been set up finds nothing here at all, not a green tick and not a
 * reassurance. Three sentences and a link is the whole of it (#216) — the reasoning above
 * is on charcha.dev, which is where reasoning goes.
 * Enforced by test/dashboard/setup.test.tsx.
 */
export function DeclaredAddressSection() {
  return (
    <Section
      title="No comments are being accepted"
      status={<Badge variant="destructive">Refusing</Badge>}
    >
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>Set your site’s address, below</AlertTitle>
        <AlertDescription>
          <p>
            Charcha only takes comments for an address you have told it is yours, and this
            deployment has none — so <b>every comment is being refused</b>, and nothing is being
            stored. Saving your site’s address fixes it.{' '}
            <OutboundLink href={DOCS.siteAddress}>Which addresses are accepted</OutboundLink>.
          </p>
        </AlertDescription>
      </Alert>
    </Section>
  )
}
