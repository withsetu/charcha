// The allowed-origins editor. Designed on issue #57.
//
// **What it replaces.** Nothing could write this setting. The documented workaround was
// `wrangler d1 execute --remote`, which needs a checkout, wrangler, and an API token
// with D1 on it — and the person who reaches this dashboard clicked a Deploy button.
// So this is the whole owner-facing half of #57, and the sentence under the field is
// as much of the fix as the field is: an owner who cannot tell this list from
// Turnstile's Hostname Management screen will edit the wrong one, because that is what
// actually happened.
//
// **A dialog rather than a page**, which is the one place this surface's craft floor
// says to think twice. It earns it: the task is rare, it is entered from the header
// with the queue behind it, and Radix gives the focus trap and the Escape handling that
// a keyboard-first dashboard cannot go without. A route would also mean routing, which
// this app does not have.
//
// **One textarea, one origin per line.** Not a row-per-origin list with add and remove
// buttons: the value is a short list an owner edits twice a year, a textarea is
// paste-able from wherever they keep their domains, and it is the shape the stored
// value already has. The server canonicalises and answers with the saved list, so what
// comes back into the field is what the origin check will compare — a typed
// `HTTPS://Maya.Build/` reappears as `https://maya.build`, which is the feedback that
// teaches the rule.
//
// Enforced by test/dashboard/site-settings.test.tsx.

import * as React from 'react'
import { LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'

import type { ApiFailure } from '../api'
import { readSettings, writeAllowedOrigins } from '../api'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

/**
 * What the panel is doing, as one value rather than three booleans.
 *
 * `loading` and `failed` are distinct states because a dialog that opened onto an empty
 * textarea would tell an owner their allowlist is empty when in fact it could not be
 * read — and they would then save that emptiness over a working list.
 */
type Phase =
  | { kind: 'loading' }
  | { kind: 'failed'; failure: ApiFailure }
  | { kind: 'ready' }
  | { kind: 'saving' }
  | { kind: 'saved' }

const DASHBOARD_BUG: ApiFailure = {
  code: 'MALFORMED',
  message: 'Something went wrong in the dashboard. Reload the page and try again.',
  status: null,
}

/** One origin per line, which is what the stored value already looks like. */
function toField(origins: string[]): string {
  return origins.join('\n')
}

function toList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

export function SiteSettings({
  open,
  onOpenChange,
  onExpired,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** A 401 here means the same thing it means in the queue: the session is gone. */
  onExpired: () => void
  /**
   * A successful save landed (#158).
   *
   * The Setup tab shows the same allowlist and can be behind this dialog while it is
   * edited, so it has to be told. Reported from here rather than inferred from the
   * dialog closing, because closing without saving is the commoner ending and would
   * make a no-op re-read look like a change.
   */
  onSaved?: () => void
}) {
  const [phase, setPhase] = React.useState<Phase>({ kind: 'loading' })
  const [value, setValue] = React.useState('')
  const [selfOrigin, setSelfOrigin] = React.useState('')
  const [saveFailure, setSaveFailure] = React.useState<ApiFailure | null>(null)

  // Re-read on every open rather than once. The list is small, and the alternative is a
  // panel showing a value from before the owner last saved in another tab — which they
  // would then overwrite.
  React.useEffect(() => {
    if (!open) return

    setPhase({ kind: 'loading' })
    setSaveFailure(null)
    void readSettings()
      .then((result) => {
        if (!result.ok) {
          if (result.failure.code === 'UNAUTHORIZED') {
            onExpired()
            return
          }
          setPhase({ kind: 'failed', failure: result.failure })
          return
        }
        setValue(toField(result.value.allowedOrigins))
        setSelfOrigin(result.value.selfOrigin)
        setPhase({ kind: 'ready' })
      })
      .catch(() => {
        // src/dashboard/api.ts is documented never to reject, so this is a bug in the
        // callback above. Reported anyway: a dialog left on its skeleton forever is an
        // unreported failure, which is precisely what CLAUDE.md's rule names.
        setPhase({ kind: 'failed', failure: DASHBOARD_BUG })
      })
  }, [open, onExpired])

  function save(event: React.FormEvent<HTMLFormElement>) {
    // The document's CSP is `form-action 'none'`, so a real submission is refused by
    // the browser rather than merely unhandled — the same arrangement as the sign-in
    // form.
    event.preventDefault()
    if (phase.kind === 'saving' || phase.kind === 'loading') return

    setPhase({ kind: 'saving' })
    setSaveFailure(null)
    void writeAllowedOrigins(toList(value))
      .then((result) => {
        if (!result.ok) {
          if (result.failure.code === 'UNAUTHORIZED') {
            onExpired()
            return
          }
          setSaveFailure(result.failure)
          setPhase({ kind: 'ready' })
          return
        }
        // The server's canonicalised list, not what was typed. This is the feedback:
        // an origin comes back lowercased with its trailing slash gone, which is the
        // form the public check compares against.
        setValue(toField(result.value.allowedOrigins))
        setSelfOrigin(result.value.selfOrigin)
        setPhase({ kind: 'saved' })
        onSaved?.()
      })
      .catch(() => {
        setSaveFailure(DASHBOARD_BUG)
        setPhase({ kind: 'ready' })
      })
  }

  const busy = phase.kind === 'saving'
  const loading = phase.kind === 'loading'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Allowed origins</DialogTitle>
          <DialogDescription>
            The addresses of the sites whose pages may post comments to this deployment. A page on
            any other address is refused.
          </DialogDescription>
        </DialogHeader>

        {phase.kind === 'failed' ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Could not read the allowed origins</AlertTitle>
            <AlertDescription>
              <p>{phase.failure.message} Nothing has been changed.</p>
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={save} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="charcha-allowed-origins">One address per line</Label>
              <Textarea
                id="charcha-allowed-origins"
                name="allowedOrigins"
                rows={5}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="font-mono text-sm"
                placeholder={'https://maya.build\nhttps://www.maya.build'}
                value={value}
                disabled={loading || busy}
                aria-invalid={saveFailure !== null || undefined}
                aria-describedby="charcha-allowed-origins-help"
                onChange={(event) => {
                  setValue(event.target.value)
                  if (phase.kind === 'saved') setPhase({ kind: 'ready' })
                }}
              />
              <p id="charcha-allowed-origins-help" className="text-sm text-muted-foreground">
                Include the scheme and no trailing path — <code>https://example.com</code>. This is
                a Charcha setting, not Turnstile’s hostname list.
                {selfOrigin !== '' && (
                  <>
                    {' '}
                    This deployment’s own address, <code>{selfOrigin}</code>, is always allowed and
                    does not need listing.
                  </>
                )}
              </p>
            </div>

            {saveFailure !== null && (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>Not saved</AlertTitle>
                <AlertDescription>
                  {/*
                    The server's own sentence, verbatim: it names the entry it refused,
                    which is the one thing a rewording here would lose.
                  */}
                  <p>{saveFailure.message}</p>
                </AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              {/*
                A status line rather than a toast: the dialog is modal, so there is
                nowhere else to look, and the queue's own message bar is behind it.
                `role="status"` so a screen-reader user hears the save land.
              */}
              <p className="mr-auto self-center text-sm text-muted-foreground" role="status">
                {phase.kind === 'saved' ? 'Saved.' : ''}
              </p>
              <Button type="submit" disabled={loading || busy}>
                {busy && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
                {busy ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
