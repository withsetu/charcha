// The queue on screen: the states, the paging, the undo window, and the failure that
// has to be visibly a failure.
//
// The reducer is asserted separately in queue.test.ts. This is about what a person
// sees, and specifically about the pairs the brief insists must not look alike:
// loading against empty, and a failed decision against a successful one.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Triage } from '../../src/dashboard/components/triage'
import {
  apiError,
  comment,
  decision,
  json,
  queuePage,
  stubFetch,
  unhandled,
  type FetchStub,
} from './harness'

function noop() {
  return
}

function mount() {
  render(<Triage onExpired={noop} onSignOut={noop} />)
}

function decisions(stub: FetchStub) {
  return stub.calls.filter((call) => call.method === 'POST')
}

describe('loading, empty and failed are three different screens', () => {
  it('shows skeleton rows and says it is loading, before any answer', () => {
    stubFetch(() => new Promise<Response>(() => {}))
    mount()
    expect(screen.getByText('Loading comments.')).toBeTruthy()
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    // Not the empty state, and not an error.
    expect(screen.queryByText('Nothing waiting on you')).toBeNull()
    expect(screen.queryByText('The queue could not be loaded')).toBeNull()
  })

  it('reads an empty pending queue as the success it is', async () => {
    stubFetch(() => json(200, queuePage([])))
    mount()
    await screen.findByText('Nothing waiting on you')
    expect(screen.getByText(/Every comment has been dealt with/)).toBeTruthy()
    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0)
  })

  it('uses different words for an empty spam queue and an empty approved queue', async () => {
    stubFetch(() => json(200, queuePage([])))
    mount()
    await screen.findByText('Nothing waiting on you')
    fireEvent.keyDown(document.body, { key: '2' })
    await screen.findByText('No spam held')
    fireEvent.keyDown(document.body, { key: '3' })
    await screen.findByText('Nothing published yet')
  })

  it('says the queue could not be loaded, and never that it is empty', async () => {
    stubFetch(() =>
      apiError(503, 'UNAVAILABLE', 'The dashboard is not available on this deployment.'),
    )
    mount()
    await screen.findByText('The queue could not be loaded')
    expect(screen.getByText('The dashboard is not available on this deployment.')).toBeTruthy()
    // The status and code are shown too: they are what makes a bug report actionable.
    expect(screen.getByText(/503 \(UNAVAILABLE\)/)).toBeTruthy()
    expect(screen.queryByText('Nothing waiting on you')).toBeNull()
  })

  it('retries the first page from the failure state', async () => {
    let attempts = 0
    const stub = stubFetch(() => {
      attempts += 1
      return attempts === 1
        ? apiError(500, 'UNAVAILABLE', 'Something went wrong. Try again.')
        : json(200, queuePage([comment({ id: 1 })]))
    })
    mount()
    await screen.findByText('The queue could not be loaded')
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await screen.findByText('Author 1')
    expect(stub.calls).toHaveLength(2)
  })

  it('reports a rejected fetch rather than showing a skeleton for ever', async () => {
    // CLAUDE.md's rule: a loading skeleton that never resolves is an unreported failure.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
    mount()
    await screen.findByText('The queue could not be loaded')
    expect(screen.getByText(/Check your connection/)).toBeTruthy()
  })
})

describe('a row', () => {
  it('shows the author, the page, the time and the body', async () => {
    stubFetch(() =>
      json(
        200,
        queuePage([
          comment({ id: 1, authorName: 'Ada', body: 'Great **post**', pageTitle: 'Hello world' }),
        ]),
      ),
    )
    mount()
    const row = await screen.findByRole('group')
    expect(within(row).getByText('Ada')).toBeTruthy()
    expect(within(row).getByText('Hello world')).toBeTruthy()
    expect(row.querySelector('time')?.getAttribute('datetime')).toBeTruthy()
    expect(row.querySelector('.charcha-body strong')?.textContent).toBe('post')
  })

  it('falls back to the page key when the thread has no title', async () => {
    stubFetch(() => json(200, queuePage([comment({ id: 1, pageTitle: null })])))
    mount()
    const row = await screen.findByRole('group')
    expect(within(row).getByText('/posts/hello')).toBeTruthy()
  })

  it('shows why a spam layer held it, which is what #70 is for', async () => {
    stubFetch(() => json(200, queuePage([comment({ id: 1, spamReason: 'content: 7 links' })])))
    mount()
    const row = await screen.findByRole('group')
    expect(within(row).getByText('content: 7 links')).toBeTruthy()
    // Labelled, not just present: the reason is a layer's internal token, and a bare
    // string of jargon beside a comment reads as part of the comment.
    expect(within(row).getByText('Held')).toBeTruthy()
    expect(within(row).getByText('Reason:')).toBeTruthy()
  })

  it('says nothing about a reason when no layer held it', async () => {
    stubFetch(() => json(200, queuePage([comment({ id: 1, spamReason: null })])))
    mount()
    await screen.findByRole('group')
    expect(screen.queryByText('Held')).toBeNull()
  })

  it('names its position, so a screen reader knows where in the queue it is', async () => {
    stubFetch(() => json(200, queuePage([comment({ id: 1 }), comment({ id: 2 })])))
    mount()
    await screen.findByText('Author 1')
    const rows = screen.getAllByRole('group')
    expect(rows[0]?.getAttribute('aria-label')).toContain('Comment 1 of 2')
    expect(rows[1]?.getAttribute('aria-label')).toContain('Comment 2 of 2')
  })

  it('keeps exactly one row in the tab order', async () => {
    // Roving tabindex. Without it, Tab walks through 200 rows and their buttons before
    // reaching anything else on the page.
    stubFetch(() => json(200, queuePage([comment({ id: 1 }), comment({ id: 2 })])))
    mount()
    await screen.findByText('Author 1')
    const tabbable = screen.getAllByRole('group').filter((row) => row.tabIndex === 0)
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]?.getAttribute('aria-current')).toBe('true')
  })

  it('decides from its buttons too, because the mouse is the fallback', async () => {
    const stub = stubFetch((call) =>
      call.method === 'POST'
        ? json(200, decision(1, 'approved'))
        : json(200, queuePage([comment({ id: 1 })])),
    )
    mount()
    await screen.findByText('Author 1')
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }))
    await waitFor(() => {
      expect(decisions(stub)).toHaveLength(1)
    })
    expect(decisions(stub)[0]?.body).toEqual({ status: 'approved' })
  })
})

describe('a decision that fails', () => {
  it('is unmistakable, names what was attempted, and puts the row back', async () => {
    const stub = stubFetch((call) =>
      call.method === 'POST'
        ? apiError(503, 'UNAVAILABLE', 'Something went wrong. Try again.')
        : json(200, queuePage([comment({ id: 1, authorName: 'Ada' }), comment({ id: 2 })])),
    )
    mount()
    await screen.findByText('Ada')
    fireEvent.keyDown(document.body, { key: 's' })

    await screen.findAllByText(/Could not mark spam on the comment by Ada/)
    expect(screen.getByText(/It is still in the queue, where you left it/)).toBeTruthy()
    // And it is, in fact, still there.
    expect(screen.getByText('Ada')).toBeTruthy()
    // No undo offer, because nothing happened to undo.
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull()
    expect(decisions(stub)).toHaveLength(1)
  })

  it('retries the same decision on the same comment', async () => {
    let attempts = 0
    const stub = stubFetch((call) => {
      if (call.method !== 'POST') return json(200, queuePage([comment({ id: 1 })]))
      attempts += 1
      return attempts === 1
        ? apiError(503, 'UNAVAILABLE', 'Something went wrong. Try again.')
        : json(200, decision(1, 'spam'))
    })
    mount()
    await screen.findByText('Author 1')
    fireEvent.keyDown(document.body, { key: 's' })
    // `findAllByText`: the sentence is deliberately in two places — the visible bar and
    // the assertive live region — so a screen reader hears what the screen shows.
    await screen.findAllByText(/Could not mark spam/)

    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await waitFor(() => {
      expect(decisions(stub)).toHaveLength(2)
    })
    expect(decisions(stub).map((call) => call.body)).toEqual([
      { status: 'spam' },
      { status: 'spam' },
    ])
    await screen.findByText('Nothing waiting on you')
  })

  it('is dismissable with Escape', async () => {
    stubFetch((call) =>
      call.method === 'POST'
        ? apiError(503, 'UNAVAILABLE', 'Something went wrong. Try again.')
        : json(200, queuePage([comment({ id: 1 })])),
    )
    mount()
    await screen.findByText('Author 1')
    fireEvent.keyDown(document.body, { key: 's' })
    await screen.findAllByText(/Could not mark spam/)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Try again/ })).toBeNull()
    })
  })

  it('announces the failure assertively and the success politely', async () => {
    let attempts = 0
    stubFetch((call) => {
      if (call.method !== 'POST') {
        return json(200, queuePage([comment({ id: 1 }), comment({ id: 2 })]))
      }
      attempts += 1
      return attempts === 1
        ? apiError(503, 'UNAVAILABLE', 'Something went wrong. Try again.')
        : json(200, decision(2, 'approved'))
    })
    mount()
    await screen.findByText('Author 1')

    fireEvent.keyDown(document.body, { key: 's' })
    await waitFor(() => {
      const assertive = document.querySelector('[aria-live="assertive"]')
      expect(assertive?.textContent).toContain('Could not mark spam')
    })

    fireEvent.keyDown(document.body, { key: 'a' })
    await waitFor(() => {
      const polite = document.querySelector('[aria-live="polite"]')
      expect(polite?.textContent).toContain('Approved')
    })
  })
})

describe('the undo window', () => {
  it('offers an undo after a decision, and takes the comment back on Z', async () => {
    const stub = stubFetch((call) =>
      call.method === 'POST'
        ? json(200, decision(1, 'spam'))
        : json(200, queuePage([comment({ id: 1, authorName: 'Ada' })])),
    )
    mount()
    await screen.findByText('Ada')
    fireEvent.keyDown(document.body, { key: 's' })

    await screen.findByRole('button', { name: /Undo/ })
    expect(screen.getByText('Marked spam')).toBeTruthy()
    // The queue advanced: this is the empty state, not the row.
    await screen.findByText('Nothing waiting on you')

    fireEvent.keyDown(document.body, { key: 'z' })
    await screen.findByText('Ada')
    expect(decisions(stub).map((call) => call.body)).toEqual([
      { status: 'spam' },
      { status: 'pending' },
    ])
  })

  it('closes on its own once the window has passed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stubFetch((call) =>
      call.method === 'POST'
        ? json(200, decision(1, 'spam'))
        : json(200, queuePage([comment({ id: 1 })])),
    )
    mount()
    await screen.findByText('Author 1')
    fireEvent.keyDown(document.body, { key: 's' })
    await screen.findByRole('button', { name: /Undo/ })

    await vi.advanceTimersByTimeAsync(13_000)
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull()
    })
  })

  it('reports a failed undo rather than showing the row back', async () => {
    let posts = 0
    stubFetch((call) => {
      if (call.method !== 'POST')
        return json(200, queuePage([comment({ id: 1, authorName: 'Ada' })]))
      posts += 1
      return posts === 1
        ? json(200, decision(1, 'spam'))
        : apiError(503, 'UNAVAILABLE', 'Something went wrong. Try again.')
    })
    mount()
    await screen.findByText('Ada')
    fireEvent.keyDown(document.body, { key: 's' })
    await screen.findByRole('button', { name: /Undo/ })
    fireEvent.keyDown(document.body, { key: 'z' })

    await screen.findAllByText(/Could not mark spam on the comment by Ada/)
    // Ada is not back on screen: the comment is still spam, and saying otherwise would
    // be the lie this test exists to prevent.
    expect(screen.queryByText('Ada')).toBeNull()
  })
})

describe('paging past the cap', () => {
  it('loads the next page from the button and keeps the current row', async () => {
    const FOUR = { pending: 4, spam: 0, approved: 0 }
    const stub = stubFetch((call) =>
      call.path.includes('cursor=')
        ? json(200, queuePage([comment({ id: 3 }), comment({ id: 4 })], null, FOUR))
        : json(200, queuePage([comment({ id: 1 }), comment({ id: 2 })], '1699999998.2', FOUR)),
    )
    mount()
    await screen.findByText('Author 1')
    // Honest about what it knows, and it now knows the total (#135): two of the four are
    // on screen, and the other two are a page away.
    expect(screen.getByText('Showing 2 of 4')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByText('Author 4')
    expect(screen.getByText('4 comments')).toBeTruthy()
    expect(stub.paths()[1]).toBe('/admin/api/queue?status=pending&cursor=1699999998.2')
    expect(screen.getAllByRole('group')[0]?.getAttribute('aria-current')).toBe('true')
  })

  it('fetches the next page from the keyboard, on reaching the last loaded row', async () => {
    const stub = stubFetch((call) =>
      call.path.includes('cursor=')
        ? json(200, queuePage([comment({ id: 3 })], null, { pending: 3, spam: 0, approved: 0 }))
        : json(
            200,
            queuePage([comment({ id: 1 }), comment({ id: 2 })], '1699999998.2', {
              pending: 3,
              spam: 0,
              approved: 0,
            }),
          ),
    )
    mount()
    await screen.findByText('Author 1')
    // Reaching the last loaded row is what pulls the page in, so one J is enough on a
    // two-row page. The row arriving is the assertion; the request count is the
    // corroboration, checked after it rather than raced against it.
    fireEvent.keyDown(document.body, { key: 'j' })
    await screen.findByText('Author 3')
    expect(stub.paths()).toHaveLength(2)
    fireEvent.keyDown(document.body, { key: 'j' })
    await waitFor(() => {
      expect(screen.getAllByRole('group')[2]?.getAttribute('aria-current')).toBe('true')
    })
  })

  it('offers no next page when the cursor is null, so there is no dead button', async () => {
    stubFetch(() => json(200, queuePage([comment({ id: 1 })])))
    mount()
    await screen.findByText('Author 1')
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    expect(screen.getByText('1 comment')).toBeTruthy()
  })

  it('keeps the loaded comments when the next page fails, and stops retrying', async () => {
    // Two comments, so the current row is not the last and nothing is prefetched: the
    // button is what asks, which is the path being tested.
    const stub = stubFetch((call) =>
      call.path.includes('cursor=')
        ? apiError(500, 'UNAVAILABLE', 'Something went wrong. Try again.')
        : json(200, queuePage([comment({ id: 1 }), comment({ id: 2 })], '1699999998.2')),
    )
    mount()
    await screen.findByText('Author 1')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByText('Could not load the next page')
    // The comments on screen are still real and still actionable.
    expect(screen.getByText('Author 1')).toBeTruthy()
    expect(screen.queryByText('The queue could not be loaded')).toBeNull()

    // And it asked once. A condition that stays true after a failure would have the
    // effect fire again immediately, for ever.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy()
    })
    expect(stub.paths().filter((path) => path.includes('cursor='))).toHaveLength(1)
  })
})

describe('switching view', () => {
  it('asks the server for the new status and shows it loading first', async () => {
    const stub = stubFetch(() => json(200, queuePage([])))
    mount()
    await screen.findByText('Nothing waiting on you')
    // `mouseDown`, because that is the event Radix's Tabs.Trigger acts on — a `click`
    // alone leaves the tab unchanged, which is a fact about the primitive rather than
    // about this component.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Spam/ }))
    await screen.findByText('No spam held')
    expect(stub.paths()).toEqual([
      '/admin/api/queue?status=pending',
      '/admin/api/queue?status=spam',
    ])
  })

  it('marks exactly one tab selected', async () => {
    stubFetch(() => json(200, queuePage([])))
    mount()
    await screen.findByText('Nothing waiting on you')
    const selected = screen
      .getAllByRole('tab')
      .filter((tab) => tab.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0]?.textContent).toContain('Pending')
  })
})

describe('the view tabs (#135)', () => {
  // The defect: the tabs read `Pending 1  Spam 2  Approved 3`, where the digits were
  // keyboard shortcuts and every convention in every inbox says a number beside a queue
  // name is how many things are in it.

  /**
   * Asserts the tabs' **computed** accessible names — what a screen reader would say —
   * rather than their `aria-label` attributes.
   *
   * The distinction is the whole point of the assertion and a review of an earlier draft
   * of this file caught it: reading the attribute passes for any tab that has one, and
   * an attribute-reading test cannot tell "Pending, 53 comments" from the ambiguous
   * "Pending 53" the trigger's own text content computes to. Testing Library's `name`
   * option runs the accessible-name algorithm, so `aria-hidden` on the keycap and the
   * exactness of the string are both really checked.
   */
  function expectTabNames(names: readonly string[]): void {
    for (const name of names) {
      expect(screen.getByRole('tab', { name })).toBeTruthy()
    }
    // No fourth tab quietly carrying one of the names instead.
    expect(screen.getAllByRole('tab')).toHaveLength(names.length)
  }

  it('says how many comments each view holds', async () => {
    stubFetch(() =>
      json(200, queuePage([comment({ id: 1 })], null, { pending: 53, spam: 12, approved: 104 })),
    )
    mount()
    await screen.findByText('Author 1')

    const tabs = screen.getAllByRole('tab')
    expect(within(tabs[0] as HTMLElement).getByText('53')).toBeTruthy()
    expect(within(tabs[1] as HTMLElement).getByText('12')).toBeTruthy()
    expect(within(tabs[2] as HTMLElement).getByText('104')).toBeTruthy()
  })

  it('reads the count out as a count, not as a bare number', async () => {
    // The accessible name is the whole of the fix for a screen-reader user: "Pending 53"
    // is exactly as ambiguous read aloud as it was on screen.
    stubFetch(() =>
      json(200, queuePage([comment({ id: 1 })], null, { pending: 53, spam: 12, approved: 1 })),
    )
    mount()
    await screen.findByText('Author 1')

    expectTabNames(['Pending, 53 comments', 'Spam, 12 comments', 'Approved, 1 comment'])
    // And the ambiguous reading is gone: "Pending 53" is what the trigger's text content
    // computes to on its own, and it is exactly as unclear read aloud as on screen.
    expect(screen.queryByRole('tab', { name: 'Pending 53' })).toBeNull()
  })

  it('names the view alone until the first answer arrives', () => {
    // Unknown is not zero. Before the server has said, a tab claiming `0` would be
    // asserting an empty queue on no evidence.
    stubFetch(() => new Promise<Response>(() => {}))
    mount()

    expectTabNames(['Pending', 'Spam', 'Approved'])
    expect(
      screen.getByRole('tab', { name: 'Pending' }).querySelector('[data-slot="tab-count"]'),
    ).toBeNull()
  })

  it('shows a zero, because an empty queue is a state worth stating', async () => {
    stubFetch(() => json(200, queuePage([], null, { pending: 0, spam: 3, approved: 0 })))
    mount()
    await screen.findByText('Nothing waiting on you')

    expectTabNames(['Pending, 0 comments', 'Spam, 3 comments', 'Approved, 0 comments'])
    expect(within(screen.getAllByRole('tab')[0] as HTMLElement).getByText('0')).toBeTruthy()
  })

  it('dresses the shortcut as a key, so it cannot be read as a count', async () => {
    // The cause of the bug was one `<kbd>` with two stylings. There is now one, from the
    // registry, and this asserts the tabs use it rather than a copy of the old text.
    stubFetch(() => json(200, queuePage([], null, { pending: 0, spam: 0, approved: 0 })))
    mount()
    await screen.findByText('Nothing waiting on you')

    const keys = screen.getAllByRole('tab').map((tab) => tab.querySelector('[data-slot="kbd"]'))
    expect(keys.map((key) => key?.textContent)).toEqual(['1', '2', '3'])
    for (const key of keys) {
      expect(key?.getAttribute('aria-hidden')).toBe('true')
      // The keycap treatment itself: a bordered, filled cap of a fixed size. The
      // ornament is the whole signal that this digit is a key and the other one is not.
      expect(key?.className).toContain('border')
      expect(key?.className).toContain('bg-muted')
    }
  })

  it('leaves no <kbd> in the app styled any other way, which is the point of the fix', async () => {
    // **The guard on the cause rather than on the symptom.** The bug was not the tabs
    // specifically; it was that `<kbd>` had two treatments and the wrong one was in the
    // slot a count belongs in. Every keycap on this surface now comes from
    // src/dashboard/ui/kbd.tsx, so any hand-rolled one anywhere — a tab, the header
    // button, the sheet, or something added later — fails here.
    stubFetch(() => json(200, queuePage([comment({ id: 1 })])))
    mount()
    await screen.findByText('Author 1')
    fireEvent.keyDown(document.body, { key: '?' })
    await screen.findByRole('dialog')

    const keys = [...document.querySelectorAll('kbd')]
    // The tabs' three, the header button's `?`, and one per row of the sheet.
    expect(keys.length).toBeGreaterThan(4)
    for (const key of keys) {
      expect(key.getAttribute('data-slot')).toBe('kbd')
    }
  })

  it('follows a decision, including the replies it cascaded over', async () => {
    // A badge that does not move after an approval is the same class of lie as a
    // shortcut hint that reads as a count. The server recounts, so this is four moving
    // at once — one comment and the three replies under it.
    stubFetch((call) =>
      call.method === 'POST'
        ? json(200, decision(1, 'spam', { pending: 49, spam: 4, approved: 0 }))
        : json(
            200,
            queuePage([comment({ id: 1 }), comment({ id: 2 })], null, {
              pending: 53,
              spam: 0,
              approved: 0,
            }),
          ),
    )
    mount()
    await screen.findByText('Author 1')
    expect(screen.getByRole('tab', { name: 'Pending, 53 comments' })).toBeTruthy()

    fireEvent.keyDown(document.body, { key: 's' })

    await waitFor(() => {
      expectTabNames(['Pending, 49 comments', 'Spam, 4 comments', 'Approved, 0 comments'])
    })
  })

  it('keeps the counts on screen through a view change', async () => {
    // Every tab is labelled with a number the whole time, so switching view does not
    // blank all three and refill them with what was true throughout.
    // One set of counts for both views, because that is what they are: the counts
    // describe the whole database and do not depend on which queue was asked for.
    stubFetch(() => json(200, queuePage([], null, { pending: 53, spam: 12, approved: 4 })))
    mount()
    await screen.findByText('Nothing waiting on you')

    fireEvent.mouseDown(screen.getByRole('tab', { name: /Spam/ }))
    // Asserted while the new queue is still loading: this is the moment the counts would
    // have been dropped.
    expectTabNames(['Pending, 53 comments', 'Spam, 12 comments', 'Approved, 4 comments'])
    await screen.findByText('No spam held')
  })
})

describe('the summary line (#135)', () => {
  it('says how much of the queue is on screen when there is more', async () => {
    stubFetch(() =>
      json(
        200,
        queuePage([comment({ id: 1 }), comment({ id: 2 })], '1699999998.2', {
          pending: 53,
          spam: 0,
          approved: 0,
        }),
      ),
    )
    mount()
    await screen.findByText('Author 1')

    // The old phrasing — "2 loaded, and there are more" — was honest and unreadable.
    // This is the same honesty with the total the tabs now know.
    expect(screen.getByText('Showing 2 of 53')).toBeTruthy()
  })

  it('states the total plainly once everything is loaded', async () => {
    stubFetch(() =>
      json(
        200,
        queuePage([comment({ id: 1 }), comment({ id: 2 })], null, {
          pending: 2,
          spam: 0,
          approved: 0,
        }),
      ),
    )
    mount()
    await screen.findByText('Author 1')

    expect(screen.getByText('2 comments')).toBeTruthy()
  })

  it('counts a single comment in the singular', async () => {
    stubFetch(() => json(200, queuePage([comment({ id: 1 })])))
    mount()
    await screen.findByText('Author 1')

    expect(screen.getByText('1 comment')).toBeTruthy()
  })
})

describe('the mouse and the keyboard are the same model', () => {
  it('follows a click onto another row', async () => {
    stubFetch(() => json(200, queuePage([comment({ id: 1 }), comment({ id: 2 })])))
    mount()
    await screen.findByText('Author 1')
    const rows = screen.getAllByRole('group')
    fireEvent.focus(rows[1] as Element)
    await waitFor(() => {
      expect(rows[1]?.getAttribute('aria-current')).toBe('true')
    })
    // And the next keystroke acts on what was clicked.
    expect(rows[0]?.getAttribute('aria-current')).toBeNull()
  })

  it('opens the shortcut sheet from the header button', async () => {
    stubFetch(() => json(200, queuePage([])))
    mount()
    await screen.findByText('Nothing waiting on you')
    fireEvent.click(screen.getByRole('button', { name: /Shortcuts/ }))
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getByText('Keyboard shortcuts')).toBeTruthy()
  })
})

describe('unhandled paths', () => {
  it('never asks for anything but the session, the queue and a status', async () => {
    // The stub throws on an unexpected path, so this is really an assertion that every
    // test above ran without one — stated once, so the reason the stub is strict is
    // written down.
    const stub = stubFetch((call) =>
      call.path.startsWith('/admin/api/queue') ? json(200, queuePage([])) : unhandled(call),
    )
    mount()
    await screen.findByText('Nothing waiting on you')
    expect(stub.paths()).toEqual(['/admin/api/queue?status=pending'])
  })
})
