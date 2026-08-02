// The pieces every section of the Setup tab is built from (#197).
//
// **They are here because they are shared, and that is the whole entry criterion.** The
// sections next door share almost nothing else — each is a heading, a status word and
// several paragraphs of copy about one optional feature — so a helper that only one
// section uses belongs in that section's file, where its reason is next to its only
// reader. `omitUntyped` is the worked example: it lives in ./sections/email.tsx.
//
// Split out of a single 1,583-line setup.tsx, with no behaviour change. What made that
// move verifiable is the exact heading sequence asserted in test/dashboard/setup.test.tsx
// — the composition order is load-bearing (#174 puts Turnstile first, #158 says the tab
// must stay quiet when everything is configured), so a move that reordered anything fails
// there rather than in review.

import * as React from 'react'
import { ExternalLinkIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'

import type { ApiFailure, ApiResult, SetupSecret, Settings } from '../../api'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Skeleton } from '../../ui/skeleton'

/**
 * One request's outcome. `loading` and `failed` are separate states for the reason
 * site-settings.tsx gives: a panel that rendered an empty answer on a failed read would
 * tell an owner that a feature is off when in truth nothing could be read.
 */
export type Load<T> =
  { kind: 'loading' } | { kind: 'failed'; failure: ApiFailure } | { kind: 'ready'; value: T }

export const DASHBOARD_BUG: ApiFailure = {
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
export function useLoad<T>(
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
export const README_URL = 'https://github.com/withsetu/charcha#turning-on-the-optional-features'

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
 * import from `src/admin` (see the note on `SETUP_SECRETS` in ../../api.ts). What catches
 * a rename of this one is `pnpm check:deploy`, which fails a secret `src/` reads that is
 * in neither `.dev.vars.example` nor README.md.
 */
type SettableSecret = SetupSecret | 'CHARCHA_DASHBOARD_PASSWORD'

/**
 * One section of the tab.
 *
 * A heading and a status word, never a status colour alone: "On" and "Off" are the whole
 * of the signal, and the badge's fill is decoration on top of it (WCAG 1.4.1).
 */
export function Section({
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
export function On() {
  return <Badge variant="outline">On</Badge>
}

/** Not configured. The strong badge, because this is the line that has news in it. */
export function Off() {
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
export function Recommended() {
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
export function HowToSet({
  names,
  verb = 'Set',
}: {
  names: readonly SettableSecret[]
  verb?: string
}) {
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
export function SecretRow({ name, set }: { name: SetupSecret; set: boolean }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <code className="text-foreground">{name}</code>
      <span>{set ? 'Set' : 'Not set'}</span>
    </li>
  )
}

export function ReadFailed({ what, failure }: { what: string; failure: ApiFailure }) {
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

export function SectionSkeleton() {
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4 sm:p-5" aria-hidden="true">
      <Skeleton className="h-4 w-44" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-3/5" />
    </div>
  )
}

/**
 * An external link, styled and safe, since three sections of this tab need one.
 *
 * `noreferrer` as well as `noopener`: the document is already served
 * `referrer-policy: no-referrer` (src/dashboard/document.ts), and this says the same
 * thing at the link so that a deployment behind a proxy that rewrites the header still
 * does not hand a third party the address of a moderation dashboard.
 */
export function OutboundLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className="underline underline-offset-4 hover:text-foreground"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ExternalLinkIcon aria-hidden="true" className="ml-1 inline size-3 align-baseline" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
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
export function useSettingsSave(onExpired: () => void, onSaved: (settings: Settings) => void) {
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

/** One labelled text field, since two sections of this tab have four between them. */
export function Field({
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

/** The save button every settings form on this tab uses, so they cannot drift apart. */
export function SaveRow({ busy, label }: { busy: boolean; label: string }) {
  return (
    <div className="flex justify-end">
      <Button type="submit" size="sm" disabled={busy}>
        {busy && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
        {busy ? 'Saving…' : label}
      </Button>
    </div>
  )
}
