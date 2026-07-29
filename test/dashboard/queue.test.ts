// The queue reducer: every state the brief requires, asserted without a browser.

import { describe, expect, it } from 'vitest'

import type { ApiFailure, QueueCounts, QueuedComment } from '../../src/dashboard/api'
import type { QueueState } from '../../src/dashboard/queue'
import {
  currentComment,
  initialState,
  isDeciding,
  reduce,
  shouldLoadMore,
} from '../../src/dashboard/queue'

function comment(id: number, overrides: Partial<QueuedComment> = {}): QueuedComment {
  return {
    id,
    threadId: 1,
    parentId: null,
    depth: 0,
    authorName: `Author ${String(id)}`,
    body: 'hello',
    byOwner: false,
    status: 'pending',
    createdAt: 1_700_000_000 - id,
    moderatedAt: null,
    pageKey: '/posts/hello',
    pageTitle: 'Hello',
    spamReason: null,
    ...overrides,
  }
}

const FAILURE: ApiFailure = { code: 'UNAVAILABLE', message: 'Something went wrong.', status: 500 }

function counts(pending: number, spam = 0, approved = 0): QueueCounts {
  return { pending, spam, approved }
}

/** The counts every case that is not about counts uses, so the numbers stand out. */
const SOME_COUNTS = counts(9, 8, 7)

function loaded(ids: number[], nextCursor: string | null = null): QueueState {
  return reduce(initialState('pending'), {
    type: 'load/ok',
    page: { comments: ids.map((id) => comment(id)), nextCursor, counts: SOME_COUNTS },
  })
}

describe('the three first-page states', () => {
  it('starts loading, with no failure and nothing to show', () => {
    const state = initialState()
    expect(state.phase).toBe('loading')
    expect(state.comments).toEqual([])
    expect(state.loadFailure).toBeNull()
  })

  it('an empty answer is ready-and-empty, which is not loading', () => {
    const state = reduce(initialState(), {
      type: 'load/ok',
      page: { comments: [], nextCursor: null, counts: SOME_COUNTS },
    })
    expect(state.phase).toBe('ready')
    expect(state.comments).toEqual([])
    expect(state.loadFailure).toBeNull()
  })

  it('a failure is neither, and never an empty ready queue', () => {
    // This is the assertion that stops "no pending comments" being shown to somebody
    // whose request failed. `comments.length === 0` is true in both states; `phase` is
    // the only thing that tells them apart.
    const state = reduce(initialState(), { type: 'load/failed', failure: FAILURE })
    expect(state.phase).toBe('failed')
    expect(state.loadFailure).toEqual(FAILURE)
    expect(state.comments).toEqual([])
  })

  it('retrying clears the previous failure before the answer arrives', () => {
    const failed = reduce(initialState(), { type: 'load/failed', failure: FAILURE })
    const retrying = reduce(failed, { type: 'load/start' })
    expect(retrying.phase).toBe('loading')
    expect(retrying.loadFailure).toBeNull()
  })
})

describe('the current comment', () => {
  it('lands on the first comment of a fresh page', () => {
    expect(loaded([1, 2, 3]).currentId).toBe(1)
  })

  it('is null when there is nothing to be on', () => {
    expect(loaded([]).currentId).toBeNull()
  })

  it('moves with J and K and stops at both ends', () => {
    let state = loaded([1, 2, 3])
    state = reduce(state, { type: 'move', delta: -1 })
    expect(state.currentId).toBe(1)
    state = reduce(state, { type: 'move', delta: 1 })
    expect(state.currentId).toBe(2)
    state = reduce(state, { type: 'move', delta: 1 })
    state = reduce(state, { type: 'move', delta: 1 })
    expect(state.currentId).toBe(3)
  })

  it('follows a click, because the mouse is the fallback and not a second model', () => {
    expect(reduce(loaded([1, 2, 3]), { type: 'focus', id: 3 }).currentId).toBe(3)
  })

  it('ignores a focus on a comment that is not in the list', () => {
    expect(reduce(loaded([1, 2]), { type: 'focus', id: 99 }).currentId).toBe(1)
  })
})

describe('auto-advance', () => {
  it('moves to the next comment the moment a decision starts', () => {
    // One keystroke per comment is the whole design, and this is where it happens: the
    // row below slides into the vacated index and becomes current before the request
    // has been answered.
    const state = reduce(loaded([1, 2, 3]), { type: 'decide/start', id: 1, status: 'approved' })
    expect(state.comments.map((c) => c.id)).toEqual([2, 3])
    expect(state.currentId).toBe(2)
  })

  it('falls back to the row above on the last comment', () => {
    let state = loaded([1, 2])
    state = reduce(state, { type: 'focus', id: 2 })
    state = reduce(state, { type: 'decide/start', id: 2, status: 'spam' })
    expect(state.currentId).toBe(1)
  })

  it('has nothing to be on once the queue is cleared', () => {
    const state = reduce(loaded([1]), { type: 'decide/start', id: 1, status: 'approved' })
    expect(state.comments).toEqual([])
    expect(state.currentId).toBeNull()
  })

  it('does not move current when a decision is taken on some other row', () => {
    const state = reduce(loaded([1, 2, 3]), { type: 'decide/start', id: 3, status: 'spam' })
    expect(state.currentId).toBe(1)
  })

  it('refuses a second decision on a comment already in flight', () => {
    const first = reduce(loaded([1, 2]), { type: 'decide/start', id: 1, status: 'approved' })
    expect(isDeciding(first, 1)).toBe(true)
    const second = reduce(first, { type: 'decide/start', id: 1, status: 'spam' })
    expect(second).toBe(first)
  })
})

describe('a decision that does not apply', () => {
  it('puts the row back where it was, and says so', () => {
    // The worst outcome this surface has is an optimistic removal that is not undone:
    // the comment is still pending and the queue says otherwise, so the moderator
    // believes they are finished.
    let state = loaded([1, 2, 3])
    state = reduce(state, { type: 'decide/start', id: 2, status: 'spam' })
    expect(state.comments.map((c) => c.id)).toEqual([1, 3])

    state = reduce(state, { type: 'decide/failed', id: 2, failure: FAILURE })
    expect(state.comments.map((c) => c.id)).toEqual([1, 2, 3])
    expect(state.actionFailure?.comment.id).toBe(2)
    expect(state.actionFailure?.status).toBe('spam')
    expect(state.actionFailure?.failure).toEqual(FAILURE)
  })

  it('puts the keyboard back on the restored comment, so a retry hits the right one', () => {
    // Found by driving it: the auto-advance had already moved on, so the owner read
    // "Could not approve the comment by Author 2", pressed A to retry, and approved
    // Author 3. The message on screen and the comment the next keystroke acts on have
    // to be the same one.
    let state = loaded([1, 2, 3])
    state = reduce(state, { type: 'focus', id: 2 })
    state = reduce(state, { type: 'decide/start', id: 2, status: 'approved' })
    expect(state.currentId).toBe(3)
    state = reduce(state, { type: 'decide/failed', id: 2, failure: FAILURE })
    expect(state.currentId).toBe(2)
  })

  it('offers no undo, because nothing happened to undo', () => {
    let state = reduce(loaded([1]), { type: 'decide/start', id: 1, status: 'spam' })
    state = reduce(state, { type: 'decide/failed', id: 1, failure: FAILURE })
    expect(state.undo).toBeNull()
  })

  it('announces the failure assertively, naming the attempt and the reason', () => {
    let state = reduce(loaded([1]), { type: 'decide/start', id: 1, status: 'spam' })
    state = reduce(state, { type: 'decide/failed', id: 1, failure: FAILURE })
    expect(state.announcement?.urgency).toBe('assertive')
    expect(state.announcement?.text).toContain('mark spam')
    expect(state.announcement?.text).toContain('Author 1')
    expect(state.announcement?.text).toContain(FAILURE.message)
  })

  it('announces a success politely, so it does not interrupt', () => {
    let state = reduce(loaded([1]), { type: 'decide/start', id: 1, status: 'approved' })
    state = reduce(state, { type: 'decide/ok', id: 1, at: 1_000, counts: SOME_COUNTS })
    expect(state.announcement?.urgency).toBe('polite')
    expect(state.announcement?.text).toContain('Approved')
    expect(state.announcement?.text).toContain('Z to undo')
  })

  it('gives two identical sentences two sequence numbers, or the second is never read', () => {
    let state = loaded([1, 2])
    state = reduce(state, { type: 'decide/start', id: 1, status: 'approved' })
    state = reduce(state, { type: 'decide/ok', id: 1, at: 1_000, counts: SOME_COUNTS })
    const first = state.announcement
    state = reduce(state, { type: 'decide/start', id: 2, status: 'approved' })
    state = reduce(state, { type: 'decide/ok', id: 2, at: 2_000, counts: SOME_COUNTS })
    expect(state.announcement?.seq).toBeGreaterThan(first?.seq ?? 0)
  })
})

describe('undo', () => {
  it('is offered after a decision lands, with the clock the caller passed', () => {
    let state = reduce(loaded([1, 2]), { type: 'decide/start', id: 1, status: 'spam' })
    state = reduce(state, { type: 'decide/ok', id: 1, at: 12_345, counts: SOME_COUNTS })
    expect(state.undo).toMatchObject({ from: 'pending', to: 'spam', offeredAt: 12_345 })
    expect(state.undo?.comment.id).toBe(1)
  })

  it('restores the row at the index it left, not at the top', () => {
    let state = reduce(loaded([1, 2, 3]), { type: 'decide/start', id: 2, status: 'spam' })
    state = reduce(state, { type: 'decide/ok', id: 2, at: 1, counts: SOME_COUNTS })
    state = reduce(state, { type: 'undo/start' })
    state = reduce(state, { type: 'undo/ok', counts: SOME_COUNTS })
    expect(state.comments.map((c) => c.id)).toEqual([1, 2, 3])
    expect(state.currentId).toBe(2)
    expect(state.undo).toBeNull()
  })

  it('takes the comment back to the status it came from', () => {
    // The comment's own status decides, not the view: undoing in the spam queue puts a
    // comment back to spam, and this is the field the request is built from.
    let state = reduce(initialState('spam'), {
      type: 'load/ok',
      page: { comments: [comment(7, { status: 'spam' })], nextCursor: null, counts: SOME_COUNTS },
    })
    state = reduce(state, { type: 'decide/start', id: 7, status: 'approved' })
    state = reduce(state, { type: 'decide/ok', id: 7, at: 1, counts: SOME_COUNTS })
    expect(state.undo?.from).toBe('spam')
  })

  it('restores into the view the comment belongs to, and only that one', () => {
    // In ordinary use the two always agree: the queue is filtered by status, so a row
    // in the approved view has status `approved` and an undo takes it back to
    // `approved`. This asserts the guard for the case where they *disagree* — a server
    // that answered `?status=approved` with a pending row, or a later feature that
    // shows more than one status at once. Restoring blindly would put a pending
    // comment in the approved list, where the owner would read it as published.
    let state = reduce(initialState('approved'), {
      type: 'load/ok',
      page: {
        comments: [comment(7, { status: 'pending' })],
        nextCursor: null,
        counts: SOME_COUNTS,
      },
    })
    state = reduce(state, { type: 'decide/start', id: 7, status: 'spam' })
    state = reduce(state, { type: 'decide/ok', id: 7, at: 1, counts: SOME_COUNTS })
    expect(state.undo?.from).toBe('pending')

    state = reduce(state, { type: 'undo/start' })
    state = reduce(state, { type: 'undo/ok', counts: SOME_COUNTS })
    expect(state.comments).toEqual([])
    // The announcement is then the whole of the feedback, which is why it names the
    // status the comment went back to rather than only saying "undone".
    expect(state.announcement?.text).toContain('pending again')
  })

  it('reports a failed undo rather than pretending the row is back', () => {
    let state = reduce(loaded([1, 2]), { type: 'decide/start', id: 1, status: 'spam' })
    state = reduce(state, { type: 'decide/ok', id: 1, at: 1, counts: SOME_COUNTS })
    state = reduce(state, { type: 'undo/start' })
    state = reduce(state, { type: 'undo/failed', failure: FAILURE })
    expect(state.comments.map((c) => c.id)).toEqual([2])
    expect(state.actionFailure?.failure).toEqual(FAILURE)
    expect(state.undo).toBeNull()
  })

  it('expires, and an expiry mid-request does not cancel the request', () => {
    let state = reduce(loaded([1]), { type: 'decide/start', id: 1, status: 'spam' })
    state = reduce(state, { type: 'decide/ok', id: 1, at: 1, counts: SOME_COUNTS })
    const running = reduce(state, { type: 'undo/start' })
    expect(reduce(running, { type: 'undo/expire' })).toBe(running)
    expect(reduce(state, { type: 'undo/expire' }).undo).toBeNull()
  })

  it('holds one offer only: a new decision replaces the last one', () => {
    // `Z` means "take back what I just did". Two offers would make it ambiguous which.
    let state = loaded([1, 2])
    state = reduce(state, { type: 'decide/start', id: 1, status: 'spam' })
    state = reduce(state, { type: 'decide/ok', id: 1, at: 1, counts: SOME_COUNTS })
    state = reduce(state, { type: 'decide/start', id: 2, status: 'approved' })
    expect(state.undo).toBeNull()
  })
})

describe('paging past the cap', () => {
  it('appends without moving the current comment', () => {
    let state = loaded([1, 2], '1699999998.2')
    state = reduce(state, { type: 'focus', id: 2 })
    state = reduce(state, { type: 'more/start' })
    state = reduce(state, {
      type: 'more/ok',
      page: { comments: [comment(3), comment(4)], nextCursor: null, counts: SOME_COUNTS },
    })
    expect(state.comments.map((c) => c.id)).toEqual([1, 2, 3, 4])
    expect(state.currentId).toBe(2)
    expect(state.nextCursor).toBeNull()
    expect(state.more).toBe('idle')
  })

  it('asks for the next page when the current comment is the last loaded', () => {
    const state = reduce(loaded([1, 2], '1699999998.2'), { type: 'focus', id: 2 })
    expect(shouldLoadMore(state)).toBe(true)
  })

  it('does not ask when there is no next page, or one is already coming', () => {
    expect(shouldLoadMore(reduce(loaded([1, 2]), { type: 'focus', id: 2 }))).toBe(false)
    const loading = reduce(reduce(loaded([1], '1.1'), { type: 'focus', id: 1 }), {
      type: 'more/start',
    })
    expect(shouldLoadMore(loading)).toBe(false)
  })

  it('stops asking automatically once a page has failed', () => {
    // Otherwise the caller's effect fires on the same condition for ever: the cursor is
    // unchanged and the current row is still the last, so a failing endpoint would be
    // hammered in a loop with an alert flickering in front of the owner.
    let state = reduce(loaded([1], '1.1'), { type: 'focus', id: 1 })
    expect(shouldLoadMore(state)).toBe(true)
    state = reduce(reduce(state, { type: 'more/start' }), {
      type: 'more/failed',
      failure: FAILURE,
    })
    expect(shouldLoadMore(state)).toBe(false)
    // Pressing the button clears it, so the owner is never stuck.
    expect(shouldLoadMore(reduce(state, { type: 'more/start' }))).toBe(false)
    expect(reduce(state, { type: 'more/start' }).moreFailure).toBeNull()
  })

  it('keeps the loaded comments when the next page fails', () => {
    // Turning this into the whole-page error state would throw away comments the owner
    // can act on, in order to report that there might be more.
    let state = loaded([1, 2], '1.2')
    state = reduce(state, { type: 'more/start' })
    state = reduce(state, { type: 'more/failed', failure: FAILURE })
    expect(state.phase).toBe('ready')
    expect(state.comments).toHaveLength(2)
    expect(state.moreFailure).toEqual(FAILURE)
  })
})

describe('switching view', () => {
  it('starts a new queue and drops everything about the old one', () => {
    let state = reduce(loaded([1, 2], '1.2'), { type: 'decide/start', id: 1, status: 'spam' })
    state = reduce(state, { type: 'decide/ok', id: 1, at: 1, counts: SOME_COUNTS })
    state = reduce(state, { type: 'tab', tab: 'spam' })
    expect(state.view).toBe('spam')
    expect(state.phase).toBe('loading')
    expect(state.comments).toEqual([])
    expect(state.currentId).toBeNull()
    expect(state.nextCursor).toBeNull()
    // The offer named a row that is no longer on screen.
    expect(state.undo).toBeNull()
  })

  it('keeps the shortcut sheet open, because it is about the surface not the queue', () => {
    const state = reduce(reduce(initialState(), { type: 'help', open: true }), {
      type: 'tab',
      tab: 'spam',
    })
    expect(state.helpOpen).toBe(true)
  })
})

describe('the setup tab (#158)', () => {
  it('starts on the queue, so `tab` and `view` agree until somebody moves', () => {
    expect(initialState().tab).toBe('pending')
    expect(initialState('spam').tab).toBe('spam')
  })

  it('leaves the loaded queue exactly where it was', () => {
    // Setup is not a queue. Clearing the list here would make every trip to this tab
    // cost a refetch and lose the owner's place in a 50-row page.
    const state = reduce(loaded([1, 2]), { type: 'tab', tab: 'setup' })
    expect(state.tab).toBe('setup')
    expect(state.view).toBe('pending')
    expect(state.phase).toBe('ready')
    expect(state.comments).toHaveLength(2)
    expect(state.currentId).toBe(1)
  })

  it('takes the message bar with it, because the row it names is not on screen', () => {
    let state = reduce(loaded([1, 2]), { type: 'decide/start', id: 1, status: 'spam' })
    state = reduce(state, { type: 'decide/ok', id: 1, at: 1, counts: SOME_COUNTS })
    expect(state.undo).not.toBeNull()

    state = reduce(state, { type: 'tab', tab: 'setup' })
    expect(state.undo).toBeNull()
    expect(state.actionFailure).toBeNull()
  })

  it('leaves a failed next page recorded, so the auto-fetch stays disarmed', () => {
    // `moreFailure` is the latch `shouldLoadMore` reads. Clearing it on the way to Setup
    // would re-arm the effect and fire the failed request again, at a panel nobody is
    // looking at — the loop the comment on `shouldLoadMore` calls load-bearing.
    let state = reduce(loaded([1, 2], '1.2'), { type: 'more/start' })
    state = reduce(state, { type: 'more/failed', failure: FAILURE })
    expect(shouldLoadMore(state)).toBe(false)

    state = reduce(state, { type: 'tab', tab: 'setup' })
    expect(state.moreFailure).toEqual(FAILURE)
    expect(shouldLoadMore(state)).toBe(false)
  })

  it('does not promise Z for a decision that lands while Setup is showing', () => {
    // The offer survives, so the bar and the key both return with the queue — but the
    // announcement must not name a keystroke the Setup tab refuses.
    let state = reduce(loaded([1, 2]), { type: 'decide/start', id: 1, status: 'spam' })
    state = reduce(state, { type: 'tab', tab: 'setup' })
    state = reduce(state, { type: 'decide/ok', id: 1, at: 1, counts: SOME_COUNTS })

    expect(state.announcement?.text).toBe('Marked spam: Author 1.')
    expect(state.undo).not.toBeNull()
  })

  it('comes back to the same queue without asking for it again', () => {
    // **The load-bearing one.** Resetting here would set `phase` back to `loading` while
    // leaving `view` untouched — and the effect that fetches is keyed on `view`, so
    // nothing would ever ask for the page and the skeleton would stand for ever.
    const state = reduce(reduce(loaded([1, 2]), { type: 'tab', tab: 'setup' }), {
      type: 'tab',
      tab: 'pending',
    })
    expect(state.tab).toBe('pending')
    expect(state.phase).toBe('ready')
    expect(state.comments).toHaveLength(2)
  })

  it('starts a new queue when the tab chosen from setup is a different one', () => {
    const state = reduce(reduce(loaded([1, 2]), { type: 'tab', tab: 'setup' }), {
      type: 'tab',
      tab: 'spam',
    })
    expect(state.tab).toBe('spam')
    expect(state.view).toBe('spam')
    expect(state.phase).toBe('loading')
    expect(state.comments).toEqual([])
  })

  it('does nothing at all when the tab chosen is the one already showing', () => {
    const state = loaded([1, 2])
    expect(reduce(state, { type: 'tab', tab: 'pending' })).toBe(state)
  })
})

describe('the per-status counts (#135)', () => {
  it('is unknown rather than zero before the first answer', () => {
    // The distinction the tabs depend on: `null` is "nobody has said yet" and renders no
    // badge, `0` is "this queue is empty" and renders one. Collapsing them would make an
    // unanswered request look like a cleared queue, which is the same lie as the loading
    // state looking like the empty one.
    expect(initialState().counts).toBeNull()
  })

  it('takes them from the page the server sent', () => {
    const state = reduce(initialState(), {
      type: 'load/ok',
      page: { comments: [comment(1)], nextCursor: null, counts: counts(53, 12, 104) },
    })
    expect(state.counts).toEqual({ pending: 53, spam: 12, approved: 104 })
  })

  it('survives a view change, because they describe the database and not this queue', () => {
    // Everything else about the old queue goes. If the counts went with it, switching
    // tabs would blank all three badges and then repopulate them — and the numbers were
    // still true the whole time.
    const state = reduce(loaded([1, 2]), { type: 'tab', tab: 'spam' })
    expect(state.comments).toEqual([])
    expect(state.counts).toEqual(SOME_COUNTS)
  })

  it('follows a decision, from the server rather than by arithmetic', () => {
    // Not `pending - 1`. The decision cascades to the replies under the comment, so the
    // change is not always one — see src/admin/route.ts and
    // test/worker/admin/queue.test.ts. The reducer takes the recount and does no sums.
    let state = reduce(loaded([1, 2]), { type: 'decide/start', id: 1, status: 'approved' })
    state = reduce(state, { type: 'decide/ok', id: 1, at: 1, counts: counts(4, 8, 12) })
    expect(state.counts).toEqual({ pending: 4, spam: 8, approved: 12 })
  })

  it('follows an undo the same way', () => {
    let state = reduce(loaded([1, 2]), { type: 'decide/start', id: 1, status: 'approved' })
    state = reduce(state, { type: 'decide/ok', id: 1, at: 1, counts: counts(4, 8, 12) })
    state = reduce(state, { type: 'undo/start' })
    state = reduce(state, { type: 'undo/ok', counts: counts(5, 8, 11) })
    expect(state.counts).toEqual({ pending: 5, spam: 8, approved: 11 })
  })

  it('keeps the last known numbers when a reload fails', () => {
    // They were true a moment ago and the tabs are still usable. Blanking them would
    // take the badges away at the same moment the queue itself is replaced by an error,
    // which reads as the whole surface having lost its data rather than one request.
    const state = reduce(loaded([1, 2]), { type: 'load/failed', failure: FAILURE })
    expect(state.phase).toBe('failed')
    expect(state.counts).toEqual(SOME_COUNTS)
  })

  it('is left alone by a decision that did not apply', () => {
    // Nothing moved, so nothing about the counts changed. Clearing them here would blank
    // the badges at the exact moment the owner is being told the queue is unchanged.
    let state = reduce(loaded([1]), { type: 'decide/start', id: 1, status: 'spam' })
    state = reduce(state, { type: 'decide/failed', id: 1, failure: FAILURE })
    expect(state.counts).toEqual(SOME_COUNTS)
  })

  it('refreshes on the next page, and never adds it to the total', () => {
    let state = loaded([1, 2], '1699999998.2')
    state = reduce(state, { type: 'more/start' })
    state = reduce(state, {
      type: 'more/ok',
      page: { comments: [comment(3)], nextCursor: null, counts: counts(3, 8, 7) },
    })
    expect(state.counts).toEqual({ pending: 3, spam: 8, approved: 7 })
  })
})

describe('dismiss', () => {
  it('clears both failures and the undo offer', () => {
    let state = reduce(loaded([1]), { type: 'decide/start', id: 1, status: 'spam' })
    state = reduce(state, { type: 'decide/failed', id: 1, failure: FAILURE })
    state = reduce(state, { type: 'dismiss' })
    expect(state.actionFailure).toBeNull()
    expect(state.moreFailure).toBeNull()
    expect(state.undo).toBeNull()
  })
})

describe('currentComment', () => {
  it('is the comment the id names, or null', () => {
    expect(currentComment(loaded([4, 5]))?.id).toBe(4)
    expect(currentComment(loaded([]))).toBeNull()
  })
})
