// The Setup tab: what this deployment has been given, and how to finish it. Issue #158.
//
// **Why a tab and not a banner.** The owner's decision on #158, and the reason is room:
// each of these needs a sentence about what being off actually costs, and a checklist or
// a header status line has room for a tick. It is also where owner configuration will
// keep arriving, so it is a place rather than a notice.
//
// **It says what the root page must not, and the asymmetry is deliberate.** #145 removed
// exactly this kind of readout from `GET /`, because that address is public and is where
// a stranger following the deploy-success link lands. This surface is behind the
// dashboard password. Do not make the two consistent: `/` would start leaking, or this
// tab would go back to being unable to say anything worth reading. src/admin/setup.ts
// states the same rule at the endpoint.
//
// **Nothing here renders a secret, and nothing here can.** The endpoint answers
// booleans (src/admin/setup.ts), so there is no value on this side to mask, truncate or
// leak. A masked field would be worse than useless anyway — unproofreadable is what took
// them off the deploy form on #139.
//
// **It is not a settings editor for secrets, because a Worker cannot write its own.** A
// save button here would be a dead control. What it offers instead is the exact command
// and the exact dashboard path, because a deployer reads this in a browser and acts in a
// terminal — and several of them have neither a checkout nor wrangler, which is
// documented history on #57.
//
// **And it is not a nag.** A deployment with everything on finds no recommendation, no
// badge urging anything and no command to run — sections that only report. Not *short*
// ones: Turnstile keeps the two paragraphs about its sitekey in the `On` state, because
// #104 is invisible from here and has to stay readable on a deployment that looks
// finished.
//
// **This file is now the panel and the composition order, and nothing else** (#197). One
// section per optional feature lives in ./setup/sections, and the pieces they share in
// ./setup/primitives.tsx. What is left here is the two reads, the state a save leaves
// behind, and the order — which is the load-bearing part: #174 puts Turnstile first and
// #158 says the whole thing stays quiet when everything is configured, and
// test/dashboard/setup.test.tsx asserts the exact heading sequence that results.
//
// Enforced by test/dashboard/setup.test.tsx.

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
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {/*
          The badge words are deliberately not marked up here. An `<b>Off</b>` in this
          sentence is an element whose whole text is "Off", which is what the badges are —
          so it joins them in every `getAllByText('Off')` and quietly inflates the count
          the tests use to assert how many features are switched off.
        */}
        What this deployment has been given, and what it has not. Everything below carrying an On or
        Off badge is optional. The parts that are <em>credentials</em> cannot be set from this
        screen, because a Worker cannot write its own secrets; every setting is edited here.
      </p>

      {/*
        The password keeps the top when it has something to say — a credential every
        destructive action goes through outranks a policy. It is lifted out of the
        `ready` block below so that the moderation policy can follow it without waiting
        on a read it does not use.
      */}
      {secrets.kind === 'ready' && secrets.value.shortPassword && <DashboardPasswordSection />}

      {/*
        Then the moderation policy, above the optional features because it is not one of
        them: it is the rule every comment on the site is decided by, and the only setting
        on this tab that can put a comment in front of readers without the owner. Its own
        copy points down to Turnstile rather than being placed after it, so the reading
        order still opens on the decision.

        It renders on its own read, so a `setup` failure leaves the one editable policy on
        this tab reachable rather than taking it down with the five sections that do
        depend on it.
      */}
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
          {/*
            Turnstile leads the optional sections, because it is the one this tab
            recommends (#174) and reading order is the only prominence a tab of equal
            sections has to give.

            What being first costs a configured deployment is honestly not nothing: this
            section keeps two paragraphs in its `On` state, because #104's asymmetry has
            to be readable on a deployment that looks finished, so a finished tab now
            opens on its longest quiet section. That is the trade, and it is worth
            stating rather than describing this as free. What it does not do is nag —
            the recommendation, the badge and the command are all gone by then.
          */}
          <TurnstileSection set={secrets.value.secrets.TURNSTILE_SECRET_KEY} />
          <EmailSection
            secrets={secrets.value.secrets}
            settings={settings}
            onExpired={onExpired}
            onSaved={setSaved}
          />
          <IpHashSection set={secrets.value.secrets.IP_HASH_SECRET} />
          {/*
            The two spam layers that have something to report, in the order the pipeline
            runs them: the classifier is layer 7 and the third-party service is layer 8
            (CLAUDE.md). That is also the privacy ordering — the classifier runs inside
            this deployment and transmits nothing, and the section under it is the only
            feature in Charcha that sends anything about a reader anywhere. The other way
            round would put the disclosure before the thing it is a trade against.

            It is the one section here with no secret behind it: layer 7 needs no
            configuration at all, which is exactly why nothing on this screen could say
            whether it was running (#177).
          */}
          <ClassifierSection report={secrets.value.classifier} />
          {/*
            Last, deliberately. Reading order is this tab's only prominence, and the ones
            above are things a deployer is being encouraged to switch on; this is the one
            whose default — off — is the recommendation.
          */}
          <SpamServiceSection set={secrets.value.secrets.AKISMET_API_KEY} />
        </>
      )}

      {/*
        The two "which addresses are yours" settings, together and last. They are the same
        kind of statement — the owner naming their own site — which is the argument #207
        made for `site_url` being a row at all; putting them apart would leave a reader
        wondering which of the two the comment box actually checks. The allowlist keeps
        the final position it has held since #158.
      */}
      <SiteAddressSection load={settings} onExpired={onExpired} onSaved={setSaved} />
      <OriginsSection load={settings} onEdit={onEditOrigins} />
      {/*
        No "the longer version is in the README" line at the foot any more (#216). Every
        section links to the page that carries its own long version, which is a link a
        reader follows from where the question occurred to them rather than one they scroll
        past on the way out.
      */}
    </div>
  )
}
