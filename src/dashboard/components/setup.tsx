// The Setup tab: what this deployment has been given, and how to finish it. Issue #158.
//
// **It is a status report, not a control panel, and #216 is the correction that follows
// from saying so.** Every secret here is set with wrangler or in the Cloudflare dashboard,
// because a Worker cannot write its own — so there is no toggle on this screen, and the
// long explanation of what each feature does belongs on the page where somebody decides to
// set it. charcha.dev carries all of it. What is left here is one line per section: this
// deployment's answer, the one thing to do about it, and a link.
//
// **It says what the root page must not.** #145 removed exactly this kind of readout from
// `GET /`, which is public. This surface is behind the dashboard password. Do not make the
// two consistent — src/admin/setup.ts states the same rule at the endpoint.
//
// **Nothing here renders a secret, and nothing here can**: the endpoint answers booleans.
//
// **And it is not a nag.** A deployment with everything on finds no recommendation, no
// badge urging anything and no command to run.
//
// This file is the panel and the composition order and nothing else (#197). The order is
// the load-bearing part — #174 puts Turnstile first, #158 says the tab stays quiet when
// everything is configured — and test/dashboard/setup.test.tsx asserts the heading
// sequence that results, along with the per-section paragraph ceiling #216 set.

import * as React from 'react'

import type { Settings } from '../api'
import { readSettings, readSetup } from '../api'
import { type Load, ReadFailed, SectionSkeleton, useLoad } from './setup/primitives'
import { ClassifierSection } from './setup/sections/classifier'
import { EmailSection } from './setup/sections/email'
import { IpHashSection } from './setup/sections/ip-hash'
import { ModerationSection } from './setup/sections/moderation'
import { OriginsSection } from './setup/sections/origins'
import { DashboardPasswordSection } from './setup/sections/password'
import { SiteAddressSection } from './setup/sections/site-address'
import { SpamServiceSection } from './setup/sections/spam-service'
import { TurnstileSection } from './setup/sections/turnstile'

export function Setup({
  onEditOrigins,
  onExpired,
  originsSavedAt,
}: {
  /** Opens the allowed-origins dialog the header already owns — one editor, not two. */
  onEditOrigins: () => void
  /** A 401 here means what it means everywhere else on this surface: the session is gone. */
  onExpired: () => void
  /**
   * Bumped by the dialog's last successful save, so the list below is re-read.
   *
   * The alternative is a panel showing the allowlist as it was before the owner edited
   * it, in the one place they came to check that the edit landed.
   */
  originsSavedAt: number
}) {
  // Two reads, landing independently: a settings failure must not hide the secret report
  // or the other way round, because either one alone is still worth the trip.
  const secrets = useLoad(readSetup, onExpired)
  const loaded = useLoad(readSettings, onExpired, originsSavedAt)

  // **What a save on this tab answered with, held here rather than re-read.** Four
  // sections now write settings and several of them read each other's — the email badge
  // depends on the notification rows, and the allowlist section on the origins dialog — so
  // a save has to update the whole tab's picture. The response body *is* that picture
  // (src/admin/settings.ts answers the same shape for a read and a write), so holding it
  // costs nothing and a second GET after every save would be one more request to fail
  // after the first had already succeeded.
  const [saved, setSaved] = React.useState<Settings | null>(null)
  const settings: Load<Settings> =
    saved !== null && loaded.kind === 'ready' ? { kind: 'ready', value: saved } : loaded

  // A fresh read supersedes anything a save left here: `originsSavedAt` bumps when the
  // origins dialog saves, and the value it answered with is newer than ours.
  React.useEffect(() => {
    setSaved(null)
  }, [originsSavedAt])

  return (
    // No preamble. It used to open by explaining what the On and Off badges meant and
    // which parts of the screen were editable, which is a paragraph the badges and the
    // controls under them say by being there (#216).
    <div className="space-y-4">
      {/* The password keeps the top when it has something to say: a credential every
          destructive action goes through outranks a policy. Lifted out of the `ready`
          block so the moderation policy does not wait on a read it does not use. */}
      {secrets.kind === 'ready' && secrets.value.shortPassword && <DashboardPasswordSection />}

      {/* Then the moderation policy, above the optional features because it is not one of
          them: it is the rule every comment is decided by, and the only setting here that
          can put one in front of readers without the owner. It renders on its own read, so
          a `setup` failure leaves it reachable. */}
      <ModerationSection
        load={settings}
        secrets={secrets}
        onExpired={onExpired}
        onSaved={setSaved}
      />

      {secrets.kind === 'loading' && (
        <>
          <p className="sr-only" role="status">
            Reading this deployment’s configuration.
          </p>
          <SectionSkeleton />
          <SectionSkeleton />
          <SectionSkeleton />
        </>
      )}

      {secrets.kind === 'failed' && (
        <ReadFailed what="Could not read what is configured" failure={secrets.failure} />
      )}

      {secrets.kind === 'ready' && (
        <>
          {/* Turnstile leads the optional sections, because it is the one this tab
              recommends (#174) and reading order is the only prominence a tab of equal
              sections has. It keeps its sitekey warning in the `On` state — #104 is
              invisible from here — but the recommendation and the command are gone by
              then, so a finished tab does not nag. */}
          <TurnstileSection set={secrets.value.secrets.TURNSTILE_SECRET_KEY} />
          <EmailSection
            secrets={secrets.value.secrets}
            settings={settings}
            onExpired={onExpired}
            onSaved={setSaved}
          />
          <IpHashSection set={secrets.value.secrets.IP_HASH_SECRET} />
          {/* The two spam layers that have something to report, in pipeline order: the
              classifier is layer 7 and runs inside this deployment, the provider is layer
              8 and is the only feature that sends anything about a reader anywhere. */}
          <ClassifierSection report={secrets.value.classifier} />
          {/* Last, deliberately: every section above is something a deployer is being
              encouraged to switch on, and this is the one whose default is off and whose
              default is the recommendation. */}
          <SpamServiceSection set={secrets.value.secrets.AKISMET_API_KEY} />
        </>
      )}

      {/* The two "which addresses are yours" settings, together and last: they are the
          same kind of statement, and apart they would leave a reader wondering which of
          the two the comment box actually checks. */}
      <SiteAddressSection load={settings} onExpired={onExpired} onSaved={setSaved} />
      <OriginsSection load={settings} onEdit={onEditOrigins} />
    </div>
  )
}
