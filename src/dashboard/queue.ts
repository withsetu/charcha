// The queue's state, as one pure reducer.
//
// It is pure and it is separate from the components on purpose. Almost everything
// #13 asks to be got right is a state question rather than a rendering one — that
// loading and empty are different states, that a failed decision is distinguishable
// from a successful one, that a comment removed optimistically comes back when the
// decision does not apply, that the current comment survives a page being appended —
// and a reducer is the only shape in which those can be asserted without a browser.
//
// The one required state that is deliberately *not* here is session expiry. It is not
// a state of the queue but the end of it: src/dashboard/app.tsx unmounts this whole
// component and shows the sign-in screen, so there is no stale list left for a
// keystroke to act on. A flag here would have been a second place for it to be true.
//
// Enforced by test/dashboard/queue.test.ts.

import type {
  ApiFailure,
  DecisionStatus,
  QueuePage,
  QueuedComment,
  SettableStatus,
  ViewStatus,
} from './api'

/**
 * The status a comment is being moved *from*, which is what undo moves it back to.
 *
 * It is `SettableStatus` rather than a type of its own because it is passed straight
 * back to the same endpoint: an undo is one more status write, which is exactly why
 * the brief could settle on undo instead of a confirmation dialog.
 */
export type OriginStatus = SettableStatus

/**
 * A decision that can still be taken back.
 *
 * It carries the whole comment, not just its id, because undo has to put the row
 * back where it was without a refetch: a queue that reloads on undo loses the
 * owner's position in it, which on a 200-comment page is the whole cost of the
 * mistake being undone.
 */
export interface UndoOffer {
  comment: QueuedComment
  /** Where the row sat before it was removed, so undo restores order, not just rows. */
  index: number
  from: OriginStatus
  to: DecisionStatus
  /** Milliseconds since the epoch, from the caller's clock. Drives the visible window. */
  offeredAt: number
  /** True while the undo request is in flight. */
  running: boolean
}

/** A decision that did not apply. Never silent, and never mistaken for a success. */
export interface ActionFailure {
  comment: QueuedComment
  status: DecisionStatus
  failure: ApiFailure
}

/** Something to say in the live region. `seq` forces a re-announcement of like text. */
export interface Announcement {
  text: string
  seq: number
  /** `assertive` interrupts, and is only ever used for a failure. */
  urgency: 'polite' | 'assertive'
}

/** A comment removed from the list while its decision is in flight. */
interface InFlight {
  comment: QueuedComment
  index: number
  status: DecisionStatus
}

export interface QueueState {
  view: ViewStatus
  /**
   * The first page's outcome, and the reason loading and empty cannot be confused:
   * `loading` has no answer yet, `ready` with no comments *is* the answer, and
   * `failed` is neither. A single `comments.length === 0` check cannot tell them
   * apart, which is how "no pending comments" comes to be shown to somebody whose
   * request failed.
   */
  phase: 'loading' | 'ready' | 'failed'
  comments: readonly QueuedComment[]
  /** The comment the keyboard is on. An id, not an index, so paging cannot move it. */
  currentId: number | null
  nextCursor: string | null
  more: 'idle' | 'loading'
  /** Why the first page failed. Non-null exactly when `phase` is `failed`. */
  loadFailure: ApiFailure | null
  /** Why the *next* page failed — a different state: there is still a queue on screen. */
  moreFailure: ApiFailure | null
  inFlight: readonly InFlight[]
  undo: UndoOffer | null
  actionFailure: ActionFailure | null
  helpOpen: boolean
  announcement: Announcement | null
  /**
   * Bumped for every announcement, so two identical sentences are two events.
   *
   * It is in the state rather than a counter beside the reducer because the reducer
   * has to stay pure — a module-level counter would make the same action produce a
   * different state depending on what ran before it, and the tests order-dependent.
   * A live region does not re-announce text it already holds, so "Approved: Ada" for
   * two comments by Ada would be read once without this.
   */
  announceSeq: number
}

export function initialState(view: ViewStatus = 'pending'): QueueState {
  return {
    view,
    phase: 'loading',
    comments: [],
    currentId: null,
    nextCursor: null,
    more: 'idle',
    loadFailure: null,
    moreFailure: null,
    inFlight: [],
    undo: null,
    actionFailure: null,
    helpOpen: false,
    announcement: null,
    announceSeq: 0,
  }
}

export type QueueAction =
  | { type: 'view'; view: ViewStatus }
  | { type: 'load/start' }
  | { type: 'load/ok'; page: QueuePage }
  | { type: 'load/failed'; failure: ApiFailure }
  | { type: 'more/start' }
  | { type: 'more/ok'; page: QueuePage }
  | { type: 'more/failed'; failure: ApiFailure }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'focus'; id: number }
  | { type: 'decide/start'; id: number; status: DecisionStatus }
  /** `at` is the caller's clock: the reducer has none, so the undo window is testable. */
  | { type: 'decide/ok'; id: number; at: number }
  | { type: 'decide/failed'; id: number; failure: ApiFailure }
  | { type: 'undo/start' }
  | { type: 'undo/ok' }
  | { type: 'undo/failed'; failure: ApiFailure }
  | { type: 'undo/expire' }
  | { type: 'dismiss' }
  | { type: 'help'; open: boolean }

/** How long a decision can be taken back for, in milliseconds. */
export const UNDO_WINDOW_MS = 12_000

/** The words for each status, used in announcements and in the undo bar. */
const DECIDED: Record<DecisionStatus, string> = {
  approved: 'Approved',
  spam: 'Marked spam',
  deleted: 'Deleted',
}

/**
 * An announcement and the state fields that carry it, ready to spread.
 *
 * Returns both keys together so no branch can bump the sequence without setting the
 * text, or set the text without bumping the sequence — the second of which is the
 * silent one.
 */
function say(
  state: QueueState,
  text: string,
  urgency: 'polite' | 'assertive' = 'polite',
): Pick<QueueState, 'announcement' | 'announceSeq'> {
  const seq = state.announceSeq + 1
  return { announcement: { text, seq, urgency }, announceSeq: seq }
}

/** Whether a decision on this comment is already in flight. Guards a double keystroke. */
export function isDeciding(state: QueueState, id: number): boolean {
  return state.inFlight.some((entry) => entry.comment.id === id)
}

export function currentComment(state: QueueState): QueuedComment | null {
  return state.comments.find((comment) => comment.id === state.currentId) ?? null
}

/**
 * Whether the current comment is the last one loaded and there is another page.
 *
 * The caller uses it to fetch the next page when `J` runs off the end, which is what
 * makes the #24 cap reachable from the keyboard rather than only from the button.
 */
export function shouldLoadMore(state: QueueState): boolean {
  if (state.nextCursor === null || state.more === 'loading') return false
  // **A recorded failure stops the automatic fetch, and this line is load-bearing.**
  // The condition is otherwise still true after `more/failed` — same cursor, same
  // current row — so the caller's effect would fire again immediately and keep firing:
  // a failing endpoint hammered in a loop, with the owner watching an alert flicker.
  // Once it has failed, the next page is the "Load more" button's to ask for, and
  // pressing it clears this.
  if (state.moreFailure !== null) return false
  const last = state.comments.at(-1)
  return last !== undefined && last.id === state.currentId
}

/** The status a comment is in now, narrowed to the four the column allows. */
function originOf(comment: QueuedComment): OriginStatus {
  switch (comment.status) {
    case 'approved':
    case 'spam':
    case 'deleted':
      return comment.status
    default:
      // Anything the wire calls something else is treated as pending, which is the
      // status that puts a comment back in the triage queue — the safe direction for
      // an undo to move it, because it is the one that publishes nothing.
      return 'pending'
  }
}

/**
 * The id the keyboard should land on after the row at `index` is taken out.
 *
 * This one line is the auto-advance the brief settles on: the row below slides into
 * the vacated index and becomes current, so one keystroke per comment clears a queue.
 * At the end of the list it falls back to the row above, and to null on the last one
 * — where the caller moves focus to the empty state rather than letting it drop to
 * `body`.
 */
function afterRemoval(remaining: readonly QueuedComment[], index: number): number | null {
  return remaining[index]?.id ?? remaining[index - 1]?.id ?? null
}

function insertAt(
  comments: readonly QueuedComment[],
  comment: QueuedComment,
  index: number,
): QueuedComment[] {
  const next = [...comments]
  next.splice(Math.min(Math.max(index, 0), next.length), 0, comment)
  return next
}

/** The verb for a failed decision, so the message names what was attempted. */
const ATTEMPTED: Record<DecisionStatus, string> = {
  approved: 'approve',
  spam: 'mark spam',
  deleted: 'delete',
}

export function reduce(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'view':
      // A view change is a new queue, and everything about the old one goes with it —
      // including a pending undo, which names a row that is no longer on screen.
      // `helpOpen` survives because the sheet is about the surface, not the queue.
      return { ...initialState(action.view), helpOpen: state.helpOpen }

    case 'load/start':
      return { ...state, phase: 'loading', loadFailure: null, moreFailure: null }

    case 'load/ok':
      return {
        ...state,
        phase: 'ready',
        comments: action.page.comments,
        currentId: action.page.comments[0]?.id ?? null,
        nextCursor: action.page.nextCursor,
        loadFailure: null,
      }

    case 'load/failed':
      // `phase: 'failed'` and not an empty `ready`. The two look identical on screen
      // if the phase is dropped, and only one of them means the owner is finished.
      return {
        ...state,
        phase: 'failed',
        comments: [],
        currentId: null,
        loadFailure: action.failure,
      }

    case 'more/start':
      return { ...state, more: 'loading', moreFailure: null }

    case 'more/ok': {
      const comments = [...state.comments, ...action.page.comments]
      return {
        ...state,
        more: 'idle',
        comments,
        // The current row is named by id, so appending cannot move it. It is only set
        // here when there was nothing to be on.
        currentId: state.currentId ?? comments[0]?.id ?? null,
        nextCursor: action.page.nextCursor,
      }
    }

    case 'more/failed':
      // Not `phase: 'failed'`: the queue on screen is still real and still actionable.
      // Turning this into the whole-page error state would throw away comments the
      // owner can act on, to report that there might be more.
      return { ...state, more: 'idle', moreFailure: action.failure }

    case 'move': {
      if (state.comments.length === 0) return state
      const at = state.comments.findIndex((comment) => comment.id === state.currentId)
      const from = at === -1 ? (action.delta === 1 ? -1 : state.comments.length) : at
      const to = Math.min(Math.max(from + action.delta, 0), state.comments.length - 1)
      const target = state.comments[to]
      return target === undefined ? state : { ...state, currentId: target.id }
    }

    case 'focus':
      return state.comments.some((comment) => comment.id === action.id)
        ? { ...state, currentId: action.id }
        : state

    case 'decide/start': {
      const index = state.comments.findIndex((comment) => comment.id === action.id)
      const comment = state.comments[index]
      if (comment === undefined || isDeciding(state, action.id)) return state

      const comments = state.comments.filter((candidate) => candidate.id !== action.id)
      return {
        ...state,
        comments,
        currentId: state.currentId === action.id ? afterRemoval(comments, index) : state.currentId,
        inFlight: [...state.inFlight, { comment, index, status: action.status }],
        // A new decision replaces the offer to undo the previous one. `Z` means "take
        // back what I just did", and holding two offers would make it ambiguous which.
        undo: null,
        actionFailure: null,
      }
    }

    case 'decide/ok': {
      const entry = state.inFlight.find((candidate) => candidate.comment.id === action.id)
      if (entry === undefined) return state
      return {
        ...state,
        inFlight: state.inFlight.filter((candidate) => candidate.comment.id !== action.id),
        undo: {
          comment: entry.comment,
          index: entry.index,
          from: originOf(entry.comment),
          to: entry.status,
          offeredAt: action.at,
          running: false,
        },
        ...say(state, `${DECIDED[entry.status]}: ${entry.comment.authorName}. Press Z to undo.`),
      }
    }

    case 'decide/failed': {
      const entry = state.inFlight.find((candidate) => candidate.comment.id === action.id)
      if (entry === undefined) return state
      // The row goes back where it was. An optimistic removal that is not undone on
      // failure is the worst outcome this surface has: the comment is still pending
      // and the queue says otherwise, so the moderator believes they are finished.
      return {
        ...state,
        comments: insertAt(state.comments, entry.comment, entry.index),
        // **The keyboard goes back to the restored comment, and that is not cosmetic.**
        // `decide/start` had already advanced past it. Leaving current where the
        // auto-advance put it means the owner reads "Could not approve the comment by
        // X", presses `A` to retry, and approves the comment *below* X instead — the
        // message on screen and the comment the next keystroke acts on have to be the
        // same one. Found by driving it in a browser; tests were green either way.
        currentId: entry.comment.id,
        inFlight: state.inFlight.filter((candidate) => candidate.comment.id !== action.id),
        actionFailure: { comment: entry.comment, status: entry.status, failure: action.failure },
        ...say(
          state,
          `Could not ${ATTEMPTED[entry.status]} the comment by ${entry.comment.authorName}. ${action.failure.message}`,
          'assertive',
        ),
      }
    }

    case 'undo/start':
      return state.undo === null || state.undo.running
        ? state
        : { ...state, undo: { ...state.undo, running: true }, actionFailure: null }

    case 'undo/ok': {
      const offer = state.undo
      if (offer === null) return state
      // Restored only into the view it belongs to. Undoing an approval while looking
      // at the approved queue puts the row back in the *pending* queue, which is not
      // this list — so the announcement is the whole of the feedback there.
      const restores = offer.from === state.view
      const comments = restores
        ? insertAt(state.comments, { ...offer.comment, status: offer.from }, offer.index)
        : state.comments
      return {
        ...state,
        comments,
        currentId: restores ? offer.comment.id : state.currentId,
        undo: null,
        ...say(state, `Undone: the comment by ${offer.comment.authorName} is ${offer.from} again.`),
      }
    }

    case 'undo/failed': {
      const offer = state.undo
      if (offer === null) return state
      return {
        ...state,
        undo: null,
        actionFailure: { comment: offer.comment, status: offer.to, failure: action.failure },
        ...say(state, `Could not undo. ${action.failure.message}`, 'assertive'),
      }
    }

    case 'undo/expire':
      // The window closing is not news, so it is not announced: a live region that
      // says "you can no longer undo" interrupts the next comment being read out.
      return state.undo === null || state.undo.running ? state : { ...state, undo: null }

    case 'dismiss':
      return { ...state, actionFailure: null, moreFailure: null, undo: null }

    case 'help':
      return { ...state, helpOpen: action.open }
  }
}
