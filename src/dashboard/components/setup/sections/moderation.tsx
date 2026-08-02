import * as React from 'react'
import { LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'

import type { ModerationPolicy, SetupReport, Settings } from '../../../api'
import { MODERATION_POLICIES, writeModerationPolicy } from '../../../api'
import { Alert, AlertDescription, AlertTitle } from '../../../ui/alert'
import { Label } from '../../../ui/label'
import { RadioGroup, RadioGroupItem } from '../../../ui/radio-group'
import { Skeleton } from '../../../ui/skeleton'
import { DOCS, type Load, OutboundLink, ReadFailed, Section, useSettingsSave } from '../primitives'

/**
 * The three policies, and what a reader needs before choosing one.
 *
 * The prose is the control here, not decoration on it. `hold-all` is what every
 * deployment already does, so its description is a confirmation; the other two change
 * what readers see without the owner, so each has to say what it acts on *before* the
 * radio it belongs to is chosen — the same ordering rule the third-party disclosure
 * follows.
 *
 * They are a ladder rather than a menu, and the copy has to carry that: `trust-vouched`
 * keeps doing what `trust-returning` does, which is why its description says "as well"
 * rather than describing a replacement (src/submit/pipeline.ts).
 *
 * **What "approved before" actually identifies is in this description rather than in a
 * paragraph below the group, and #216 is only half the reason.** Three paragraphs of
 * caveats under the radios were three paragraphs a reader who had already clicked would
 * never reach; the facts belong on the option they are true of. "Someone you approved
 * before" sounds like it means an email address, and an email address on a Charcha
 * comment is optional and unverified — an owner who believes that is what this checks
 * would reasonably conclude the feature is forgeable, and either not use it or, worse,
 * use it and be wrong about what it does.
 * Enforced by test/dashboard/setup.test.tsx.
 */
const POLICY_CHOICES: readonly {
  value: ModerationPolicy
  label: string
  description: React.ReactNode
}[] = [
  {
    value: 'hold-all',
    label: 'Hold every comment',
    description: (
      <>
        Nothing appears on your site until you approve it. This is the default and what this
        deployment has been doing.
      </>
    ),
  },
  {
    value: 'trust-returning',
    label: 'Trust a commenter you have approved before',
    description: (
      <>
        A first comment is held, as always; after you approve it, that person’s later comments go
        straight onto the page. <b>“Approved before” is not an email address.</b> Nobody verifies an
        email on a comment, so a commenter counts as returning only when the address <i>and</i> the
        network they are commenting from both match one you approved. Trust fades as stored address
        hashes are deleted, and marking a trusted person’s comment as spam takes it away.
      </>
    ),
  },
  {
    value: 'trust-vouched',
    label: 'Also publish comments your spam service says are clean',
    description: (
      <>
        Everything above, <i>and</i>: when a spam service you have connected checks a comment and
        comes back clean, it goes straight onto the page. Only a service saying so counts — a
        comment nothing happened to look wrong about is still held.
      </>
    ),
  },
]

/**
 * The moderation policy (#173) — the one setting on this tab that decides what readers
 * see, and the only door out of the queue that the seven spam layers do not have.
 *
 * **The `IP_HASH_SECRET` warning is the #107 case for this feature.** Without that secret
 * no address hash is stored, so half the identity does not exist and `trust-returning`
 * trusts nobody — a setting that reads as on and does nothing at all. It renders only
 * when the secret report says the secret is missing; when that report could not be read
 * the tab is showing its own failure alert further down the page, so nothing here is
 * quietly absent.
 *
 * **Ten paragraphs became four, and one of them is the radio descriptions (#216).** The
 * save is `useSettingsSave` now rather than a second copy of it: this section had grown
 * its own busy flag, its own failure alert and its own live region, which is three chances
 * for the one control on this tab that publishes comments to report a failure differently
 * from every other control on it.
 * Enforced by test/dashboard/setup.test.tsx.
 */
export function ModerationSection({
  load,
  secrets,
  onExpired,
  onSaved,
}: {
  load: Load<Settings>
  secrets: Load<SetupReport>
  onExpired: () => void
  onSaved: (settings: Settings) => void
}) {
  const groupName = React.useId()
  const { busy, save, status } = useSettingsSave(onExpired, onSaved, 'Moderation policy')

  if (load.kind === 'loading') {
    return (
      <Section title="Moderation policy" status={null}>
        <Skeleton className="h-3 w-3/5" />
      </Section>
    )
  }

  if (load.kind === 'failed') {
    return (
      <Section title="Moderation policy" status={null}>
        <ReadFailed what="Could not read the moderation policy" failure={load.failure} />
      </Section>
    )
  }

  // What the screen shows is the settings the panel is holding, which is the server's
  // answer to the last successful save — never the value that was sent.
  const policy = load.value.moderationPolicy
  const ipHashMissing = secrets.kind === 'ready' && !secrets.value.secrets.IP_HASH_SECRET
  // The #107 case for `trust-vouched`, and it renders only once that policy is the one
  // chosen: nothing can produce a `vouch` without a provider, so the setting would read
  // as on and do nothing. Unlike `ipHashMissing` it is not a warning about a broken
  // deployment — a provider is opt-in and most never will — so it says what to connect
  // rather than what is wrong.
  const providerMissing =
    policy === 'trust-vouched' && secrets.kind === 'ready' && !secrets.value.secrets.AKISMET_API_KEY

  function choose(next: string) {
    // The union comes from the Worker's own module, so a value that is not one of these
    // cannot have come from the group above — but the handler is typed `string` by Radix
    // and this is a request that publishes comments, so it is checked rather than cast.
    if (!MODERATION_POLICIES.includes(next as ModerationPolicy)) return
    const chosen = next as ModerationPolicy
    save(() => writeModerationPolicy(chosen))
  }

  return (
    <Section
      title="Moderation policy"
      status={
        busy ? (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
            Saving…
          </span>
        ) : null
      }
    >
      <p>
        What happens to a comment none of the spam layers objected to. Everything they <i>do</i>{' '}
        object to is held for you whatever is chosen here.{' '}
        {/* The link text has to promise the caveats as well as the choice: the page it
            lands on carries what each policy publishes *and* the two facts the middle
            option's description states without room to explain — how long trust lasts,
            and that a shared connection can pass it around. Naming only the choice would
            be the near-miss a reader blames themselves for. */}
        <OutboundLink href={DOCS.policy}>
          What each one publishes, and how long trust lasts
        </OutboundLink>
        .
      </p>

      <RadioGroup
        value={policy}
        onValueChange={choose}
        disabled={busy}
        aria-label="Moderation policy"
        className="gap-4"
      >
        {POLICY_CHOICES.map((choice) => (
          <div key={choice.value} className="flex items-start gap-3">
            <RadioGroupItem
              value={choice.value}
              id={`${groupName}-${choice.value}`}
              className="mt-1"
            />
            <div className="space-y-1">
              <Label
                htmlFor={`${groupName}-${choice.value}`}
                className="font-medium text-foreground"
              >
                {choice.label}
              </Label>
              <p>{choice.description}</p>
            </div>
          </div>
        ))}
      </RadioGroup>

      {status}

      {providerMissing && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>No spam service is connected, so nothing is being vouched for</AlertTitle>
          <AlertDescription>
            <p>
              This deployment has no <code>AKISMET_API_KEY</code> set, and a comment is only
              published early when a service you connected says it is clean. Until you connect one
              this setting behaves exactly like the option above it.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {ipHashMissing && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Nobody can be recognised on this deployment yet</AlertTitle>
          <AlertDescription>
            <p>
              <code>IP_HASH_SECRET</code> is not set, so no address hash is stored and the network
              half of the identity does not exist. Trusting returning commenters is allowed and will
              do nothing — every comment stays held — until that secret is set. The{' '}
              <b>Per-commenter rate limiting</b> section below has the command.
            </p>
          </AlertDescription>
        </Alert>
      )}
    </Section>
  )
}
