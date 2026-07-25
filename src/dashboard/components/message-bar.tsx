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

import type { Announcement, ActionFailure, UndoOffer } from '../queue'
import { UNDO_WINDOW_MS } from '../queue'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'

const DONE: Record<UndoOffer['to'], string> = {
  approved: 'Approved',
  spam: 'Marked spam',
  deleted: 'Deleted',
}

const ATTEMPT: Record<ActionFailure['status'], string> = {
  approved: 'approve',
  spam: 'mark spam on',
  deleted: 'delete',
}

export interface MessageBarProps {
  undo: UndoOffer | null
  failure: ActionFailure | null
  announcement: Announcement | null
  onUndo: () => void
  onRetry: () => void
  onDismiss: () => void
}

export function MessageBar({
  undo,
  failure,
  announcement,
  onUndo,
  onRetry,
  onDismiss,
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

      {(failure !== null || undo !== null) && (
        <div className="sticky bottom-0 z-10 -mx-1 bg-gradient-to-t from-background via-background px-1 pt-6 pb-4">
          {failure !== null ? (
            <Alert variant="destructive" className="border-destructive/40 shadow-lg">
              <TriangleAlertIcon />
              <AlertTitle>
                Could not {ATTEMPT[failure.status]} the comment by {failure.comment.authorName}
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
                    <kbd aria-hidden="true" className="ml-1 text-[0.65rem] opacity-70">
                      Esc
                    </kbd>
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : (
            undo !== null && (
              <div className="overflow-hidden rounded-lg border bg-card shadow-lg">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <p className="text-sm">
                    <span className="font-medium">{DONE[undo.to]}</span>
                    {': '}
                    {undo.comment.authorName}
                  </p>
                  <Button variant="outline" size="sm" disabled={undo.running} onClick={onUndo}>
                    <UndoIcon aria-hidden="true" />
                    {undo.running ? 'Undoing…' : 'Undo'}
                    <kbd aria-hidden="true" className="ml-1 text-[0.65rem] opacity-70">
                      Z
                    </kbd>
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
