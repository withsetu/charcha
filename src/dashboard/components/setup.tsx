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
import { ExternalLinkIcon, GlobeIcon, TriangleAlertIcon } from 'lucide-react'

import type { ApiFailure, ApiResult, SetupSecret, Settings } from '../api'
import { readSettings, readSetup } from '../api'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
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
 * The three that make email notifications work, in the order the README sets them.
 *
 * Typed against `SetupSecret` rather than as bare strings, which is what makes a rename
 * on the Worker's side a type error here instead of a section that quietly reports a
 * feature it is no longer asking about.
 */
const EMAIL_SECRETS = [
  'RESEND_API_KEY',
  'CHARCHA_NOTIFY_FROM',
  'CHARCHA_NOTIFY_TO',
] as const satisfies readonly SetupSecret[]

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
  const origins = useLoad(readSettings, onExpired, originsSavedAt)

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
        it — and nothing here is set from this screen, because a Worker cannot write its own
        secrets.
      </p>

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
            First, and only when there is something to say. It is the one item here that
            is not optional and the one credential every destructive action on this
            deployment goes through, so it does not sit under three feature switches.
          */}
          {secrets.value.shortPassword && <DashboardPasswordSection />}
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
          <EmailSection secrets={secrets.value.secrets} />
          <IpHashSection set={secrets.value.secrets.IP_HASH_SECRET} />
        </>
      )}

      <OriginsSection load={origins} onEdit={onEditOrigins} />

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
 * Email notifications: three secrets, all or nothing.
 *
 * The provider is named only where it is unavoidable — inside `RESEND_API_KEY`, which is
 * the string an owner has to type. The prose says "your email provider", so widening this
 * when a second provider lands is a change to the secret list rather than to the copy.
 */
function EmailSection({ secrets }: { secrets: Record<SetupSecret, boolean> }) {
  const missing = EMAIL_SECRETS.filter((name) => !secrets[name])

  return (
    <Section title="Email notifications" status={missing.length === 0 ? <On /> : <Off />}>
      {missing.length === 0 ? (
        <p>
          A short email to the address in <code>CHARCHA_NOTIFY_TO</code> as comments arrive — up to
          five back to back, and then a slower rate, so a busy morning cannot spend a day’s sending
          allowance in ten minutes. The next email that does go out says how many arrived while it
          was quiet. The queue is the record either way: the email is a prompt to come and look, and
          it is never the thing that missed one.
        </p>
      ) : (
        <>
          <p>
            {missing.length === EMAIL_SECRETS.length
              ? 'Nothing is emailed when a comment arrives. New comments still reach the queue, which is the only place they show up.'
              : 'Partly set up, so nothing is sent. All three are needed together — a key with no recipient has nowhere to send, and Charcha holds no owner address anywhere to guess one from.'}
          </p>
          <ul className="space-y-1">
            {EMAIL_SECRETS.map((name) => (
              <SecretRow key={name} name={name} set={secrets[name]} />
            ))}
          </ul>
          <p>
            <code>CHARCHA_NOTIFY_FROM</code> has to be on a domain verified with your email provider
            under the same account as the key. Mail from an unverified domain is refused — and from
            your side that refusal looks exactly like the feature being switched off, so check both
            addresses for typos before you paste them.
          </p>
          <HowToSet names={missing} />
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
