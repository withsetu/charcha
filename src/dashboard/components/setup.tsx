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
// badge urging anything and no command to run — four sections that only report. Not
// four *short* ones: Turnstile keeps the two paragraphs about its sitekey in the `On`
// state, because #104 is invisible from here and has to stay readable on a deployment
// that looks finished.
//
// Enforced by test/dashboard/setup.test.tsx.

import * as React from 'react'
import { ExternalLinkIcon, GlobeIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'

import type {
  ApiFailure,
  ApiResult,
  ModerationPolicy,
  SetupReport,
  SetupSecret,
  Settings,
} from '../api'
import {
  MODERATION_POLICIES,
  readSettings,
  readSetup,
  writeModerationPolicy,
  servedBySecret,
  writeNotifySettings,
  writeSiteUrl,
} from '../api'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { RadioGroup, RadioGroupItem } from '../ui/radio-group'
import { Skeleton } from '../ui/skeleton'

/**
 * One request's outcome. `loading` and `failed` are separate states for the reason
 * site-settings.tsx gives: a panel that rendered an empty answer on a failed read would
 * tell an owner that a feature is off when in truth nothing could be read.
 */
type Load<T> =
  { kind: 'loading' } | { kind: 'failed'; failure: ApiFailure } | { kind: 'ready'; value: T }

const DASHBOARD_BUG: ApiFailure = {
  code: 'MALFORMED',
  message: 'Something went wrong in the dashboard. Reload the page and try again.',
  status: null,
}

/**
 * Runs one of the dashboard's reads and reports it as a `Load`.
 *
 * One hook rather than a `then`/`catch` per section, because the part worth getting
 * right is identical in both and is the sort of thing the second copy forgets: a 401
 * ends the session rather than being shown as a failed read, and a *rejection* — which
 * src/dashboard/api.ts is documented never to produce — still has to reach the screen,
 * because a skeleton that never resolves is an unreported failure.
 *
 * `read` has to be a stable reference or the effect refetches on every render; the two
 * callers pass module-level functions. `reloadKey` is what lets a caller ask for a fresh
 * read after something it knows about has changed.
 * Enforced by test/dashboard/setup.test.tsx.
 */
function useLoad<T>(
  read: () => Promise<ApiResult<T>>,
  onExpired: () => void,
  reloadKey = 0,
): Load<T> {
  const [state, setState] = React.useState<Load<T>>({ kind: 'loading' })

  React.useEffect(() => {
    setState({ kind: 'loading' })
    void read()
      .then((result) => {
        if (result.ok) {
          setState({ kind: 'ready', value: result.value })
          return
        }
        if (result.failure.code === 'UNAUTHORIZED') onExpired()
        else setState({ kind: 'failed', failure: result.failure })
      })
      .catch(() => {
        setState({ kind: 'failed', failure: DASHBOARD_BUG })
      })
  }, [read, onExpired, reloadKey])

  return state
}

/** Where the long form of every instruction below lives. */
const README_URL = 'https://github.com/withsetu/charcha#turning-on-the-optional-features'

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
 * *decided*; this is a second copy, for the reason `SETUP_SECRETS` in ../api.ts gives —
 * that module names `Env` and imports Hono, neither of which exists in this TypeScript
 * project. It is interpolated into the copy below rather than typed into a sentence,
 * because a warning that says "shorter than 15 characters" while the Worker uses a
 * different number is exactly the comment-that-suppresses-the-check failure, aimed at
 * the one screen an owner goes to to find out.
 *
 * The two copies are asserted equal by test/node/password-floor.test.ts, which reads
 * both files — the only cross-project check available when an import is not.
 */
const MIN_DASHBOARD_PASSWORD_LENGTH = 15

/**
 * The one secret email notifications still need (#207).
 *
 * It used to be three. The other two were the owner's own addresses rather than
 * credentials, so they are `settings` rows now and this section *edits* them instead of
 * telling the owner to open a terminal — see `NotifyFields` below.
 *
 * Still a list rather than a bare constant: it is what the command block and the status
 * row map over, and a second provider's key (#158 says not to hard-code Resend) joins it
 * here rather than by rewriting the section. Typed against `SetupSecret`, which is what
 * makes a rename on the Worker's side a type error here instead of a section that quietly
 * reports a feature it is no longer asking about.
 */
const EMAIL_SECRETS = ['RESEND_API_KEY'] as const satisfies readonly SetupSecret[]

/**
 * A name this tab can print a `wrangler secret put` line for.
 *
 * `SetupSecret` plus the dashboard password, which is not on that list because it is not
 * a feature switch — reaching this screen proves it is set (src/admin/setup.ts).
 *
 * A literal rather than free text, which is *intended* to make a typo obvious — but it
 * buys strictly less than the other five do, and the difference is worth knowing. Their
 * drift shows up at runtime, because `readSetup` validates every `SETUP_SECRETS` key and
 * a missing one becomes a visible `MALFORMED`. This name is outside that net: nothing
 * here ties it to `Env`, and the dashboard is a separate TypeScript project that cannot
 * import from `src/admin` (see the note on `SETUP_SECRETS` in ../api.ts). What catches a
 * rename of this one is `pnpm check:deploy`, which fails a secret `src/` reads that is in
 * neither `.dev.vars.example` nor README.md.
 */
type SettableSecret = SetupSecret | 'CHARCHA_DASHBOARD_PASSWORD'

/**
 * One section of the tab.
 *
 * A heading and a status word, never a status colour alone: "On" and "Off" are the whole
 * of the signal, and the badge's fill is decoration on top of it (WCAG 1.4.1).
 */
function Section({
  title,
  status,
  children,
}: {
  title: string
  status: React.ReactNode
  children: React.ReactNode
}) {
  const headingId = React.useId()
  return (
    <section aria-labelledby={headingId} className="rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-medium">
          {title}
        </h2>
        {status}
      </div>
      <div className="mt-2 space-y-3 text-sm text-muted-foreground">{children}</div>
    </section>
  )
}

/** Configured. Quiet on purpose — a finished deployment has nothing to read here. */
function On() {
  return <Badge variant="outline">On</Badge>
}

/** Not configured. The strong badge, because this is the line that has news in it. */
function Off() {
  return <Badge>Off</Badge>
}

/**
 * The one item on this tab worth going out of your way for (#174).
 *
 * **A second badge rather than a replacement for `Off`, because they answer different
 * questions.** *Off* is the state and *Recommended* is the advice; collapsing them into
 * one word would leave a reader working out from the absence of "On" whether the thing
 * is running. It sits before `Off` so the status badge keeps the right-hand edge it holds
 * in the sections below, which is the column a reader scans.
 *
 * **It renders only in the unconfigured state, and that is the whole of how this stays
 * inside #158's no-nagging rule.** A deployment that has already done this sees `On` and
 * a status line. Advice that survives being taken is a nag.
 * Enforced by test/dashboard/setup.test.tsx.
 */
function Recommended() {
  return <Badge variant="secondary">Recommended</Badge>
}

/**
 * The exact command, and the exact route for somebody who has no terminal.
 *
 * Both, always, and that is the point rather than thoroughness: the person most likely
 * to be reading this clicked a Deploy button, so they have no checkout, no wrangler and
 * no API token — which is how #57 stayed unfixable for its author, who owns this
 * project.
 */
function HowToSet({ names, verb = 'Set' }: { names: readonly SettableSecret[]; verb?: string }) {
  return (
    <div className="space-y-2">
      <p>
        {verb} {names.length === 1 ? 'it' : 'them'} from a checkout of your deployed repository:
      </p>
      {/*
        `tabIndex` so the block can be scrolled without a mouse when a narrow window
        clips it (WCAG 2.1.1) — and `role`/`aria-label` with it, because a focusable
        element with neither is a tab stop that announces nothing, which trades 2.1.1
        for 4.1.2 on the one piece of actionable content this tab has. The label is
        derived from `verb` and `names` — both of them — so it cannot describe a block it
        no longer matches, and cannot announce "set" over a block whose visible lead-in
        says "Replace".

        It is not an editable target, so the shortcut map still sees keystrokes that land
        in it — which on this tab is `1`–`4`, `?` and Escape, every one of them harmless.
        See the queue-command guard in triage.tsx.
      */}
      <pre
        tabIndex={0}
        role="region"
        aria-label={`Commands to ${verb.toLowerCase()} ${names.join(', ')}`}
        className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs text-foreground"
      >
        <code>{names.map((name) => `pnpm wrangler secret put ${name}`).join('\n')}</code>
      </pre>
      <p>
        Without a checkout, the Cloudflare dashboard sets the same names: <b>Workers &amp; Pages</b>{' '}
        → your Worker → <b>Settings</b> → <b>Variables and Secrets</b> → <b>Add</b>, with the type
        set to <b>Secret</b>, then <b>Deploy</b>. Either way it takes effect on the next request;
        there is nothing to redeploy here.
      </p>
    </div>
  )
}

/** One secret, and whether there is a value in it. Never what the value is. */
function SecretRow({ name, set }: { name: SetupSecret; set: boolean }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <code className="text-foreground">{name}</code>
      <span>{set ? 'Set' : 'Not set'}</span>
    </li>
  )
}

function ReadFailed({ what, failure }: { what: string; failure: ApiFailure }) {
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>{what}</AlertTitle>
      <AlertDescription>
        <p>{failure.message} Nothing on this deployment has been changed.</p>
      </AlertDescription>
    </Alert>
  )
}

function SectionSkeleton() {
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4 sm:p-5" aria-hidden="true">
      <Skeleton className="h-4 w-44" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-3/5" />
    </div>
  )
}

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
        Off badge is optional — a Charcha that takes comments and holds them for you needs none of
        it. The parts that are <em>credentials</em> cannot be set from this screen, because a Worker
        cannot write its own secrets; everything else — the moderation policy, your notification
        addresses, your site’s address and the allowed origins — is a setting, and settings are
        edited here.
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
        this tab reachable rather than taking it down with the four sections that do
        depend on it.
      */}
      <ModerationSection load={settings} secrets={secrets} onExpired={onExpired} />

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
            Turnstile leads the optional three, because it is the one this tab
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
            Last of the four, deliberately. Reading order is this tab's only prominence,
            and the three above are things a deployer is being encouraged to switch on;
            this is the one whose default — off — is the recommendation.
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

      <p className="text-sm text-muted-foreground">
        The longer version of all of this is in the README, under{' '}
        {/*
          `noreferrer` as well as `noopener`: the document is already served
          `referrer-policy: no-referrer` (src/dashboard/document.ts), and this says the
          same thing at the link so that a deployment behind a proxy that rewrites the
          header still does not hand a third party the address of a moderation dashboard.
        */}
        <a
          className="underline underline-offset-4 hover:text-foreground"
          href={README_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Turning on the optional features
          <ExternalLinkIcon aria-hidden="true" className="ml-1 inline size-3 align-baseline" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        .
      </p>
    </div>
  )
}

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
function ModerationSection({
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
        <a
          className="underline underline-offset-4 hover:text-foreground"
          href={MODERATION_README_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Charcha deletes those on a retention window
          <ExternalLinkIcon aria-hidden="true" className="ml-1 inline size-3 align-baseline" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
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
 * Enforced by test/dashboard/setup.test.tsx.
 */
function DashboardPasswordSection() {
  return (
    <Section title="Dashboard password" status={<Badge>Short</Badge>}>
      <p>
        Your <code>CHARCHA_DASHBOARD_PASSWORD</code> is shorter than {MIN_DASHBOARD_PASSWORD_LENGTH}{' '}
        characters. It is the only credential for this dashboard — no second user, no second factor
        and no reset — and everything behind it can approve, hide and delete comments on your site.
      </p>
      <p>
        <b>Nothing has stopped working and nothing will.</b> The password you have keeps working,
        today and after any update: a deployment locked out of its own dashboard would have no way
        back in, so Charcha will not do that to you. This screen is the only place that says
        anything about it at all.
      </p>
      <p>
        The minimum{' '}
        <a
          className="underline underline-offset-4 hover:text-foreground"
          href={NIST_PASSWORD_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          NIST states
          <ExternalLinkIcon aria-hidden="true" className="ml-1 inline size-3 align-baseline" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>{' '}
        for a password used on its own, without a second factor, is {MIN_DASHBOARD_PASSWORD_LENGTH}{' '}
        characters. It is a length check and only a length check: a long password that has been in a
        breach somewhere is no safer, and nothing here has looked. Generating a new one is what
        settles both.
      </p>
      <HowToSet names={['CHARCHA_DASHBOARD_PASSWORD']} verb="Replace" />
      <p>
        Use a generated value — <code>openssl rand -base64 24</code> — and keep it in a password
        manager. It is typed once and never from memory, so there is nothing to gain from a
        memorable one.
      </p>
      <p>
        Replacing it <b>signs out every open session, including this one</b>, because sessions are
        signed with a key derived from the password rather than stored. That is worth expecting
        rather than discovering: it is also the only way to sign out a session you no longer trust.
      </p>
    </Section>
  )
}

/**
 * A settings save, as one hook, because four controls on this tab now make one.
 *
 * **The `catch` is not defensive padding.** src/dashboard/api.ts is documented never to
 * reject, so reaching it is a bug in the callback — and a Save button that spun, stopped,
 * and saved nothing is the worst outcome a settings control has. CLAUDE.md's rule is that
 * every unawaited async owes the user a specific message; this is the one place four
 * controls pay it.
 *
 * `saved` is set from the **server's answer**, never from what was sent, so what the field
 * shows afterwards is what the deployment will actually apply — an address comes back
 * trimmed and a site URL comes back canonicalised, which is the feedback that teaches the
 * rule (the same argument site-settings.tsx makes for the allowlist).
 * Enforced by test/dashboard/setup.test.tsx.
 */
function useSettingsSave(onExpired: () => void, onSaved: (settings: Settings) => void) {
  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState<ApiFailure | null>(null)
  const [announcement, setAnnouncement] = React.useState('')

  function save(request: () => Promise<ApiResult<Settings>>) {
    if (busy) return
    setBusy(true)
    setFailure(null)
    setAnnouncement('')
    void request()
      .then((result) => {
        if (!result.ok) {
          if (result.failure.code === 'UNAUTHORIZED') onExpired()
          else setFailure(result.failure)
          return
        }
        onSaved(result.value)
        setAnnouncement('Saved.')
      })
      .catch(() => {
        setFailure(DASHBOARD_BUG)
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const status = (
    <>
      {/* A status line rather than a toast: these forms are inline on a scrolling tab, so
          there is nowhere a toast would reliably be seen, and a screen-reader user has to
          hear the save land. */}
      <p className="sr-only" role="status">
        {announcement}
      </p>
      {failure !== null && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Not saved</AlertTitle>
          <AlertDescription>
            {/* The server's own sentence, verbatim: it names the value it refused and,
                for a sender name, the character. Rewording it here would be a second set
                of rules that can drift from the ones the Worker enforces. */}
            <p>{failure.message} Nothing on this deployment has been changed.</p>
          </AlertDescription>
        </Alert>
      )}
    </>
  )

  return { busy, save, status, saveFailed: failure !== null }
}

/** One labelled text field, since this tab now has five of them. */
function Field({
  id,
  label,
  hint,
  value,
  onChange,
  disabled,
  invalid,
  placeholder,
  type = 'text',
}: {
  id: string
  label: string
  hint: React.ReactNode
  value: string
  onChange: (value: string) => void
  disabled: boolean
  invalid: boolean
  placeholder?: string
  type?: 'text' | 'email' | 'url'
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      />
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {hint}
      </p>
    </div>
  )
}

/**
 * One field of a settings body, or nothing at all when sending it would clear a row the
 * owner never filled in.
 *
 * See the call site in `NotifyFields` for why an empty box is not always an instruction.
 * Enforced by test/dashboard/setup.test.tsx.
 */
function omitUntyped(
  key: string,
  field: 'notifyFrom' | 'notifyTo',
  value: string,
  settings: Settings,
): Record<string, string> {
  if (value === '' && servedBySecret(settings, key)) return {}
  return { [field]: value }
}

/** The save button every settings form on this tab uses, so they cannot drift apart. */
function SaveRow({ busy, label }: { busy: boolean; label: string }) {
  return (
    <div className="flex justify-end">
      <Button type="submit" size="sm" disabled={busy}>
        {busy && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
        {busy ? 'Saving…' : label}
      </Button>
    </div>
  )
}

/**
 * Email notifications: one secret, and three settings the owner edits here (#207, #208).
 *
 * **What changed, and why it is the point of the section rather than a detail.** This used
 * to be three secrets and a `wrangler secret put` block. Two of the three were never
 * secrets — an address on a domain the owner verified, and their own inbox — so telling
 * them to open a terminal for those was asking for a checkout, wrangler and an API token
 * to change a value printed on their own site. They are rows now, and the section edits
 * them. The key is still a credential and is still read-only status plus instructions,
 * which is #158's line and it has not moved.
 *
 * The provider is named only where it is unavoidable — inside `RESEND_API_KEY`, which is
 * the string an owner has to type. The prose says "your email provider", so widening this
 * when a second provider lands is a change to the secret list rather than to the copy.
 *
 * **It is still all-or-nothing, and the badge says so from the resolved state**, not from
 * the rows: a deployment still running on the deprecated secrets is genuinely *on*, and a
 * tab that called it off would send its owner to reconfigure something that works.
 * Enforced by test/dashboard/setup.test.tsx.
 */
function EmailSection({
  secrets,
  settings,
  onExpired,
  onSaved,
}: {
  secrets: Record<SetupSecret, boolean>
  settings: Load<Settings>
  onExpired: () => void
  onSaved: (settings: Settings) => void
}) {
  const missing = EMAIL_SECRETS.filter((name) => !secrets[name])
  const value = settings.kind === 'ready' ? settings.value : null
  const legacy = value?.fromDeprecatedSecrets ?? []
  const hasFrom = (value?.notifyFrom ?? '') !== '' || legacy.includes('notify_from')
  const hasTo = (value?.notifyTo ?? '') !== '' || legacy.includes('notify_to')
  // Unknown until the settings read lands. `null` renders no badge rather than *Off*,
  // because "off" is a claim and a pending read is not one — the same rule the two
  // `Load` states everywhere else on this tab follow.
  const on = value === null ? null : missing.length === 0 && hasFrom && hasTo

  return (
    <Section title="Email notifications" status={on === null ? null : on ? <On /> : <Off />}>
      {on === true ? (
        <p>
          A short email to your inbox as comments arrive — up to five back to back, and then a
          slower rate, so a busy morning cannot spend a day’s sending allowance in ten minutes. The
          next email that does go out says how many arrived while it was quiet. The queue is the
          record either way: the email is a prompt to come and look, and it is never the thing that
          missed one.
        </p>
      ) : (
        <p>
          {missing.length === EMAIL_SECRETS.length && !hasFrom && !hasTo
            ? 'Nothing is emailed when a comment arrives. New comments still reach the queue, which is the only place they show up.'
            : 'Partly set up, so nothing is sent. The key and both addresses are needed together — a key with no recipient has nowhere to send, and Charcha holds no owner address anywhere to guess one from.'}
        </p>
      )}

      {missing.length > 0 && (
        <>
          <ul className="space-y-1">
            {EMAIL_SECRETS.map((name) => (
              <SecretRow key={name} name={name} set={secrets[name]} />
            ))}
          </ul>
          <p>
            The key is a credential, so it is the one part of this that cannot be set from here — a
            Worker cannot write its own secrets.
          </p>
          <HowToSet names={missing} />
        </>
      )}

      <NotifyFields load={settings} onExpired={onExpired} onSaved={onSaved} />
    </Section>
  )
}

/**
 * The three notification settings, as one form with one Save button.
 *
 * One request rather than three, because they are one decision: the two addresses are
 * useless apart, and a display name saved without the address it decorates would be a half
 * save the owner watched succeed. The body still carries only these three fields, so
 * saving here cannot overwrite the allowlist or the moderation policy edited in another
 * tab — the lost-update rule #173 established.
 *
 * **The sender name's rules are the server's, and this does not restate them.** A refusal
 * comes back naming the character it refused (src/admin/settings.ts), and that sentence is
 * what the owner reads. Copying the rules into the placeholder would be two lists that can
 * disagree, on the one field where being wrong writes a `From:` header.
 * Enforced by test/dashboard/setup.test.tsx.
 */
function NotifyFields({
  load,
  onExpired,
  onSaved,
}: {
  load: Load<Settings>
  onExpired: () => void
  onSaved: (settings: Settings) => void
}) {
  const [draft, setDraft] = React.useState<{ from: string; to: string; name: string } | null>(null)
  const ids = React.useId()
  const { busy, save, status, saveFailed } = useSettingsSave(onExpired, (settings) => {
    setDraft({
      from: settings.notifyFrom,
      to: settings.notifyTo,
      name: settings.notifyFromName,
    })
    onSaved(settings)
  })

  if (load.kind === 'loading') return <Skeleton className="h-3 w-3/5" />
  if (load.kind === 'failed') {
    return <ReadFailed what="Could not read the notification settings" failure={load.failure} />
  }

  // The loaded rows until the owner types, then their own edit, then whatever the server
  // answered with. Read here rather than in an effect so a settings re-read cannot
  // overwrite something half-typed.
  const fields = draft ?? {
    from: load.value.notifyFrom,
    to: load.value.notifyTo,
    name: load.value.notifyFromName,
  }
  const legacy = load.value.fromDeprecatedSecrets
  const usingSecrets = legacy.includes('notify_from') || legacy.includes('notify_to')

  function change(part: Partial<typeof fields>) {
    setDraft({ ...fields, ...part })
  }

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        // The document's CSP is `form-action 'none'`, so a real submission is refused by
        // the browser rather than merely unhandled — the same arrangement as the sign-in
        // form and the origins dialog.
        event.preventDefault()
        // **A field that is empty *and* being served by a deprecated secret is left out
        // of the body, not sent blank.** The endpoint clears a row for an empty string
        // and leaves an absent field alone, and these boxes are empty because this
        // surface refuses to render a secret's value — not because the owner emptied
        // them. Sending `''` here would write a row, kill the fallback, and stop the
        // notifications of a deployment that was working, with "Saved." on screen. Found
        // in review; it is the exact failure the fallback exists to prevent, arriving
        // through the screen that announces the fallback.
        //
        // The owner can still clear a value they *have* saved: once a row exists the key
        // is no longer in `fromDeprecatedSecrets`, so an empty field is an instruction
        // again.
        // Enforced by test/dashboard/setup.test.tsx.
        save(() =>
          writeNotifySettings({
            ...omitUntyped('notify_from', 'notifyFrom', fields.from, load.value),
            ...omitUntyped('notify_to', 'notifyTo', fields.to, load.value),
            notifyFromName: fields.name,
          }),
        )
      }}
    >
      {usingSecrets && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>These are still coming from secrets you set with wrangler</AlertTitle>
          <AlertDescription>
            <p>
              They keep working. The fields below are empty because nothing has been saved here yet
              — Charcha will not show you a value out of a secret. Type your addresses in and save,
              and you can then remove <code>CHARCHA_NOTIFY_FROM</code> and{' '}
              <code>CHARCHA_NOTIFY_TO</code> with <code>wrangler secret delete</code>.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <Field
        id={`${ids}-notify-to`}
        type="email"
        label="Send notifications to"
        placeholder="you@example.com"
        value={fields.to}
        disabled={busy}
        invalid={saveFailed}
        onChange={(next) => {
          change({ to: next })
        }}
        hint="Your own inbox. It is the only address Charcha ever mails, and clearing it is how you stop the emails — there is no unsubscribe link, because there is nobody to unsubscribe but you."
      />

      <Field
        id={`${ids}-notify-from`}
        type="email"
        label="Send them from"
        placeholder="comments@example.com"
        value={fields.from}
        disabled={busy}
        invalid={saveFailed}
        onChange={(next) => {
          change({ from: next })
        }}
        hint="Has to be on a domain verified with your email provider, under the same account as the key. Mail from an unverified domain is refused — and from your side that refusal looks exactly like the feature being switched off, so check it for typos before you save."
      />

      <Field
        id={`${ids}-notify-from-name`}
        label="Sender name (optional)"
        placeholder="Charcha"
        value={fields.name}
        disabled={busy}
        invalid={saveFailed}
        onChange={(next) => {
          change({ name: next })
        }}
        hint="What your mail client shows instead of the bare address. Leave it empty and the address is what you see. It goes in the From line, so it cannot contain angle brackets, quotes or an @ — a name that looks like an address is how a message pretends to be from somebody else."
      />

      {status}
      <SaveRow busy={busy} label="Save notification settings" />
    </form>
  )
}

/**
 * The site's own address (#207) — the setting that used to be `CHARCHA_SITE_URL`.
 *
 * **It is here because almost nobody had it, and that was the problem.** It was optional,
 * deliberately off the deploy form (#139), and the only thing that read it was a spam
 * layer that is also off by default — so a deployer had no reason to set it and no way to
 * learn it would ever buy them anything. A field beside the allowlist is where somebody
 * finds out.
 *
 * **No On/Off badge**, for the reason `OriginsSection` has none: an empty value is a
 * working default rather than a feature that is switched off. Nothing about this
 * deployment stops working without it; what it unlocks is named in the copy instead.
 * Enforced by test/dashboard/setup.test.tsx.
 */
function SiteAddressSection({
  load,
  onExpired,
  onSaved,
}: {
  load: Load<Settings>
  onExpired: () => void
  onSaved: (settings: Settings) => void
}) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const id = React.useId()
  const { busy, save, status, saveFailed } = useSettingsSave(onExpired, (settings) => {
    setDraft(settings.siteUrl)
    onSaved(settings)
  })

  return (
    <Section title="Your site’s address" status={null}>
      {load.kind === 'loading' && <Skeleton className="h-3 w-3/5" />}
      {load.kind === 'failed' && (
        <ReadFailed what="Could not read your site’s address" failure={load.failure} />
      )}

      {load.kind === 'ready' && (
        <>
          <p>
            The home page of the site this deployment takes comments for. Nothing can work it out:
            this Worker’s own address is a <code>workers.dev</code> URL rather than your site, and
            the address a comment reports is chosen by whoever posted it.
          </p>
          {load.value.fromDeprecatedSecrets.includes('site_url') && (
            <Alert>
              <TriangleAlertIcon />
              <AlertTitle>This is still coming from a secret you set with wrangler</AlertTitle>
              <AlertDescription>
                <p>
                  It keeps working. The field below is empty because nothing has been saved here yet
                  — Charcha will not show you a value out of a secret. Save it here, and you can
                  then remove <code>CHARCHA_SITE_URL</code> with <code>wrangler secret delete</code>
                  .
                </p>
              </AlertDescription>
            </Alert>
          )}
          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              const value = draft ?? load.value.siteUrl
              // The same rule `NotifyFields` follows: an empty box that is empty because
              // a secret is supplying the value is not an instruction to clear it. There
              // is nothing to send, so the save is a no-op rather than a row write.
              if (value === '' && servedBySecret(load.value, 'site_url')) return
              save(() => writeSiteUrl(value))
            }}
          >
            <Field
              id={`${id}-site-url`}
              type="url"
              label="Home page address"
              placeholder="https://example.com"
              value={draft ?? load.value.siteUrl}
              disabled={busy}
              invalid={saveFailed}
              onChange={setDraft}
              hint={
                <>
                  Include the scheme — <code>https://example.com</code>, or{' '}
                  <code>https://you.github.io/blog</code> if your site lives at a path. A
                  third-party spam service needs it to identify your site, and it is the base for
                  the link to a commented page.
                </>
              }
            />
            {status}
            <SaveRow busy={busy} label="Save site address" />
          </form>
        </>
      )}
    </Section>
  )
}

/**
 * Turnstile, whose two halves are set in two different places, and the one item on this
 * tab that is recommended rather than merely reported (#174).
 *
 * **The sitekey paragraphs are shown whether or not the secret is set, and that is the
 * whole reason this section is on the tab.** Charcha cannot see the site's pages, so it
 * cannot tell a correctly configured deployment from #104 — a secret with no
 * `data-turnstile-sitekey` anywhere, where every comment arrived with no token and was
 * held. This is the screen on which somebody would find that out.
 *
 * **They also sit above the command block rather than below it, and that ordering is
 * load-bearing rather than tidy.** #104 is what a *half-followed* recommendation
 * produces, so the surface doing the recommending is the surface most likely to cause
 * it: a reader who has been told this is worth doing starts on the command, and never
 * reaches a paragraph underneath it. Same reason the third-party disclosure stays above
 * the command — "what is sent and to whom, before the switch that turns it on" is a
 * product rule, and a recommendation is exactly the pressure that would push it down.
 * Enforced by test/dashboard/setup.test.tsx.
 *
 * **The argument is in the copy, not in the badge.** *Recommended* on its own is taste;
 * what earns it is the fact that separates this layer from the ones that judge a comment.
 * The honeypot, the timing floor and the content heuristics all measure the absence of
 * something wrong, and a script written for this form passes all three. Turnstile is the
 * only one that asks for evidence. The claim is scoped to those three deliberately: layer
 * 4 is rate limiting (src/spam/index.ts), which bounds how many comments arrive rather
 * than judging any one of them, so "every other layer" would be false.
 *
 * The free-and-unmetered claim is Cloudflare's, and CLAUDE.md's verified-facts table is
 * where it is recorded with its date: https://developers.cloudflare.com/turnstile/plans/
 */
function TurnstileSection({ set }: { set: boolean }) {
  return (
    <Section
      title="Turnstile bot check"
      status={
        set ? (
          <On />
        ) : (
          // Grouped, because the header row is `justify-between`: two loose children
          // there would space themselves across the whole row and the status badge
          // would stop lining up with the other sections' — which is the column a
          // reader scans down.
          <span className="flex items-center gap-2">
            <Recommended />
            <Off />
          </span>
        )
      }
    >
      {set ? (
        <p>
          <code>TURNSTILE_SECRET_KEY</code> is set, which is the half that lives here.
        </p>
      ) : (
        <>
          <p>
            The invisible bot check is off, and it is the layer worth having. Everything else that
            looks at a comment measures the absence of something wrong — a honeypot left empty, more
            than two seconds spent typing, not too many links — and a script written for this form
            passes all of it. Rate limiting bounds how many arrive, not whether any one of them is
            real. Turnstile is the only layer that asks for something a script cannot make up: a
            token from a browser that solved a real challenge. Without it, everything reaching your
            queue has only managed not to look wrong.
          </p>
          <p>
            It is free and unmetered, and it is on the Cloudflare account you already have —
            deploying Charcha needed one. One widget, and the two keys it gives you.
          </p>
          <p>
            It is also the one thing Charcha can put a third party into a reader’s browser — the
            widget is Cloudflare’s, in an iframe on <code>challenges.cloudflare.com</code> — so read
            what it does before turning it on. Charcha itself still stores nothing in a reader’s
            browser; Turnstile’s <i>pre-clearance</i> setting is the one that would, and it is off
            unless you switch it on yourself.
          </p>
        </>
      )}
      <p>
        <b>The other half is on your site, not here.</b> A widget has two keys and they are not
        interchangeable: the <i>sitekey</i> is public and goes on your page as{' '}
        <code>data-turnstile-sitekey</code>, and it is what puts the widget there. Charcha cannot
        see your pages, so nothing on this screen can tell you whether that is done.
      </p>
      {/*
        The two halves are not symmetrical, and saying so is the point: only one of them
        is #104. The named reason is the one this queue actually shows — `runLayers`
        prefixes the layer (src/spam/layer.ts) and `runSubmission` stores the result on
        the comment, asserted by test/worker/submit/pipeline.test.ts and
        test/worker/spam/turnstile.test.ts. An earlier version of this paragraph said
        "nothing anywhere saying why", which was the #162 class of drift: a signal the
        code goes out of its way to produce, documented as absent.
      */}
      <p>
        Set both or neither, and the two failures are not the same size. A secret key with no
        sitekey means every comment arrives with no token to check and is held for review — a queue
        filling with comments that look perfectly fine. What tells you it is this rather than a
        quiet week is the reason on each one: they arrive marked <b>Held</b>, with{' '}
        <code>turnstile: no-token-unverified-deployment</code> beside them. A sitekey with no secret
        key is the harmless direction: the widget renders, this layer abstains, and comments carry
        on as though Turnstile were off.
      </p>
      {!set && (
        <>
          <ul className="space-y-1">
            <SecretRow name="TURNSTILE_SECRET_KEY" set={false} />
          </ul>
          <p>
            Create a widget at <b>Cloudflare dashboard</b> → <b>Turnstile</b> → <b>Add widget</b>.
            It hands you both keys: the <i>secret key</i> is the one that goes below, and the
            sitekey is the one that goes on your page.
          </p>
          <HowToSet names={['TURNSTILE_SECRET_KEY']} />
        </>
      )}
    </Section>
  )
}

/** The per-IP rate limit's key, and the one thing that reports whether it is running. */
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
function SpamServiceSection({ set }: { set: boolean }) {
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

function IpHashSection({ set }: { set: boolean }) {
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

/**
 * The allowlist — the one item here that lives in the database rather than on `env`, and
 * so the one that is editable.
 *
 * It reads `GET /admin/api/settings` and hands editing to the dialog the header already
 * opens, rather than growing a second write path beside src/admin/settings.ts. No On/Off
 * badge: an empty list is a working default, not a feature that is switched off — a
 * fresh deployment accepts comments from its own address without anything being stored
 * (#57).
 */
function OriginsSection({ load, onEdit }: { load: Load<Settings>; onEdit: () => void }) {
  return (
    <Section title="Allowed origins" status={null}>
      {load.kind === 'loading' && <Skeleton className="h-3 w-3/5" />}

      {load.kind === 'failed' && (
        <ReadFailed what="Could not read the allowed origins" failure={load.failure} />
      )}

      {load.kind === 'ready' && (
        <>
          <p>
            A page on any of these addresses may post comments to this deployment; a page anywhere
            else is refused. That is a browser rule, so what it stops is another site’s page posting
            from a reader’s browser. It is not what stops a script — that is the spam layers and
            this queue.
          </p>
          {load.value.allowedOrigins.length === 0 ? (
            <p>
              No addresses listed yet.{' '}
              {load.value.selfOrigin !== '' && (
                <>
                  This deployment’s own address, <code>{load.value.selfOrigin}</code>, is always
                  allowed without being listed — but your site is a different address, so it has to
                  be added before a page there can comment.
                </>
              )}
            </p>
          ) : (
            <>
              <ul className="space-y-1">
                {load.value.allowedOrigins.map((origin) => (
                  <li key={origin}>
                    <code className="text-foreground">{origin}</code>
                  </li>
                ))}
              </ul>
              {load.value.selfOrigin !== '' && (
                <p>
                  This deployment’s own address, <code>{load.value.selfOrigin}</code>, is allowed as
                  well, without being listed.
                </p>
              )}
            </>
          )}
          <p>
            This is a Charcha setting. It is not Turnstile’s hostname list, which governs where the
            widget may render and does nothing here.
          </p>
          <Button variant="outline" size="sm" onClick={onEdit}>
            <GlobeIcon aria-hidden="true" />
            Edit allowed origins
          </Button>
        </>
      )}
    </Section>
  )
}
