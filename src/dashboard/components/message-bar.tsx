// The bar along the bottom: the undo window, the failure that needs a retry, and the
// live region that says what just happened.
//
// One component for all three because they are one slot on screen and one thing at a
// time — and because the failure has to *replace* the undo offer rather than sit
// beside it. Two independent widgets would eventually show "Marked spam — undo" above
// "Could not mark spam", which is the exact ambiguity the brief forbids.
//
// A toast library was considered and not used. `sonner` is shadcn's answer for
// transient notices, and it is the wrong shape here for two reasons: the undo has a
// keystroke (`Z`) that must work whether or not the pointer is anywhere near the
// notice, and a stack of toasts can hold several dismissable notices at once where
// this surface must hold exactly one. The controls inside the bar are still the
// registry's Button and Alert.
//
// Enforced by test/dashboard/triage.test.tsx.

import type * as React from 'react'
import { RotateCcwIcon, TriangleAlertIcon, UndoIcon, XIcon } from 'lucide-react'

import type { ActionFailure, Announcement, UndoOffer } from '../queue'
import { ATTEMPTED, UNDO_WINDOW_MS, decisionSummary, repliesStay } from '../queue'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Kbd } from '../ui/kbd'

export interface MessageBarProps {
  undo: UndoOffer | null
  failure: ActionFailure | null
  announcement: Announcement | null
  onUndo: () => void
  onRetry: () => void
  onDismiss: () => void
  /**
   * Suppress the visible bar, but not the live region (#158).
   *
   * The Setup tab is the caller for it: a decision started on the queue can resolve
   * after the owner has switched, and both of the bar's controls act on comments that
   * are no longer on screen — Undo on one the owner cannot read, Try again on a queue
   * they cannot see. The keyboard route to those is already refused there, so a visible
   * button would be the one way round the guard.
   *
   * Only the visible half goes. The announcement still has to happen: a decision that
   * lands unreported is the failure the whole bar exists to prevent, and the wording is
   * `decide/ok` in src/dashboard/queue.ts, which drops the "press Z" half on this tab.
   * Enforced by test/dashboard/shortcuts.test.tsx.
   */
  hidden?: boolean
}

export function MessageBar({
  undo,
  failure,
  announcement,
  onUndo,
  onRetry,
  onDismiss,
  hidden = false,
}: MessageBarProps) {
  return (
    <>
      {/*
        The live region, and it is separate from everything visible on purpose.
        Announcements have to survive the bar being absent — a decision on the last
        comment in the queue removes the row, moves focus to the empty state and
        offers an undo, and the only thing that tells a screen reader user which of
        those happened is this.

        Two regions rather than one with a changing `aria-live`: browsers register the
        politeness when the region is created, so flipping the attribute on a live
        node is unreliable. `key` on the inner text forces a new node per
        announcement, which is what makes two identical sentences two events.
      */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement !== null && announcement.urgency === 'polite' && (
          <p key={announcement.seq}>{announcement.text}</p>
        )}
      </div>
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {announcement !== null && announcement.urgency === 'assertive' && (
          <p key={announcement.seq}>{announcement.text}</p>
        )}
      </div>

      {!hidden && (failure !== null || undo !== null) && (
        <div className="sticky bottom-0 z-10 -mx-1 bg-gradient-to-t from-background via-background px-1 pt-6 pb-4">
          {failure !== null ? (
            <Alert variant="destructive" className="border-destructive/40 shadow-lg">
              <TriangleAlertIcon />
              <AlertTitle>
                Could not {ATTEMPTED[failure.status]} the comment by {failure.comment.authorName}
              </AlertTitle>
              <AlertDescription>
                {/*
                  The row is back in the list, and saying so is the point. Without it
                  the owner cannot tell "nothing happened" from "it happened and the
                  screen is wrong", and those need different next actions.
                */}
                <p>{failure.failure.message} It is still in the queue, where you left it.</p>
                <div className="mt-2 flex gap-2">
                  <Button variant="outline" size="sm" onClick={onRetry}>
                    <RotateCcwIcon aria-hidden="true" />
                    Try again
                  </Button>
                  <Button variant="ghost" size="sm" onClick={onDismiss}>
                    <XIcon aria-hidden="true" />
                    Dismiss
                    <Kbd aria-hidden="true">Esc</Kbd>
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : (
            undo !== null && (
              <div className="overflow-hidden rounded-lg border bg-card shadow-lg">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    {/*
                      What the decision did, replies included (#133). Hiding one comment
                      hides the replies under it, and until this line existed the bar
                      named one comment while the tab count beside it fell by four — the
                      moderator had the number and no sentence to attach it to.
                    */}
                    <p className="text-sm font-medium">
                      {decisionSummary(undo.to, undo.comment.authorName, undo.cascaded)}
                    </p>
                    {/*
                      And what `Z` will not do. Undo re-issues one status write on this
                      comment; the replies stay where the decision put them, because
                      restoring them would need a status no row records. Saying it here
                      is the difference between an undo that does less and an undo that
                      claims more than it did.
                    */}
                    {repliesStay(undo) !== null && (
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        Undo restores {undo.comment.authorName}. {repliesStay(undo)}
                      </p>
                    )}
                  </div>
                  <Button variant="outline" size="sm" disabled={undo.running} onClick={onUndo}>
                    <UndoIcon aria-hidden="true" />
                    {undo.running ? 'Undoing…' : 'Undo'}
                    <Kbd aria-hidden="true">Z</Kbd>
                  </Button>
                </div>
                {/*
                  The window, drawn. It is `aria-hidden` because it duplicates
                  nothing a screen reader needs: the announcement above already said
                  "press Z to undo", and a shrinking bar is not information anyone
                  can act on by hearing it.
                */}
                <div
                  aria-hidden="true"
                  className="charcha-undo-window h-0.5 origin-left bg-foreground/40"
                  // A custom property, so the duration is stated once — in
                  // src/dashboard/queue.ts — and the CSS animation and the timer that
                  // clears the offer cannot drift apart. `as React.CSSProperties`
                  // because custom properties are not in React's typed style map.
                  style={
                    {
                      '--charcha-undo-duration': `${String(UNDO_WINDOW_MS)}ms`,
                    } as React.CSSProperties
                  }
                />
              </div>
            )
          )}
        </div>
      )}
    </>
  )
}
