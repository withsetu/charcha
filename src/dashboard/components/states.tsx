// Loading, empty, and failed — three states the brief requires to be visibly
// different from one another.
//
// They live in one file because the mistake they exist to prevent is a comparison
// between them: "no pending comments" shown to somebody whose request failed, or a
// skeleton left standing where an empty queue should be. Side by side, the difference
// is reviewable.
//
// Enforced by test/dashboard/triage.test.tsx.

import * as React from 'react'
import { CheckCircle2Icon, InboxIcon, RotateCcwIcon, TriangleAlertIcon } from 'lucide-react'

import type { ApiFailure, ViewStatus } from '../api'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'

/**
 * The first page, arriving.
 *
 * Skeleton rows rather than a spinner, because they say how much is coming as well
 * as that something is: the queue's shape is already known. `aria-busy` and a
 * visually-hidden sentence are what make it a state to a screen reader, which cannot
 * see a pulse.
 */
export function QueueLoading() {
  return (
    <div aria-busy="true" className="space-y-3">
      <p className="sr-only" role="status">
        Loading comments.
      </p>
      {[0, 1, 2].map((row) => (
        <div key={row} className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <div className="flex gap-2 pt-1">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-20" />
          </div>
        </div>
      ))}
    </div>
  )
}

const EMPTY_COPY: Record<ViewStatus, { title: string; body: string }> = {
  pending: {
    title: 'Nothing waiting on you',
    body: 'Every comment has been dealt with. New ones will show up here.',
  },
  spam: {
    title: 'No spam held',
    body: 'Nothing has been marked spam, by you or by a spam layer.',
  },
  approved: {
    title: 'Nothing published yet',
    body: 'Comments you approve appear here, and on the page they were posted on.',
  },
}

/**
 * The queue really is empty.
 *
 * **A success state, and written like one.** An empty pending queue is the outcome
 * the whole surface exists to reach, so it gets the tick and the sentence rather than
 * the grey shrug an empty list usually gets. It also takes focus when the last
 * comment is cleared — `tabIndex={-1}` makes it focusable programmatically only —
 * because otherwise focus falls to `body` at exactly the moment a keyboard user
 * deserves to be told they are finished.
 */
export const QueueEmpty = React.forwardRef<HTMLDivElement, { view: ViewStatus }>(
  function QueueEmpty({ view }, ref) {
    const copy = EMPTY_COPY[view]
    const Icon = view === 'pending' ? CheckCircle2Icon : InboxIcon
    return (
      <div
        ref={ref}
        tabIndex={-1}
        // `status` rather than `alert`: it is news, but it must not interrupt.
        role="status"
        className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center"
      >
        <Icon
          aria-hidden="true"
          className={view === 'pending' ? 'size-8 text-success' : 'size-8 text-muted-foreground'}
        />
        <p className="text-lg font-medium">{copy.title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{copy.body}</p>
      </div>
    )
  },
)

/**
 * The first page did not arrive.
 *
 * Never an empty list: this is the state CLAUDE.md's rule about unawaited async is
 * about — a loading skeleton that never resolves, or worse a queue that reports
 * itself clear. It names what failed, shows the server's own sentence, and offers the
 * retry, which is the whole of "specific, recoverable, never silent".
 */
export function QueueFailed({
  failure,
  onRetry,
  busy,
}: {
  failure: ApiFailure
  onRetry: () => void
  busy: boolean
}) {
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>The queue could not be loaded</AlertTitle>
      <AlertDescription>
        <p>{failure.message}</p>
        {failure.status !== null && (
          <p className="text-xs opacity-80">
            The server answered {failure.status} ({failure.code}).
          </p>
        )}
        <Button variant="outline" size="sm" className="mt-2" disabled={busy} onClick={onRetry}>
          <RotateCcwIcon aria-hidden="true" />
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  )
}
