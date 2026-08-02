import * as React from 'react'
import { LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'

import type { ApiFailure, ModerationPolicy, SetupReport, Settings } from '../../../api'
import { MODERATION_POLICIES, writeModerationPolicy } from '../../../api'
import { Alert, AlertDescription, AlertTitle } from '../../../ui/alert'
import { Label } from '../../../ui/label'
import { RadioGroup, RadioGroupItem } from '../../../ui/radio-group'
import { Skeleton } from '../../../ui/skeleton'
import { DASHBOARD_BUG, type Load, OutboundLink, ReadFailed, Section } from '../primitives'

/**
 * The long form of the moderation policy, including the retention window trust decays
 * with (#173).
 *
 * A second constant rather than reusing `README_URL`, because that one is the
 * *optional features* section and this is a setting rather than a secret — a link whose
 * text promises an explanation of retention and lands on `wrangler secret put` is the
 * kind of near-miss a reader blames themselves for.
 */
const MODERATION_README_URL =
  'https://github.com/withsetu/charcha#moderation-policy-and-what-already-approved-actually-means'

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
        A first comment is held, as always. After you approve it, that person’s later comments go
        straight onto the page. It is not a guess about the comment — it is your own decision,
        replayed.
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
 * **The copy's job is the identity, and it is the part an owner cannot check for
 * themselves.** "Someone you approved before" sounds like it means an email address, and
 * an email address on a Charcha comment is optional and unverified — so the paragraph
 * says outright that the address alone buys nothing and that the network has to match
 * too. An owner who believes it is the email would reasonably conclude the feature is
 * forgeable and either not use it or, worse, use it and be wrong about what it does.
 *
 * **It says what it does not cover, in the same place it is switched on.** A flagged
 * comment is still held, and marking a trusted person's comment as spam takes the trust
 * away — both are the answers to the first two questions an owner has, and neither is
 * discoverable from a radio button.
 *
 * **The `IP_HASH_SECRET` warning is the #107 case for this feature.** Without that secret
 * no address hash is stored, so half the identity does not exist and `trust-returning`
 * trusts nobody — a setting that reads as on and does nothing at all. It renders only
 * when the secret report says the secret is missing; when that report could not be read
 * the tab is already showing its own failure alert above, so nothing here is quietly
 * absent.
 * Enforced by test/dashboard/setup.test.tsx.
 */
export function ModerationSection({
  load,
  secrets,
  onExpired,
}: {
  load: Load<Settings>
  secrets: Load<SetupReport>
  onExpired: () => void
}) {
  // The server's answer to the last successful save, which is what the screen shows from
  // then on — not the value that was sent. `null` means nothing has been saved in this
  // session and the loaded value stands.
  const [saved, setSaved] = React.useState<ModerationPolicy | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState<ApiFailure | null>(null)
  const [announcement, setAnnouncement] = React.useState('')
  const groupName = React.useId()

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

  const policy = saved ?? load.value.moderationPolicy
  const ipHashMissing = secrets.kind === 'ready' && !secrets.value.secrets.IP_HASH_SECRET
  // The #107 case for `trust-vouched`, and it renders only once that policy is the one
  // chosen: nothing can produce a `vouch` without a provider, so the setting would read
  // as on and do nothing. Unlike `ipHashMissing` it is not a warning about a broken
  // deployment — a provider is opt-in and most never will — so it says what to connect
  // rather than what is wrong.
  const providerMissing =
    policy === 'trust-vouched' && secrets.kind === 'ready' && !secrets.value.secrets.AKISMET_API_KEY

  function choose(next: string) {
    if (busy) return
    // The union comes from the Worker's own module, so a value that is not one of these
    // cannot have come from the group above — but the handler is typed `string` by Radix
    // and this is a request that publishes comments, so it is checked rather than cast.
    if (!MODERATION_POLICIES.includes(next as ModerationPolicy)) return
    const chosen = next as ModerationPolicy

    setBusy(true)
    setFailure(null)
    setAnnouncement('')
    void writeModerationPolicy(chosen)
      .then((result) => {
        if (!result.ok) {
          if (result.failure.code === 'UNAUTHORIZED') {
            onExpired()
            return
          }
          setFailure(result.failure)
          return
        }
        // From the response, not from `chosen`: what this screen shows has to be what the
        // deployment will actually apply.
        setSaved(result.value.moderationPolicy)
        setAnnouncement('Moderation policy saved.')
      })
      .catch(() => {
        // src/dashboard/api.ts is documented never to reject, so reaching here is a bug
        // in the callback above. Reported anyway: a radio that moved and saved nothing,
        // silently, is the worst outcome this control has.
        setFailure(DASHBOARD_BUG)
      })
      .finally(() => {
        setBusy(false)
      })
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
        object to is held for you whatever is chosen here.
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

      {/* A status line rather than a toast: the save has no button to sit beside, and a
          screen-reader user moving the radio has to hear that it landed. */}
      <p className="sr-only" role="status">
        {announcement}
      </p>

      {failure !== null && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Not saved</AlertTitle>
          <AlertDescription>
            {/* The server's own sentence, verbatim: it names the value it refused. */}
            <p>{failure.message} The policy on this deployment is unchanged.</p>
          </AlertDescription>
        </Alert>
      )}

      <p>
        <b>“Approved before” is not an email address.</b> An email on a Charcha comment is optional
        and nobody verifies it, so anyone can type yours. A commenter counts as returning only when
        the address <i>and</i> the network they are commenting from both match a comment you
        approved — someone who knows a regular’s email address but is somewhere else gets held, the
        same as a stranger.
      </p>
      <p>
        Because the network half is a hash of an IP address, and{' '}
        <OutboundLink href={MODERATION_README_URL}>
          Charcha deletes those on a retention window
        </OutboundLink>
        , trust fades: someone who has not commented for longer than that window is held again, like
        anyone else. That is deliberate. It also means a household or an office sharing one
        connection can inherit each other’s standing if they also know the email address.
      </p>
      <p>
        <b>Marking a trusted person’s comment as spam takes it away.</b> Their next comment is held
        again, and stays held until you approve one of theirs. Deleting a comment does not do this —
        only Spam does, because only Spam is a judgement about the commenter.
      </p>

      {providerMissing && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>No spam service is connected, so nothing is being vouched for</AlertTitle>
          <AlertDescription>
            <p>
              This deployment has no <code>AKISMET_API_KEY</code> set, and a comment is only
              published early when a service you connected says it is clean. Until you connect one
              this setting behaves exactly like the option above it — nothing is published that
              would not have been.
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
              half of the identity does not exist. Choosing to trust returning commenters is allowed
              and will do nothing — every comment stays held — until that secret is set. The{' '}
              <b>Per-commenter rate limiting</b> section below has the command.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <p>
        Whichever you pick, the layer worth having is the bot check below — it is the only one that
        asks a browser to prove itself, and it runs before any of this. There is deliberately no
        “publish anything the spam layers allowed” option: those layers mostly measure the{' '}
        <i>absence</i> of something wrong, and passing them is not evidence a comment is real.
      </p>
    </Section>
  )
}
