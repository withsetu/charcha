// The triage queue: the surface #13 is about.
//
// The key handler is the first thing in this file and the layout is arranged around
// it, which is the brief's interaction thesis made structural — the keyboard is the
// primary interface and the mouse is the fallback, so the reducer and the listener
// come first and the markup serves them.
//
// Everything asynchronous here goes through `run`, which exists because CLAUDE.md's
// rule is that unawaited async owes the user a specific message: a bare `void
// promise` in an event handler discards a rejection, and the visible result is a
// spinner that never stops.
//
// Enforced by test/dashboard/triage.test.tsx and test/dashboard/shortcuts.test.tsx.

import * as React from 'react'
import { KeyboardIcon, LoaderCircleIcon, LogOutIcon, TriangleAlertIcon } from 'lucide-react'

import type { ApiFailure, ApiResult, DecisionStatus, ViewStatus } from '../api'
import { VIEW_STATUSES, decide, readQueue } from '../api'
import { resolveCommand } from '../keys'
import {
  UNDO_WINDOW_MS,
  currentComment,
  initialState,
  isDeciding,
  reduce,
  shouldLoadMore,
} from '../queue'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { CommentCard } from './comment-card'
import { MessageBar } from './message-bar'
import { ShortcutSheet } from './shortcut-sheet'
import { QueueEmpty, QueueFailed, QueueLoading } from './states'

const VIEW_LABELS: Record<ViewStatus, string> = {
  pending: 'Pending',
  spam: 'Spam',
  approved: 'Approved',
}

/**
 * The failure reported when a promise this file started rejects.
 *
 * It should be unreachable: src/dashboard/api.ts is documented never to reject, so
 * getting here means a bug in a callback below rather than a failed request. It is
 * still surfaced, because the alternative to an honest "something went wrong in the
 * dashboard" is a row that vanished and no explanation anywhere.
 */
const DASHBOARD_BUG: ApiFailure = {
  code: 'MALFORMED',
  message: 'Something went wrong in the dashboard. Reload the page and try again.',
  status: null,
}

/**
 * A clock that ticks once a minute, so "4 minutes ago" does not say "just now" for as
 * long as the tab is open.
 *
 * Once a minute and not once a second: nothing on this screen is finer-grained than a
 * minute, and a per-second re-render of 200 rows would be spent entirely on text that
 * did not change.
 */
function useMinuteClock(): number {
  const [now, setNow] = React.useState(() => Math.floor(Date.now() / 1000))
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Math.floor(Date.now() / 1000))
    }, 60_000)
    return () => {
      window.clearInterval(timer)
    }
  }, [])
  return now
}

export function Triage({ onExpired, onSignOut }: { onExpired: () => void; onSignOut: () => void }) {
  const [state, dispatch] = React.useReducer(reduce, undefined, () => initialState('pending'))
  const now = useMinuteClock()

  // The listener below is registered once, so it needs the current state without
  // being re-registered on every keystroke. A ref is the standard answer and it is
  // also the correct one here: re-attaching a document listener 200 times while a
  // queue is cleared is work that buys nothing.
  const latest = React.useRef(state)
  latest.current = state

  const emptyState = React.useRef<HTMLDivElement>(null)
  const hadComments = React.useRef(false)

  /**
   * Starts async work and guarantees the failure has somewhere to go.
   *
   * `void promise` is the shape the lint rule accepts and the shape that loses a
   * rejection; this is the same call with the rejection accounted for.
   */
  const run = React.useCallback((work: () => Promise<void>, onBug: () => void) => {
    void work().catch(onBug)
  }, [])

  /**
   * Every response passes through here, and a 401 ends the session rather than being
   * reported as a failed action.
   *
   * Centralised because there are four call sites and the one that forgot would show
   * "the queue could not be loaded" to somebody who is simply signed out — a message
   * that invites a retry which cannot work.
   */
  const expiredCheck = React.useCallback(
    (result: ApiResult<unknown>): boolean => {
      if (!result.ok && result.failure.code === 'UNAUTHORIZED') {
        onExpired()
        return true
      }
      return false
    },
    [onExpired],
  )

  const load = React.useCallback(
    (view: ViewStatus) => {
      dispatch({ type: 'load/start' })
      run(
        async () => {
          const result = await readQueue(view)
          if (expiredCheck(result)) return
          if (result.ok) dispatch({ type: 'load/ok', page: result.value })
          else dispatch({ type: 'load/failed', failure: result.failure })
        },
        () => {
          dispatch({ type: 'load/failed', failure: DASHBOARD_BUG })
        },
      )
    },
    [expiredCheck, run],
  )

  const loadMore = React.useCallback(() => {
    const { view, nextCursor, more } = latest.current
    if (nextCursor === null || more === 'loading') return
    dispatch({ type: 'more/start' })
    run(
      async () => {
        const result = await readQueue(view, nextCursor)
        if (expiredCheck(result)) return
        if (result.ok) dispatch({ type: 'more/ok', page: result.value })
        else dispatch({ type: 'more/failed', failure: result.failure })
      },
      () => {
        dispatch({ type: 'more/failed', failure: DASHBOARD_BUG })
      },
    )
  }, [expiredCheck, run])

  const runDecision = React.useCallback(
    (id: number, status: DecisionStatus) => {
      if (isDeciding(latest.current, id)) return
      // Optimistic: the row leaves the list and the queue advances before the request
      // is answered, which is what makes one keystroke per comment possible. The
      // failure path in the reducer puts it back.
      dispatch({ type: 'decide/start', id, status })
      run(
        async () => {
          const result = await decide(id, status)
          if (!result.ok) {
            // The failure is dispatched even when the session has expired, so the row
            // is restored before the screen changes. Otherwise signing back in would
            // show a queue missing the comment nobody ever moderated.
            dispatch({ type: 'decide/failed', id, failure: result.failure })
            expiredCheck(result)
            return
          }
          dispatch({ type: 'decide/ok', id, at: Date.now() })
        },
        () => {
          dispatch({ type: 'decide/failed', id, failure: DASHBOARD_BUG })
        },
      )
    },
    [expiredCheck, run],
  )

  const runUndo = React.useCallback(() => {
    const offer = latest.current.undo
    if (offer === null || offer.running) return
    dispatch({ type: 'undo/start' })
    run(
      async () => {
        // Not optimistic, unlike a decision. Undo is the rare path and the one where a
        // wrong guess is worst: showing the row back in the queue and then discovering
        // the write failed would tell the owner a comment is pending when it is spam.
        const result = await decide(offer.comment.id, offer.from)
        if (!result.ok) {
          dispatch({ type: 'undo/failed', failure: result.failure })
          expiredCheck(result)
          return
        }
        dispatch({ type: 'undo/ok' })
      },
      () => {
        dispatch({ type: 'undo/failed', failure: DASHBOARD_BUG })
      },
    )
  }, [expiredCheck, run])

  const retry = React.useCallback(() => {
    const failure = latest.current.actionFailure
    if (failure === null) return
    runDecision(failure.comment.id, failure.status)
  }, [runDecision])

  // The first page, and a fresh one on every view change.
  React.useEffect(() => {
    load(state.view)
  }, [load, state.view])

  // The next page, fetched the moment the current row *becomes* the last loaded one
  // rather than when the owner tries to move past it. That is what makes the #24 cap
  // reachable from the keyboard at all — and doing it here rather than in the key
  // handler means it also happens after a click, and after the row below the last one
  // is cleared by a decision.
  const wantsMore = shouldLoadMore(state)
  React.useEffect(() => {
    if (wantsMore) loadMore()
  }, [wantsMore, loadMore])

  // The undo window closing. The timer is derived from `offeredAt` rather than being
  // started when the bar renders, so a re-render for any other reason cannot extend it.
  React.useEffect(() => {
    const offer = state.undo
    if (offer === null || offer.running) return
    const remaining = Math.max(offer.offeredAt + UNDO_WINDOW_MS - Date.now(), 0)
    const timer = window.setTimeout(() => {
      dispatch({ type: 'undo/expire' })
    }, remaining)
    return () => {
      window.clearTimeout(timer)
    }
  }, [state.undo])

  // Focus has to land somewhere when the last comment is cleared. Without this it
  // falls to `body`, and a keyboard user is left with no position and no news at the
  // one moment worth telling them about.
  React.useEffect(() => {
    if (state.comments.length > 0) {
      hadComments.current = true
      return
    }
    if (hadComments.current && state.phase === 'ready') {
      hadComments.current = false
      emptyState.current?.focus()
    }
  }, [state.comments.length, state.phase])

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // A `KeyboardEvent` structurally satisfies `KeyStroke`, so the pure map sees the
      // real event rather than a copy of the fields somebody remembered to include.
      const command = resolveCommand(event)
      if (command === null) return

      const current = latest.current

      // While the sheet is open it owns the surface. `?` still toggles it and Escape
      // is Radix's — every other binding would be acting on a list the owner cannot
      // see, behind a modal that claims the rest of the page is hidden.
      if (current.helpOpen && command.kind !== 'help') return

      // Only now, once the keystroke is known to be ours. Calling this earlier would
      // swallow the browser's own use of every key the map does not have.
      event.preventDefault()

      switch (command.kind) {
        case 'move':
          // No fetch here: the effect above watches for the current row becoming the
          // last loaded one, so a page is pulled in whether the row was reached by a
          // keystroke, a click, or the row below it being cleared.
          dispatch({ type: 'move', delta: command.delta })
          return
        case 'decide': {
          const comment = currentComment(current)
          if (comment !== null) runDecision(comment.id, command.status)
          return
        }
        case 'undo':
          runUndo()
          return
        case 'help':
          dispatch({ type: 'help', open: !current.helpOpen })
          return
        case 'dismiss':
          dispatch({ type: 'dismiss' })
          return
        case 'view': {
          const view = VIEW_STATUSES[command.index]
          if (view !== undefined && view !== current.view) dispatch({ type: 'view', view })
          return
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [loadMore, runDecision, runUndo])

  const total = state.comments.length

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-10">
      <header className="flex flex-wrap items-center justify-between gap-3 py-6">
        <h1 className="text-lg font-semibold">Charcha moderation</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              dispatch({ type: 'help', open: true })
            }}
          >
            <KeyboardIcon aria-hidden="true" />
            Shortcuts
            <kbd aria-hidden="true" className="ml-1 text-[0.65rem] opacity-70">
              ?
            </kbd>
          </Button>
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            <LogOutIcon aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </header>

      <Tabs
        value={state.view}
        onValueChange={(value) => {
          dispatch({ type: 'view', view: value as ViewStatus })
        }}
      >
        <TabsList aria-label="Which comments to show">
          {VIEW_STATUSES.map((view, index) => (
            <TabsTrigger key={view} value={view}>
              {VIEW_LABELS[view]}
              <kbd aria-hidden="true" className="ml-1 text-[0.65rem] opacity-60">
                {index + 1}
              </kbd>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={state.view} className="mt-4">
          {state.phase === 'loading' && <QueueLoading />}

          {state.phase === 'failed' && state.loadFailure !== null && (
            <QueueFailed
              failure={state.loadFailure}
              busy={false}
              onRetry={() => {
                load(state.view)
              }}
            />
          )}

          {state.phase === 'ready' && total === 0 && (
            <QueueEmpty ref={emptyState} view={state.view} />
          )}

          {state.phase === 'ready' && total > 0 && (
            <>
              {/*
                The count is honest about what it knows. `nextCursor` non-null means
                the #24 cap was reached, so "50" would be a number the owner would
                plan their afternoon around and it would be wrong.
              */}
              <p className="pb-2 text-sm text-muted-foreground" role="status">
                {state.nextCursor === null
                  ? `${String(total)} ${total === 1 ? 'comment' : 'comments'}`
                  : `${String(total)} loaded, and there are more`}
              </p>
              <ul
                role="list"
                aria-label={`${VIEW_LABELS[state.view]} comments`}
                className="space-y-3"
              >
                {state.comments.map((comment, index) => (
                  <CommentCard
                    key={comment.id}
                    comment={comment}
                    current={comment.id === state.currentId}
                    position={index + 1}
                    total={total}
                    now={now}
                    busy={isDeciding(state, comment.id)}
                    onFocus={(id) => {
                      dispatch({ type: 'focus', id })
                    }}
                    onDecide={runDecision}
                  />
                ))}
              </ul>

              {state.moreFailure !== null && (
                <Alert variant="destructive" className="mt-3">
                  <TriangleAlertIcon />
                  <AlertTitle>Could not load the next page</AlertTitle>
                  <AlertDescription>
                    <p>
                      {state.moreFailure.message} The {String(total)} comments above are still yours
                      to act on.
                    </p>
                  </AlertDescription>
                </Alert>
              )}

              {state.nextCursor !== null && (
                <div className="pt-4">
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={state.more === 'loading'}
                    onClick={loadMore}
                  >
                    {state.more === 'loading' && (
                      <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
                    )}
                    {state.more === 'loading' ? 'Loading…' : 'Load more'}
                  </Button>
                </div>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>

      <MessageBar
        undo={state.undo}
        failure={state.actionFailure}
        announcement={state.announcement}
        onUndo={runUndo}
        onRetry={retry}
        onDismiss={() => {
          dispatch({ type: 'dismiss' })
        }}
      />

      <ShortcutSheet
        open={state.helpOpen}
        onOpenChange={(open) => {
          dispatch({ type: 'help', open })
        }}
      />
    </div>
  )
}
