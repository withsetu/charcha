// The gate: are we signed in, and if not, why not.
//
// It is a separate component from the queue because the answer decides which of two
// surfaces exists at all — and because unmounting the queue on expiry is what
// guarantees no keystroke can act on a list read with a session that has gone. The
// brief's requirement that an expired session must not look like an empty queue is
// held structurally here rather than by a flag anywhere.
//
// Enforced by test/dashboard/app.test.tsx.

import * as React from 'react'
import { LoaderCircleIcon } from 'lucide-react'

import { readSession, signOut } from './api'
import { SignIn } from './components/sign-in'
import { Triage } from './components/triage'

/**
 * `unknown` is the state before the first answer, and it is a state rather than an
 * assumption in either direction.
 *
 * Rendering the sign-in form while the session call is still out would flash a
 * password prompt at somebody who is already signed in, every single load; rendering
 * the queue would flash an empty one. Neither is a spinner, and a spinner is the
 * honest answer for the third of a second it takes.
 *
 * `expired` is distinct from `absent`: the same form, one different sentence, and the
 * difference is the whole of what tells the owner their triage was interrupted rather
 * than never started.
 */
type Session = { kind: 'unknown' } | { kind: 'absent' } | { kind: 'expired' } | { kind: 'live' }

export function App() {
  const [session, setSession] = React.useState<Session>({ kind: 'unknown' })

  // Stable identities, because Triage's first-page effect depends on them through its
  // own callbacks. An inline arrow would be a new function on every App render, so any
  // future state added here would silently re-read the queue and throw away the owner's
  // position in it. Nothing does that today; this is what keeps it that way.
  const onExpired = React.useCallback(() => {
    setSession({ kind: 'expired' })
  }, [])

  const onSignOut = React.useCallback(() => {
    // Optimistic, and safe to be: `DELETE /admin/api/session` is deliberately not behind
    // authentication and changes nothing on the server, so the only thing that can fail
    // is the cookie not being cleared — which the next request would report as an expiry
    // anyway. Showing the form immediately is what the owner asked for by pressing it.
    setSession({ kind: 'absent' })
    void signOut().catch(() => {
      // Nothing to report: the surface the owner wanted is already on screen, and a
      // failure here cannot leave them signed in to anything they can reach.
    })
  }, [])

  React.useEffect(() => {
    void readSession()
      .then((result) => {
        // A 401 here is the ordinary answer "no", not an expiry: nothing was
        // interrupted, because nothing had started.
        setSession(result.ok ? { kind: 'live' } : { kind: 'absent' })
      })
      .catch(() => {
        // src/dashboard/api.ts never rejects, so this is a bug in the callback above.
        // Falling back to the form is the safe direction — it is the surface that can
        // recover, and it says what to do.
        setSession({ kind: 'absent' })
      })
  }, [])

  if (session.kind === 'unknown') {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
          Checking your session…
        </p>
      </main>
    )
  }

  if (session.kind !== 'live') {
    return (
      <SignIn
        expired={session.kind === 'expired'}
        onSignedIn={() => {
          setSession({ kind: 'live' })
        }}
      />
    )
  }

  return <Triage onExpired={onExpired} onSignOut={onSignOut} />
}
