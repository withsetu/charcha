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
// **And it is not a nag.** A deployment with everything on finds four quiet lines and
// nothing to do.
//
// Enforced by test/dashboard/setup.test.tsx.

import * as React from 'react'
import { ExternalLinkIcon, GlobeIcon, TriangleAlertIcon } from 'lucide-react'

import type { ApiFailure, SetupSecret, Settings } from '../api'
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

/** Where the long form of every instruction below lives. */
const README = 'https://github.com/withsetu/charcha#turning-on-the-optional-features'

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
 * The exact command, and the exact route for somebody who has no terminal.
 *
 * Both, always, and that is the point rather than thoroughness: the person most likely
 * to be reading this clicked a Deploy button, so they have no checkout, no wrangler and
 * no API token — which is how #57 stayed unfixable for its author, who owns this
 * project.
 */
function HowToSet({ names }: { names: readonly SetupSecret[] }) {
  return (
    <div className="space-y-2">
      <p>
        {names.length === 1 ? 'Set it' : 'Set them'} from a checkout of your deployed repository:
      </p>
      {/*
        `tabIndex` so the block can be scrolled without a mouse when a narrow window
        clips it (WCAG 2.1.1) — and `role`/`aria-label` with it, because a focusable
        element with neither is a tab stop that announces nothing, which trades 2.1.1
        for 4.1.2 on the one piece of actionable content this tab has. The label is
        derived from `names` so it cannot describe a block it no longer matches.

        It is not an editable target, so the shortcut map still sees keystrokes that land
        in it — which on this tab is `1`–`4`, `?` and Escape, every one of them harmless.
        See the queue-command guard in triage.tsx.
      */}
      <pre
        tabIndex={0}
        role="region"
        aria-label={`Commands to set ${names.join(', ')}`}
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
  const [secrets, setSecrets] = React.useState<Load<Record<SetupSecret, boolean>>>({
    kind: 'loading',
  })
  const [origins, setOrigins] = React.useState<Load<Settings>>({ kind: 'loading' })

  // Two reads, landing independently: a settings failure must not hide the secret report
  // or the other way round, because either one alone is still worth the trip.
  React.useEffect(() => {
    setSecrets({ kind: 'loading' })
    void readSetup()
      .then((result) => {
        if (!result.ok) {
          if (result.failure.code === 'UNAUTHORIZED') return onExpired()
          return setSecrets({ kind: 'failed', failure: result.failure })
        }
        setSecrets({ kind: 'ready', value: result.value.secrets })
      })
      .catch(() => {
        // src/dashboard/api.ts is documented never to reject, so this is a bug in the
        // callback above. Reported anyway: a skeleton that never resolves is an
        // unreported failure, which is the rule CLAUDE.md states in as many words.
        setSecrets({ kind: 'failed', failure: DASHBOARD_BUG })
      })
  }, [onExpired])

  React.useEffect(() => {
    setOrigins({ kind: 'loading' })
    void readSettings()
      .then((result) => {
        if (!result.ok) {
          if (result.failure.code === 'UNAUTHORIZED') return onExpired()
          return setOrigins({ kind: 'failed', failure: result.failure })
        }
        setOrigins({ kind: 'ready', value: result.value })
      })
      .catch(() => {
        setOrigins({ kind: 'failed', failure: DASHBOARD_BUG })
      })
  }, [onExpired, originsSavedAt])

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        What this deployment has been given, and what it has not. All of it is optional — a Charcha
        that takes comments and holds them for you needs none of it — and none of it is set from
        this screen, because a Worker cannot write its own secrets.
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
          <EmailSection secrets={secrets.value} />
          <TurnstileSection set={secrets.value.TURNSTILE_SECRET_KEY} />
          <IpHashSection set={secrets.value.IP_HASH_SECRET} />
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
          href={README}
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
 * Turnstile, whose two halves are set in two different places.
 *
 * **The sitekey paragraph is shown whether or not the secret is set, and that is the
 * whole reason this section is on the tab.** Charcha cannot see the site's pages, so it
 * cannot tell a correctly configured deployment from #104 — a secret with no
 * `data-turnstile-sitekey` anywhere, where every comment arrived with no token and was
 * held. This is the screen on which somebody would find that out.
 */
function TurnstileSection({ set }: { set: boolean }) {
  return (
    <Section title="Turnstile bot check" status={set ? <On /> : <Off />}>
      {set ? (
        <p>
          <code>TURNSTILE_SECRET_KEY</code> is set, which is the half that lives here.
        </p>
      ) : (
        <>
          <p>
            The invisible bot check is off, and comments are judged by the other spam layers. It is
            free and unmetered. It is also the one thing Charcha can put a third party into a
            reader’s browser — the widget is Cloudflare’s, in an iframe on{' '}
            <code>challenges.cloudflare.com</code> — so read what it does before turning it on.
            Charcha itself still stores nothing in a reader’s browser; Turnstile’s{' '}
            <i>pre-clearance</i> setting is the one that would, and it is off unless you switch it
            on yourself.
          </p>
          <ul className="space-y-1">
            <SecretRow name="TURNSTILE_SECRET_KEY" set={false} />
          </ul>
          <p>
            Create a widget at <b>Cloudflare dashboard</b> → <b>Turnstile</b> → <b>Add widget</b>,
            and use its <i>secret key</i> below — not its sitekey.
          </p>
          <HowToSet names={['TURNSTILE_SECRET_KEY']} />
        </>
      )}
      <p>
        <b>The other half is on your site, not here.</b> A widget has two keys and they are not
        interchangeable: the <i>sitekey</i> is public and goes on your page as{' '}
        <code>data-turnstile-sitekey</code>, and it is what puts the widget there. Charcha cannot
        see your pages, so nothing on this screen can tell you whether that is done.
      </p>
      <p>
        Set both or neither. A secret key with no sitekey means every comment arrives with no token
        to check and is held for review — a queue filling with comments that look perfectly fine,
        and nothing anywhere saying why. A sitekey with no secret key means the widget renders and
        nothing checks its answer.
      </p>
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
