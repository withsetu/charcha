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

import { VIEW_STATUSES } from './api'
import type {
  ApiFailure,
  DecisionStatus,
  QueueCounts,
  QueuePage,
  QueuedComment,
  SettableStatus,
  ViewStatus,
} from './api'

/**
 * A tab in the strip: the three queues, and Setup (#158).
 *
 * `'setup'` is not a `ViewStatus` and deliberately never becomes one — it is not a
 * status a comment can be in, nothing is ever fetched with `?status=setup`, and widening
 * `ViewStatus` to hold it would put a value the server rejects into the type the queue
 * request is built from.
 */
export type TabValue = ViewStatus | 'setup'

/**
 * The tabs, in the order they are shown — which is also the order `1`…`4` select them
 * in, since src/dashboard/keys.ts resolves those keys to an index into this.
 * Enforced by test/dashboard/shortcuts.test.tsx.
 */
export const TAB_VALUES: readonly TabValue[] = [...VIEW_STATUSES, 'setup']

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
  /**
   * How many replies the decision took with it, as the server counted them (#133).
   *
   * Carried on the offer because it is what the bar and the announcement have to
   * disclaim: undo re-issues one status write for this comment, and MODERATE_SQL only
   * cascades *to* spam and deleted — so the replies stay where the decision put them.
   * Restoring them would need each one's prior status, which no row records: a reply
   * that was already spam must not come back as pending. #163 is that record.
   * Enforced by test/dashboard/queue.test.ts.
   */
  cascaded: number
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

/** A row and where it sat, so a restore puts back the order and not only the rows. */
interface Removed {
  comment: QueuedComment
  index: number
}

/** A comment removed from the list while its decision is in flight. */
interface InFlight {
  comment: QueuedComment
  index: number
  status: DecisionStatus
  /**
   * The replies removed alongside it, each with its own index in the list as it was.
   *
   * Held so `decide/failed` can put the whole cascade back where it was, not just the
   * comment the owner pressed a key on.
   * Enforced by test/dashboard/queue.test.ts.
   */
  alsoRemoved: readonly Removed[]
}

export interface QueueState {
  /**
   * Which queue is loaded, which is not the same question as which tab is showing.
   *
   * It stays put while the Setup tab is in front, because Setup is not a queue: coming
   * back to Pending must not re-read a page the owner was halfway through. Every field
   * below except `tab` describes *this* queue.
   */
  view: ViewStatus
  /**
   * Which tab is showing (#158).
   *
   * Separate from `view` rather than widening it, so that the effect which loads a queue
   * — keyed on `view` — cannot fire for a tab that has no queue to load.
   * Enforced by test/dashboard/queue.test.ts.
   */
  tab: TabValue
  /**
   * The first page's outcome, and the reason loading and empty cannot be confused:
   * `loading` has no answer yet, `ready` with no comments *is* the answer, and
   * `failed` is neither. A single `comments.length === 0` check cannot tell them
   * apart, which is how "no pending comments" comes to be shown to somebody whose
   * request failed.
   */
  phase: 'loading' | 'ready' | 'failed'
  comments: readonly QueuedComment[]
  /**
   * How many comments each view holds, or null before anybody has said (#135).
   *
   * **Null and zero are different states and the tabs render them differently**: null
   * shows no count, `0` shows one. Collapsing them would make a queue nobody has
   * answered for yet look like a queue that has been cleared — the same confusion
   * `phase` exists to prevent one level up.
   *
   * It is not per-view state. It describes the whole database, so it outlives a view
   * change, and it is never derived from `comments.length` — the page is capped at 50
   * (#24) and the count is what the tabs are claiming.
   * Enforced by test/dashboard/queue.test.ts.
   */
  counts: QueueCounts | null
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
    tab: view,
    phase: 'loading',
    comments: [],
    counts: null,
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
  | { type: 'tab'; tab: TabValue }
  | { type: 'load/start' }
  | { type: 'load/ok'; page: QueuePage }
  | { type: 'load/failed'; failure: ApiFailure }
  | { type: 'more/start' }
  | { type: 'more/ok'; page: QueuePage }
  | { type: 'more/failed'; failure: ApiFailure }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'focus'; id: number }
  | { type: 'decide/start'; id: number; status: DecisionStatus }
  /**
   * `at` is the caller's clock: the reducer has none, so the undo window is testable.
   * `counts` is the server's recount, which the reducer stores and never adjusts, and
   * `cascaded` is how many replies went with the comment (#133).
   */
  | { type: 'decide/ok'; id: number; at: number; counts: QueueCounts; cascaded: number }
  | { type: 'decide/failed'; id: number; failure: ApiFailure }
  | { type: 'undo/start' }
  | { type: 'undo/ok'; counts: QueueCounts }
  | { type: 'undo/failed'; failure: ApiFailure }
  | { type: 'undo/expire' }
  | { type: 'dismiss' }
  | { type: 'help'; open: boolean }

/** How long a decision can be taken back for, in milliseconds. */
export const UNDO_WINDOW_MS = 12_000

/**
 * The two ways this surface names a decision, in one place because both the
 * announcement built below and the visible bar in
 * src/dashboard/components/message-bar.tsx need them.
 *
 * They were briefly two copies, and the copies disagreed: the bar said "Could not mark
 * spam on the comment by X" and the announcement said "Could not mark spam the comment
 * by X". A screen-reader user got the ungrammatical one, and the test asserting
 * `toContain('mark spam')` passed either way — which is why they are exported from here
 * rather than retyped there.
 */
export const DECIDED: Record<DecisionStatus, string> = {
  approved: 'Approved',
  spam: 'Marked spam',
  deleted: 'Deleted',
}

/** The verb for an attempt that failed, phrased to precede "the comment by X". */
export const ATTEMPTED: Record<DecisionStatus, string> = {
  approved: 'approve',
  spam: 'mark spam on',
  deleted: 'delete',
}

/**
 * The status a cascaded reply is left in, phrased to follow "stays" or "stay".
 *
 * `approved` is present so the map is total over `DecisionStatus`. Approving does not
 * cascade, so `cascaded` is zero for it and every caller below is behind a
 * `cascaded > 0` guard — see setCommentStatus in src/db, asserted by
 * test/worker/db/comments.test.ts.
 */
const LEFT_AS: Record<DecisionStatus, string> = {
  approved: 'approved',
  spam: 'spam',
  deleted: 'deleted',
}

/**
 * What a decision did, in one phrase: the decision, whose comment, and how many
 * replies went with it (#133).
 *
 * Exported because the visible bar in src/dashboard/components/message-bar.tsx and the
 * live-region announcement built below must say the same thing. They were two copies
 * once for the failure wording, and the copies disagreed — see DECIDED above.
 * Enforced by test/dashboard/queue.test.ts and test/dashboard/triage.test.tsx.
 */
export function decisionSummary(
  status: DecisionStatus,
  authorName: string,
  cascaded: number,
): string {
  if (cascaded === 0) return `${DECIDED[status]}: ${authorName}`
  const replies = cascaded === 1 ? '1 reply' : `${String(cascaded)} replies`
  return `${DECIDED[status]}: ${authorName}, and ${replies}`
}

/**
 * What undo will *not* do, or null when the decision took nothing else with it.
 *
 * The honest half of #133's second question. Undo restores the comment and leaves the
 * replies where the decision put them, so the offer has to say so — an undo that
 * claims to have undone something it partly did is worse than one that does less.
 * Enforced by test/dashboard/queue.test.ts and test/dashboard/triage.test.tsx.
 */
export function repliesStay(offer: Pick<UndoOffer, 'to' | 'cascaded'>): string | null {
  if (offer.cascaded === 0) return null
  return offer.cascaded === 1
    ? `The reply under it stays ${LEFT_AS[offer.to]}.`
    : `The ${String(offer.cascaded)} replies stay ${LEFT_AS[offer.to]}.`
}

/**
 * The same fact in the past tense, for after the undo has happened.
 *
 * A separate sentence rather than reusing repliesStay, because "stay" before the fact
 * is an intention and "are still" after it is a report, and the moment a moderator
 * needs to be told is the one where they have just pressed `Z` and the count did not
 * go back where they expected.
 * Enforced by test/dashboard/queue.test.ts.
 */
function repliesStayed(offer: UndoOffer): string | null {
  if (offer.cascaded === 0) return null
  return offer.cascaded === 1
    ? `Its reply is still ${LEFT_AS[offer.to]}.`
    : `Its ${String(offer.cascaded)} replies are still ${LEFT_AS[offer.to]}.`
}

/**
 * A count from the wire, reduced to a number this surface can put in a sentence.
 *
 * The server sends `cascaded` on every decision (src/admin/route.ts), so a value that
 * is not a whole number means a proxy, a Worker mid-deploy, or a dashboard talking to
 * an older deployment. Zero is the safe answer: it under-claims, where the alternative
 * is "and undefined replies" read out in a live region.
 * Enforced by test/dashboard/queue.test.ts.
 */
function countOfReplies(cascaded: number): number {
  return Number.isInteger(cascaded) && cascaded > 0 ? cascaded : 0
}

/**
 * Whether this decision hides the replies under the comment.
 *
 * Mirrors `?2 in ('spam', 'deleted')` in MODERATE_SQL, which is the authority — the
 * server cascades whether or not this agrees, so the only thing at stake here is
 * whether the screen matches what the server did.
 * Enforced by test/dashboard/queue.test.ts.
 */
function cascadesToReplies(status: DecisionStatus): boolean {
  return status === 'spam' || status === 'deleted'
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

export function reduce(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'tab': {
      if (action.tab === state.tab) return state

      // Setup is not a queue, so the loaded one is left exactly as it was and coming
      // back costs no request and no lost position.
      //
      // `moreFailure` is deliberately **not** cleared with the other two. It is not a
      // message-bar field — it renders inside the queue's own panel — and
      // `shouldLoadMore` reads it as the latch that stops the next-page effect firing
      // again after a failure. Clearing it here would re-arm that effect against a panel
      // nobody is looking at, which the comment on `shouldLoadMore` calls load-bearing.
      if (action.tab === 'setup') {
        return { ...state, tab: 'setup', undo: null, actionFailure: null }
      }

      // Back to the queue that is already loaded — after a trip to Setup, since any
      // other route here would have changed `view`. **Not a reset, and that is
      // load-bearing rather than an optimisation**: resetting would set `phase` to
      // `loading` while leaving `view` untouched, and the effect that fetches is keyed
      // on `view` — so nothing would ask for the page and the skeleton would stand for
      // ever, which is precisely the unreported-failure shape CLAUDE.md names.
      if (action.tab === state.view) return { ...state, tab: action.tab }

      // A different queue is a new queue, and everything about the old one goes with it
      // — including a pending undo, which names a row that is no longer on screen.
      // `helpOpen` survives because the sheet is about the surface, not the queue, and
      // `counts` survives because they are the whole database's numbers: dropping them
      // would blank all three tab badges on every switch and then refill them with the
      // values that were true throughout.
      return { ...initialState(action.tab), helpOpen: state.helpOpen, counts: state.counts }
    }

    case 'load/start':
      return { ...state, phase: 'loading', loadFailure: null, moreFailure: null }

    case 'load/ok':
      return {
        ...state,
        phase: 'ready',
        comments: action.page.comments,
        counts: action.page.counts,
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
        counts: action.page.counts,
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

      // **The replies go with it, and this is #133's visible half.** The server hides
      // them (MODERATE_SQL), so a list that keeps them shows comments the server no
      // longer considers pending — under a tab count that has already moved, with live
      // Approve buttons that would publish a reply beneath a comment the moderator has
      // just hidden. The predicate mirrors the statement in both halves: the cascade is
      // to spam and deleted only, and a reply already in the target status does not move.
      const alsoRemoved: Removed[] = cascadesToReplies(action.status)
        ? state.comments.flatMap((candidate, at) =>
            candidate.parentId === action.id && candidate.status !== action.status
              ? [{ comment: candidate, index: at }]
              : [],
          )
        : []

      const removed = new Set([action.id, ...alsoRemoved.map((entry) => entry.comment.id)])
      const comments = state.comments.filter((candidate) => !removed.has(candidate.id))
      // Where the comment sat once the replies above it are gone, so the auto-advance
      // lands on the row that is really next rather than one slot past it.
      const landing = state.comments
        .slice(0, index)
        .filter((candidate) => !removed.has(candidate.id)).length
      return {
        ...state,
        comments,
        // The keyboard may have been on one of the replies rather than on the comment —
        // a decision taken with the mouse, or by Tab into another row's buttons — so the
        // test is whether the current row survived, not whether it was the one decided.
        currentId:
          state.currentId !== null && removed.has(state.currentId)
            ? afterRemoval(comments, landing)
            : state.currentId,
        inFlight: [...state.inFlight, { comment, index, status: action.status, alsoRemoved }],
        // A new decision replaces the offer to undo the previous one. `Z` means "take
        // back what I just did", and holding two offers would make it ambiguous which.
        undo: null,
        actionFailure: null,
      }
    }

    case 'decide/ok': {
      const entry = state.inFlight.find((candidate) => candidate.comment.id === action.id)
      if (entry === undefined) return state
      const cascaded = countOfReplies(action.cascaded)
      const offer: UndoOffer = {
        comment: entry.comment,
        index: entry.index,
        from: originOf(entry.comment),
        to: entry.status,
        cascaded,
        offeredAt: action.at,
        running: false,
      }
      // What the decision did, and — when it took replies with it — what `Z` will and
      // will not put back (#133). Said in the same breath as the offer of `Z`, because
      // the moment to learn that undo is partial is before pressing it.
      const summary = decisionSummary(entry.status, entry.comment.authorName, cascaded)
      const scope = repliesStay(offer)
      return {
        ...state,
        // The server's recount, stored rather than adjusted: the decision cascades to
        // the replies under the comment, so `pending - 1` would be wrong by however
        // many there were. See handleCommentStatus in src/admin/route.ts.
        counts: action.counts,
        inFlight: state.inFlight.filter((candidate) => candidate.comment.id !== action.id),
        undo: offer,
        // **The `Z` prompt is dropped when the decision lands on the Setup tab.** `S`
        // then `4` before the request answers is two keystrokes on a surface built for
        // one per comment, and it resolves with the queue out of sight — where the bar
        // is hidden and `Z` is one of the commands the tab refuses (see QUEUE_COMMANDS
        // in src/dashboard/components/triage.tsx). Announcing a keystroke that does
        // nothing is worse than announcing none. The offer itself survives, so the bar
        // and the key both come back with the queue if the window has not closed.
        //
        // The count of replies is said either way: it is what the decision *did*, not an
        // invitation to press anything, and it is the one part of a cascade the tab the
        // owner is looking at cannot explain.
        // Enforced by test/dashboard/queue.test.ts.
        ...say(
          state,
          state.tab === 'setup'
            ? `${summary}.`
            : scope === null
              ? `${summary}. Press Z to undo.`
              : `${summary}. Press Z to undo ${entry.comment.authorName}. ${scope}`,
        ),
      }
    }

    case 'decide/failed': {
      const entry = state.inFlight.find((candidate) => candidate.comment.id === action.id)
      if (entry === undefined) return state
      // The rows go back where they were — all of them, including the replies the
      // cascade took off the screen with the comment. An optimistic removal that is not
      // undone on failure is the worst outcome this surface has: the comments are still
      // pending and the queue says otherwise, so the moderator believes they are
      // finished. Ascending by index, which is what makes re-inserting a set of rows
      // reconstruct the list rather than approximate it: every earlier insert restores
      // the position the next one's index was recorded against.
      // Enforced by test/dashboard/queue.test.ts.
      const restored = [{ comment: entry.comment, index: entry.index }, ...entry.alsoRemoved]
        .sort((left, right) => left.index - right.index)
        .reduce<readonly QueuedComment[]>(
          (list, row) => insertAt(list, row.comment, row.index),
          state.comments,
        )
      return {
        ...state,
        comments: restored,
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
      // **The replies are not restored, and the announcement says so (#133).** Undo is
      // one more status write on this comment, and putting the cascade back would need
      // each reply's status from *before* the decision — a reply that was already spam
      // must not come back as pending, and no row records what it used to be. So the
      // scope is the comment, stated rather than implied: "Undone" on its own claims
      // more than happened, which is the failure mode this issue is about.
      // Enforced by test/dashboard/queue.test.ts.
      const stayed = repliesStayed(offer)
      return {
        ...state,
        comments,
        counts: action.counts,
        currentId: restores ? offer.comment.id : state.currentId,
        undo: null,
        ...say(
          state,
          `Undone: the comment by ${offer.comment.authorName} is ${offer.from} again.` +
            (stayed === null ? '' : ` ${stayed}`),
        ),
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
