// The sign-in screen, and the screen an expired session lands on.
//
// The two are one component because they are one form with one extra sentence. What
// they must never be is the empty queue: the brief calls that out by name, and it is
// the failure that has a moderator believe they are finished when they have in fact
// been signed out.
//
// Enforced by test/dashboard/sign-in.test.tsx.

import * as React from 'react'
import { LoaderCircleIcon, LockIcon, TriangleAlertIcon } from 'lucide-react'

import type { ApiFailure, SessionState } from '../api'
import { signIn } from '../api'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

export function SignIn({
  expired,
  onSignedIn,
}: {
  /** True when a session existed and stopped working, rather than never existing. */
  expired: boolean
  onSignedIn: (session: SessionState) => void
}) {
  const [password, setPassword] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState<ApiFailure | null>(null)
  const field = React.useRef<HTMLInputElement>(null)

  // Focus the field on arrival, including on an expiry that interrupted triage: the
  // owner's next keystroke should go somewhere useful without a click.
  React.useEffect(() => {
    field.current?.focus()
  }, [])

  function submit(event: React.FormEvent<HTMLFormElement>) {
    // The CSP on this document sets `form-action 'none'`, so a real submission is
    // refused by the browser rather than merely unhandled. This is what makes the
    // form work, and the guard is that it is refused rather than silently navigating.
    event.preventDefault()
    if (busy) return

    setBusy(true)
    setFailure(null)
    void signIn(password)
      .then((result) => {
        setBusy(false)
        if (!result.ok) {
          setFailure(result.failure)
          setPassword('')
          field.current?.focus()
          return
        }
        onSignedIn(result.value)
      })
      .catch(() => {
        // src/dashboard/api.ts is documented never to reject, so reaching here means a
        // bug in this component's own callbacks rather than a failed request. It is
        // still reported: the alternative is a button stuck on "Signing in…" with
        // nothing anywhere saying why, which is the exact failure CLAUDE.md's rule
        // about unawaited async names.
        setBusy(false)
        setFailure({
          code: 'MALFORMED',
          message: 'Something went wrong in the dashboard. Reload the page and try again.',
          status: null,
        })
      })
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-12">
      <div className="space-y-2">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <LockIcon aria-hidden="true" className="size-5" />
          Charcha moderation
        </h1>
        {expired ? (
          // A distinct sentence, not a distinct screen: the action is the same, and
          // what the owner needs to know is that the queue they were looking at is
          // gone because of the session and not because of the queue.
          <p className="text-sm text-muted-foreground">
            Your session ended, so the queue stopped loading. Sign in again to carry on — nothing
            you had already decided was lost.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Sign in with the dashboard password for this deployment.
          </p>
        )}
      </div>

      {failure !== null && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Could not sign in</AlertTitle>
          {/*
            The server's own sentence, verbatim. src/admin/route.ts is deliberately
            incurious — it does not distinguish a wrong password from an unconfigured
            deployment — and rewording it here would either invent a distinction it
            refused to make or hide the throttle's "wait a minute", which is the one
            message that tells the owner what to do next.
          */}
          <AlertDescription id="charcha-password-error">{failure.message}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="charcha-password">Dashboard password</Label>
          <Input
            ref={field}
            id="charcha-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            disabled={busy}
            aria-invalid={failure !== null || undefined}
            aria-describedby={failure !== null ? 'charcha-password-error' : undefined}
            onChange={(event) => {
              setPassword(event.target.value)
            }}
          />
          {/*
            `aria-describedby` points at the alert above rather than at a copy of its
            text down here. The first draft had both, and a screen reader read the
            refusal twice — once because the alert is a live region and once because
            the field describes itself with it.
          */}
        </div>
        <Button type="submit" className="w-full" disabled={busy || password === ''}>
          {busy && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </main>
  )
}
