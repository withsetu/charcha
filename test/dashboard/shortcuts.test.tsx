// The keyboard, driven through the real listener.
//
// keys.test.ts covers the map as a function. This covers the thing that has to be
// right for the map to matter: that the listener src/dashboard/components/triage.tsx
// attaches to `document` consults it, and refuses a keystroke aimed at an editable
// target.
//
// **Why the guard is tested against an input placed beside the app rather than one
// inside it.** The listener is on `document`, so it fires for a keystroke anywhere on
// the page — that is what makes single-key shortcuts work without the list having to
// hold focus, and it is also what makes every text field on the page a hazard. v1 of
// this dashboard has no field inside the queue (inline reply needs an endpoint that
// #12 did not ship — see the issue filed for it), so the field here is added to the
// document directly. That is not a weaker test of the listener: the event is real, the
// target is real, and removing the guard fails it. It is the arrangement the reply
// textarea will arrive into.
//
// Kill-shot: delete the `isEditableTarget` line from `resolveCommand` in
// src/dashboard/keys.ts and the two guard tests below fail. Recorded on the PR for #13.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Triage } from '../../src/dashboard/components/triage'
import { comment, json, queuePage, stubFetch, unhandled, type FetchStub } from './harness'

function noop() {
  return
}

async function mountQueue(): Promise<FetchStub> {
  const stub = stubFetch((call) => {
    if (call.path.startsWith('/admin/api/queue')) {
      return json(200, queuePage([comment({ id: 1 }), comment({ id: 2 }), comment({ id: 3 })]))
    }
    if (/^\/admin\/api\/comments\/\d+\/status$/.test(call.path)) {
      return json(200, { id: 1, status: 'spam', moderatedAt: 1 })
    }
    return unhandled(call)
  })
  render(<Triage onExpired={noop} onSignOut={noop} />)
  await screen.findByText('Author 1')
  return stub
}

function decisions(stub: FetchStub) {
  return stub.calls.filter((call) => call.method === 'POST')
}

/** A text field on the page, beside the app — see this file's header. */
function addTextField(type: 'text' | 'password' | 'textarea'): HTMLElement {
  const field =
    type === 'textarea' ? document.createElement('textarea') : document.createElement('input')
  if (field instanceof HTMLInputElement) field.type = type
  document.body.append(field)
  field.focus()
  return field
}

describe('the shortcut listener', () => {
  it('marks the current comment spam on S', async () => {
    const stub = await mountQueue()
    fireEvent.keyDown(document.body, { key: 's' })
    await waitFor(() => {
      expect(decisions(stub)).toHaveLength(1)
    })
    expect(decisions(stub)[0]).toMatchObject({
      path: '/admin/api/comments/1/status',
      body: { status: 'spam' },
    })
  })

  it('approves on A and deletes on D, and each one advances the queue', async () => {
    const stub = await mountQueue()
    fireEvent.keyDown(document.body, { key: 'a' })
    await waitFor(() => {
      expect(screen.queryByText('Author 1')).toBeNull()
    })
    fireEvent.keyDown(document.body, { key: 'd' })
    await waitFor(() => {
      expect(decisions(stub)).toHaveLength(2)
    })
    expect(decisions(stub).map((call) => call.body)).toEqual([
      { status: 'approved' },
      { status: 'deleted' },
    ])
    // Auto-advance: the second keystroke acted on the comment that slid into place,
    // with no navigation in between.
    expect(decisions(stub).map((call) => call.path)).toEqual([
      '/admin/api/comments/1/status',
      '/admin/api/comments/2/status',
    ])
  })

  it('moves the current row, and focus with it, on J and K', async () => {
    await mountQueue()
    const rows = () => screen.getAllByRole('group')
    expect(rows()[0]?.getAttribute('aria-current')).toBe('true')

    fireEvent.keyDown(document.body, { key: 'j' })
    await waitFor(() => {
      expect(rows()[1]?.getAttribute('aria-current')).toBe('true')
    })
    // Focus follows, which is what makes a screen reader announce the new row without
    // any live region at all.
    expect(document.activeElement).toBe(rows()[1])

    fireEvent.keyDown(document.body, { key: 'ArrowUp' })
    await waitFor(() => {
      expect(rows()[0]?.getAttribute('aria-current')).toBe('true')
    })
  })

  // The guard. Both of these fail with `isEditableTarget` removed from resolveCommand.
  it('does not mark a comment spam when S is typed into a text field', async () => {
    const stub = await mountQueue()
    const field = addTextField('text')
    fireEvent.keyDown(field, { key: 's' })
    fireEvent.keyDown(field, { key: 'a' })
    fireEvent.keyDown(field, { key: 'd' })
    fireEvent.keyDown(field, { key: 'j' })
    fireEvent.keyDown(field, { key: 'z' })
    // Nothing was decided, and the queue did not move.
    expect(decisions(stub)).toHaveLength(0)
    expect(screen.getAllByRole('group')[0]?.getAttribute('aria-current')).toBe('true')
  })

  it('does not open the shortcut sheet when ? is typed into a textarea', async () => {
    // The reply textarea's case, which is the one the brief names by name.
    await mountQueue()
    const field = addTextField('textarea')
    fireEvent.keyDown(field, { key: '?', shiftKey: true })
    fireEvent.keyDown(field, { key: 's' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('leaves Cmd+A to the browser, so selecting the page does not approve a comment', async () => {
    const stub = await mountQueue()
    fireEvent.keyDown(document.body, { key: 'a', metaKey: true })
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true })
    expect(decisions(stub)).toHaveLength(0)
  })

  it('opens and closes the shortcut sheet on ?', async () => {
    await mountQueue()
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true })
    const sheet = await screen.findByRole('dialog')
    expect(sheet.textContent).toContain('Approve')
    // Every advertised binding is in the sheet, generated from the map.
    expect(sheet.textContent).toContain('Undo the last decision')
  })

  it('acts on nothing but the sheet while the sheet is open', async () => {
    const stub = await mountQueue()
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true })
    await screen.findByRole('dialog')
    fireEvent.keyDown(document.body, { key: 's' })
    fireEvent.keyDown(document.body, { key: 'j' })
    // A keystroke acting on a list the owner cannot see, behind a modal that claims the
    // rest of the page is hidden, is the failure this prevents.
    expect(decisions(stub)).toHaveLength(0)
  })

  it('switches view on 1, 2 and 3', async () => {
    const stub = await mountQueue()
    fireEvent.keyDown(document.body, { key: '2' })
    await waitFor(() => {
      expect(stub.paths()).toContain('/admin/api/queue?status=spam')
    })
    fireEvent.keyDown(document.body, { key: '3' })
    await waitFor(() => {
      expect(stub.paths()).toContain('/admin/api/queue?status=approved')
    })
    fireEvent.keyDown(document.body, { key: '1' })
    await waitFor(() => {
      expect(stub.paths().filter((path) => path.endsWith('status=pending'))).toHaveLength(2)
    })
  })
})
