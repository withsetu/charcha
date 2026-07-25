// The allowed-origins panel (#57), driven through the header that opens it.
//
// The panel edits the list that decides which pages may post into this deployment's
// queue, so two of these are about the surface refusing to guess: an unreadable list
// must never render as an empty one, and a save that failed must never look like a save
// that worked. Both of those failures end the same way — an owner overwriting a working
// allowlist with nothing.
//
// Rendered through Triage rather than by mounting SiteSettings directly. The wiring is
// half of what is being tested: a panel that exists and cannot be reached from the
// header is the same as no panel, and the key-handler gate only exists in Triage.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Triage } from '../../src/dashboard/components/triage'
import type { FetchStub, RecordedCall, Responder } from './harness'
import { apiError, comment, decision, json, queuePage, stubFetch, unhandled } from './harness'

const SELF = 'https://comments.example.com'
const SETTINGS = '/admin/api/settings'

function settings(allowedOrigins: string[]) {
  return { allowedOrigins, selfOrigin: SELF }
}

/**
 * The queue behind the panel, and it holds comments on purpose.
 *
 * An empty queue would make the key-handler tests below pass for the wrong reason:
 * with no current comment there is nothing for `a` or `s` to act on, so a missing
 * gate would look exactly like a working one. Confirmed by kill-shot — see this
 * file's PR.
 */
const queueBehind = (call: RecordedCall) => {
  if (call.path.startsWith('/admin/api/queue')) {
    return json(200, queuePage([comment({ id: 1 }), comment({ id: 2 })]))
  }
  if (/^\/admin\/api\/comments\/\d+\/status$/.test(call.path)) {
    return json(200, decision(1, 'spam'))
  }
  return unhandled(call)
}

/** Renders the queue with a stubbed network, then opens the panel from the header. */
async function openPanel(
  responder: Responder,
  onExpired: () => void = vi.fn(),
): Promise<FetchStub> {
  const stub = stubFetch(responder)
  render(<Triage onExpired={onExpired} onSignOut={vi.fn()} />)

  fireEvent.click(await screen.findByRole('button', { name: /allowed origins/i }))
  return stub
}

/** Answers the read with `allowedOrigins`, and the write with whatever it is given. */
function settingsResponder(read: string[], write?: () => Response): Responder {
  return (call) => {
    if (call.path === SETTINGS && call.method === 'GET') return json(200, settings(read))
    if (call.path === SETTINGS && call.method === 'PUT') {
      return write === undefined ? unhandled(call) : write()
    }
    return queueBehind(call)
  }
}

function field(): HTMLTextAreaElement {
  return screen.getByLabelText(/one address per line/i)
}

describe('reaching the panel', () => {
  it('is opened from the header, where an owner setting this up will look', async () => {
    await openPanel(settingsResponder([]))

    expect(await screen.findByRole('dialog', { name: /allowed origins/i })).toBeTruthy()
  })

  it('reads the list every time it opens, not once per page load', async () => {
    // A panel showing a value from before the owner saved in another tab is a value
    // they are about to overwrite.
    const stub = await openPanel(settingsResponder([]))
    await screen.findByRole('dialog', { name: /allowed origins/i })

    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    fireEvent.click(screen.getByRole('button', { name: /allowed origins/i }))
    await screen.findByRole('dialog', { name: /allowed origins/i })

    const reads = stub.calls.filter((call) => call.path === SETTINGS && call.method === 'GET')
    expect(reads).toHaveLength(2)
  })
})

describe('what it shows the owner', () => {
  it('puts the stored origins in the field, one per line', async () => {
    await openPanel(settingsResponder(['https://maya.build', 'https://www.maya.build']))

    await screen.findByRole('dialog', { name: /allowed origins/i })
    expect(field().value).toBe('https://maya.build\nhttps://www.maya.build')
  })

  it('says this deployment’s own address is already allowed', async () => {
    // Without this the owner reads the list as the whole rule, adds this address by
    // hand, and never learns a fresh deployment already accepts its own origin.
    await openPanel(settingsResponder([]))

    const dialog = await screen.findByRole('dialog', { name: /allowed origins/i })
    expect(within(dialog).getByText(SELF)).toBeTruthy()
  })

  it('says plainly that this is not Turnstile’s hostname list', async () => {
    // #57: an owner went looking for this setting, found Turnstile's Hostname
    // Management screen, and edited that instead. The sentence is as much of the fix
    // as the field is.
    await openPanel(settingsResponder([]))

    const dialog = await screen.findByRole('dialog', { name: /allowed origins/i })
    expect(within(dialog).getByText(/not Turnstile/i)).toBeTruthy()
  })

  it('reports a list it could not read, rather than showing an empty one', async () => {
    await openPanel((call) =>
      call.path === SETTINGS
        ? apiError(503, 'UNAVAILABLE', 'The dashboard is not available on this deployment.')
        : queueBehind(call),
    )

    const dialog = await screen.findByRole('dialog', { name: /allowed origins/i })
    expect(within(dialog).getByText(/could not read the allowed origins/i)).toBeTruthy()
    expect(within(dialog).queryByLabelText(/one address per line/i)).toBeNull()
  })
})

describe('saving', () => {
  it('sends the whole list, so an origin can be removed as well as added', async () => {
    const stub = await openPanel(
      settingsResponder(['https://maya.build', 'https://old.example'], () =>
        json(200, settings(['https://maya.build'])),
      ),
    )
    await screen.findByRole('dialog', { name: /allowed origins/i })

    fireEvent.change(field(), { target: { value: 'https://maya.build' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Saved')
    })
    expect(stub.calls.find((call) => call.method === 'PUT')?.body).toEqual({
      allowedOrigins: ['https://maya.build'],
    })
  })

  it('shows the server’s canonical form back, which is what the origin check compares', async () => {
    await openPanel(settingsResponder([], () => json(200, settings(['https://maya.build']))))
    await screen.findByRole('dialog', { name: /allowed origins/i })

    fireEvent.change(field(), { target: { value: 'HTTPS://Maya.Build/' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(field().value).toBe('https://maya.build')
    })
  })

  it('reports a refused entry by name and does not claim to have saved', async () => {
    await openPanel(
      settingsResponder([], () =>
        apiError(400, 'BAD_REQUEST', '“maya.build” is not an address a browser sends.'),
      ),
    )
    await screen.findByRole('dialog', { name: /allowed origins/i })

    fireEvent.change(field(), { target: { value: 'maya.build' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText(/is not an address a browser sends/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).not.toContain('Saved')
    // The owner's typing survives, so they can correct it rather than retype it.
    expect(field().value).toBe('maya.build')
  })

  it('ends the session on a 401 rather than reporting a failed save', async () => {
    const onExpired = vi.fn()
    await openPanel(
      (call) =>
        call.path === SETTINGS
          ? apiError(401, 'UNAUTHORIZED', 'Sign in to use the dashboard.')
          : queueBehind(call),
      onExpired,
    )

    await waitFor(() => {
      expect(onExpired).toHaveBeenCalled()
    })
  })
})

describe('the keyboard, while the panel is open', () => {
  it('does not moderate the queue behind it', async () => {
    // Every binding in src/dashboard/keys.ts is a bare letter. `s` typed into the
    // textarea is caught by isEditableTarget — but a keystroke landing on the dialog
    // itself, after a click on its heading, would otherwise reach the document
    // listener and mark the comment behind the modal as spam.
    const stub = await openPanel(settingsResponder([]))
    const dialog = await screen.findByRole('dialog', { name: /allowed origins/i })

    for (const key of ['a', 's', 'd', 'z', 'j', 'k', '1']) {
      fireEvent.keyDown(dialog, { key })
    }

    expect(stub.calls.some((call) => call.path.includes('/status'))).toBe(false)
  })

  it('does not open the shortcut sheet over the owner’s unsaved typing', async () => {
    const stub = await openPanel(settingsResponder([]))
    const dialog = await screen.findByRole('dialog', { name: /allowed origins/i })

    fireEvent.change(field(), { target: { value: 'https://maya.build' } })
    fireEvent.keyDown(dialog, { key: '?', shiftKey: true })

    expect(screen.queryByRole('dialog', { name: /keyboard shortcuts/i })).toBeNull()
    expect(field().value).toBe('https://maya.build')
    expect(stub.calls.some((call) => call.method === 'PUT')).toBe(false)
  })
})
