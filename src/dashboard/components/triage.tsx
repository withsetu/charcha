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
import {
  GlobeIcon,
  KeyboardIcon,
  LoaderCircleIcon,
  LogOutIcon,
  TriangleAlertIcon,
} from 'lucide-react'

import type { ApiFailure, ApiResult, DecisionStatus, QueueCounts, ViewStatus } from '../api'
import { decide, readQueue } from '../api'
import type { Command } from '../keys'
import { resolveCommand } from '../keys'
import {
  TAB_VALUES,
  UNDO_WINDOW_MS,
  currentComment,
  initialState,
  isDeciding,
  reduce,
  shouldLoadMore,
} from '../queue'
import type { TabValue } from '../queue'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Kbd } from '../ui/kbd'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { CommentCard } from './comment-card'
import { MessageBar } from './message-bar'
import { Setup } from './setup'
import { ShortcutSheet } from './shortcut-sheet'
import { SiteSettings } from './site-settings'
import { QueueEmpty, QueueFailed, QueueLoading } from './states'

const VIEW_LABELS: Record<ViewStatus, string> = {
  pending: 'Pending',
  spam: 'Spam',
  approved: 'Approved',
}

/** Every tab's visible name. Setup (#158) is the one that is not a queue. */
const TAB_LABELS: Record<TabValue, string> = { ...VIEW_LABELS, setup: 'Setup' }

/**
 * The commands that act on the queue, and so must not fire while Setup is in front.
 *
 * The queue is still in state behind that tab — leaving it there is what makes coming
 * back free — so without this, `A` on the Setup tab would approve a comment the owner
 * cannot see, and `Z` would undo something they can no longer read. Named as a set
 * rather than checked inline so that a command added later is a decision about this list
 * instead of an omission from a condition.
 * Enforced by test/dashboard/shortcuts.test.tsx.
 */
const QUEUE_COMMANDS: ReadonlySet<Command['kind']> = new Set<Command['kind']>([
  'move',
  'decide',
  'undo',
])

/** `53 comments`, or `1 comment`. Both places that count comments say it this way. */
function commentCount(n: number): string {
  return `${String(n)} ${n === 1 ? 'comment' : 'comments'}`
}

/**
 * A tab's accessible name (#135).
 *
 * The count is spelled out here rather than left to the trigger's text content, which
 * would compute to "Pending 53" — exactly as ambiguous read aloud as the bug was on
 * screen. The visible label is still a prefix of this, so a voice-control user asking
 * for "Pending" is asking for something that matches (WCAG 2.5.3).
 *
 * A null count is a count nobody has answered for yet, and the name says only the view:
 * an accessible name claiming "0 comments" before the first response asserts an empty
 * queue on no evidence. Setup is always that case — it holds no comments, so it never
 * carries a number, on screen or in its name.
 * Enforced by test/dashboard/triage.test.tsx.
 */
function tabName(tab: TabValue, count: number | null): string {
  return count === null ? TAB_LABELS[tab] : `${TAB_LABELS[tab]}, ${commentCount(count)}`
}

/**
 * How many comments a tab's badge should claim, or null for no badge at all.
 *
 * Setup is null unconditionally, and that is #135's rule rather than a special case: the
 * number beside a queue's name is how many things are in it, so a tab that holds nothing
 * countable must not put a digit in that slot. The keycap beside it is a keycap.
 * Enforced by test/dashboard/triage.test.tsx.
 */
function tabCount(tab: TabValue, counts: QueueCounts | null): number | null {
  return tab === 'setup' ? null : (counts?.[tab] ?? null)
}

/**
 * The line above the queue: how much of it is on screen (#135).
 *
 * **The branch is on the two numbers rather than on `nextCursor`, and that is what keeps
 * it honest between a decision starting and landing.** The row leaves the list
 * optimistically while the count is still the server's previous answer, so for that
 * moment `loaded` is one behind `total` — `Showing 49 of 50` says exactly that, where a
 * cursor-driven branch would have claimed a flat "50 comments" over 49 visible rows.
 *
 * It still refuses to print a total it does not have. The #24 cap means the loaded count
 * is not the queue's size, which is why the old wording avoided a bare number at all;
 * `total === null` is intended to be the pre-answer case only, since `phase` is `ready`
 * exactly when a page has arrived and every page carries counts.
 * Enforced by test/dashboard/triage.test.tsx.
 */
function summaryLine(loaded: number, total: number | null): string {
  if (total === null) return commentCount(loaded)
  return loaded < total ? `Showing ${String(loaded)} of ${String(total)}` : commentCount(total)
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

  // The listener below is registered once, so it needs the current state without being
  // re-registered on every keystroke: re-attaching a document listener 200 times while a
  // queue is cleared is work that buys nothing.
  //
  // **Assigned during render, not in an effect, and that is deliberate.** React's
  // guidance is to avoid writing refs while rendering, and the alternative here is
  // worse: passive effects flush after paint, so a keystroke landing between the commit
  // and the flush would be handled against the previous state — which on this surface
  // means a decision applied to the comment that was current a moment ago. The
  // assignment is idempotent and reads nothing, so a double render under StrictMode
  // writes the same value twice. This component uses no concurrent feature that could
  // discard the render it belongs to.
  const latest = React.useRef(state)
  latest.current = state

  const emptyState = React.useRef<HTMLDivElement>(null)
  const hadComments = React.useRef(false)

  /**
   * Whether the allowed-origins panel is open (#57).
   *
   * Local state and not a field on the queue's reducer, because it is not queue state:
   * nothing in `reduce` reads it and nothing it does affects a comment. The ref beside
   * it is what the document key listener needs — that listener is registered once and
   * reads refs rather than being re-attached, so a `useState` alone would leave it
   * acting on a stale value. Assigned during render for the same reason `latest` is:
   * an effect flushes after paint, and a keystroke landing in between would be handled
   * against the previous value — which here means `s` marking a comment spam behind an
   * open modal.
   */
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const settingsIsOpen = React.useRef(settingsOpen)
  settingsIsOpen.current = settingsOpen

  /**
   * The clock reading of the last successful allowlist save (#158).
   *
   * The Setup tab reads the allowlist for itself, and the dialog above can change it
   * while that tab is on screen — so without this, an owner who saved would be looking
   * at the list as it was before they edited it, in the one place they went to check the
   * edit had landed. A value rather than a boolean because it has to change on *every*
   * save, including two identical ones.
   */
  const [originsSavedAt, setOriginsSavedAt] = React.useState(0)
  const onOriginsSaved = React.useCallback(() => {
    setOriginsSavedAt(Date.now())
  }, [])

  const openOrigins = React.useCallback(() => {
    setSettingsOpen(true)
  }, [])

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
          dispatch({ type: 'decide/ok', id, at: Date.now(), counts: result.value.counts })
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
        dispatch({ type: 'undo/ok', counts: result.value.counts })
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

      // While the settings panel is open it owns the surface completely — including
      // `?`, unlike the shortcut sheet, because opening a second dialog over an
      // unsaved textarea would put the owner's typing behind a modal. Escape is
      // Radix's and closes the panel. Returning before `preventDefault` below is what
      // leaves the browser's own use of every key intact inside the form.
      if (settingsIsOpen.current) return

      // While the sheet is open it owns the surface. `?` still toggles it and Escape
      // is Radix's — every other binding would be acting on a list the owner cannot
      // see, behind a modal that claims the rest of the page is hidden.
      if (current.helpOpen && command.kind !== 'help') return

      // The Setup tab has no queue in front of it, and the loaded one is still in state
      // behind it — so a decision key here would act on a comment nobody can see. Tab
      // switching, the sheet and Escape still work, which is what keeps `1` a way back.
      // Returning before `preventDefault` leaves the browser's own use of the key intact,
      // which on a tab full of prose and a scrollable command block is what arrow keys
      // are for.
      if (current.tab === 'setup' && QUEUE_COMMANDS.has(command.kind)) return

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
        case 'tab': {
          const tab = TAB_VALUES[command.index]
          if (tab !== undefined) dispatch({ type: 'tab', tab })
          return
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [loadMore, runDecision, runUndo])

  // How many rows are on screen, which is not how many are in the queue: the read is
  // capped at 50 (#24), and the total comes from the counts the server sends (#135).
  const loaded = state.comments.length
  const total = state.counts?.[state.view] ?? null

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-10">
      <header className="flex flex-wrap items-center justify-between gap-3 py-6">
        <h1 className="text-lg font-semibold">Charcha moderation</h1>
        <div className="flex items-center gap-2">
          {/*
            No keyboard shortcut, deliberately, and it is the only header control
            without one. Every binding in src/dashboard/keys.ts is a bare letter that
            costs one keystroke to fire by accident; this one opens a panel over the
            queue and is used about twice in a deployment's life. The letters are worth
            more on the queue.
          */}
          <Button variant="ghost" size="sm" onClick={openOrigins}>
            <GlobeIcon aria-hidden="true" />
            Allowed origins
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              dispatch({ type: 'help', open: true })
            }}
          >
            <KeyboardIcon aria-hidden="true" />
            Shortcuts
            <Kbd aria-hidden="true">?</Kbd>
          </Button>
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            <LogOutIcon aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </header>

      <Tabs
        value={state.tab}
        onValueChange={(value) => {
          dispatch({ type: 'tab', tab: value as TabValue })
        }}
      >
        {/*
          Not "which comments to show" any more: the strip holds a tab that shows no
          comments at all (#158), and a list label that describes three of its four
          children is a label a screen-reader user has to work around.
        */}
        <TabsList aria-label="Sections">
          {TAB_VALUES.map((tab, index) => {
            // The number beside a queue's name is how many comments are in it, which is
            // what every inbox has taught everyone to read it as — and what #135 was: the
            // shortcut hint sat in that slot with no keycap on it. The count is plain
            // text and the shortcut wears the whole of the ornament, so the two cannot be
            // read as the same kind of thing.
            //
            // Plain text rather than a `Badge`, for a reason specific to this theme:
            // `--secondary` and `--muted` are the same value in src/dashboard/styles.css,
            // so a secondary badge has no contrast at all against the `bg-muted` an
            // inactive tab shows — and an outline badge would give the count the same
            // bordered-chip shape as the keycap beside it.
            const count = tabCount(tab, state.counts)
            return (
              <TabsTrigger key={tab} value={tab} aria-label={tabName(tab, count)}>
                {TAB_LABELS[tab]}
                {count !== null && (
                  // `tabular-nums` so a count changing under the owner's cursor does not
                  // shift the keycap beside it.
                  <span data-slot="tab-count" className="tabular-nums">
                    {count}
                  </span>
                )}
                {/*
                  Hidden from assistive technology on purpose: it is a reminder for the
                  eye, the accessible name above already says what the tab is, and the
                  shortcut sheet is the accessible route to the bindings.
                */}
                <Kbd aria-hidden="true">{index + 1}</Kbd>
              </TabsTrigger>
            )
          })}
        </TabsList>

        {/*
          The Setup tab (#158). Its own `TabsContent`, so Radix unmounts it when another
          tab is chosen — which is what makes every visit a fresh read of what is
          configured, with no cache to go stale after somebody sets a secret in another
          window.
        */}
        <TabsContent value="setup" className="mt-4">
          <Setup
            onEditOrigins={openOrigins}
            onExpired={onExpired}
            originsSavedAt={originsSavedAt}
          />
        </TabsContent>

        {/*
          The queue's panel is keyed on `view` rather than `tab`, so it is the inactive
          one exactly while Setup is in front. The reducer keeps the loaded page through
          that, which is why coming back costs no request — see the `tab` case in
          src/dashboard/queue.ts.
        */}
        <TabsContent value={state.view} className="mt-4">
          {state.phase === 'loading' && <QueueLoading />}

          {state.phase === 'failed' && state.loadFailure !== null && (
            <QueueFailed
              failure={state.loadFailure}
              onRetry={() => {
                load(state.view)
              }}
            />
          )}

          {state.phase === 'ready' && loaded === 0 && (
            <QueueEmpty ref={emptyState} view={state.view} />
          )}

          {state.phase === 'ready' && loaded > 0 && (
            <>
              {/*
                Deliberately not a live region. It changes on every decision, and the
                decision is already announced — "49 of 53" read out after "Approved: Ada
                Lovelace. Press Z to undo." is two sentences per keystroke, which is how
                a moderator learns to turn the screen reader off. The wording itself is
                summaryLine, above.
              */}
              <p className="pb-2 text-sm text-muted-foreground">{summaryLine(loaded, total)}</p>
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
                    total={loaded}
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
                      {state.moreFailure.message} The {String(loaded)} comments above are still
                      yours to act on.
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
        // Hidden, not unmounted: the live region inside it has to keep announcing a
        // decision that resolves after the owner has switched to Setup. Its two buttons
        // would otherwise be the way round the keyboard guard above — see `hidden` in
        // src/dashboard/components/message-bar.tsx.
        hidden={state.tab === 'setup'}
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

      <SiteSettings
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onExpired={onExpired}
        onSaved={onOriginsSaved}
      />
    </div>
  )
}
