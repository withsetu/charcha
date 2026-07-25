// The session gate.
//
// The requirement being asserted here is the brief's: **an authentication failure must
// not look like an empty queue.** It is the failure that has a moderator believe they
// are finished when they have in fact been signed out, and it is the one this file
// exists for.
//
// Kill-shot: make `expiredCheck` in src/dashboard/components/triage.tsx return false
// unconditionally — the 401 then falls through to the ordinary failure path — and the
// expiry tests below fail. Recorded on the PR for #13.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { App } from '../../src/dashboard/app'
import { apiError, comment, json, queuePage, stubFetch, unhandled } from './harness'

const SIGNED_IN = { authenticated: true, via: 'session' }

describe('before the first answer', () => {
  it('shows neither the form nor the queue', async () => {
    // Rendering the form while the session call is out would flash a password prompt at
    // somebody already signed in, on every load.
    let release: (() => void) | undefined
    stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(json(200, SIGNED_IN))
          }
        }),
    )
    render(<App />)
    expect(screen.getByText('Checking your session…')).toBeTruthy()
    expect(screen.queryByLabelText('Dashboard password')).toBeNull()
    release?.()
    await screen.findByText('Charcha moderation')
  })
})

describe('signing in', () => {
  it('offers the form when there is no session, without calling it an expiry', async () => {
    stubFetch(() => apiError(401, 'UNAUTHORIZED', 'Sign in to use the dashboard.'))
    render(<App />)
    await screen.findByLabelText('Dashboard password')
    expect(screen.getByText(/Sign in with the dashboard password/)).toBeTruthy()
    // Nothing was interrupted, because nothing had started.
    expect(screen.queryByText(/Your session ended/)).toBeNull()
  })

  it("shows the server's own refusal, verbatim", async () => {
    // Reworded here, it would either invent a distinction src/admin/route.ts refused to
    // make or hide the one message that tells the owner what to do next.
    const stub = stubFetch(() => apiError(401, 'UNAUTHORIZED', 'Sign in to use the dashboard.'))
    render(<App />)
    const field = await screen.findByLabelText('Dashboard password')
    fireEvent.change(field, { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await screen.findByText('Could not sign in')
    expect(screen.getByText('Sign in to use the dashboard.')).toBeTruthy()
    expect(stub.calls.some((call) => call.method === 'POST')).toBe(true)
  })

  it('passes the throttle message through, which is the one that says what to do', async () => {
    stubFetch((call) =>
      call.method === 'POST'
        ? apiError(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Wait a minute and try again.')
        : apiError(401, 'UNAUTHORIZED', 'Sign in to use the dashboard.'),
    )
    render(<App />)
    const field = await screen.findByLabelText('Dashboard password')
    fireEvent.change(field, { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('Too many attempts. Wait a minute and try again.')
  })

  it('opens the queue once the password is accepted', async () => {
    stubFetch((call) => {
      if (call.path === '/admin/api/session' && call.method === 'GET') {
        return apiError(401, 'UNAUTHORIZED', 'Sign in to use the dashboard.')
      }
      if (call.path === '/admin/api/session' && call.method === 'POST') return json(200, SIGNED_IN)
      if (call.path.startsWith('/admin/api/queue')) {
        return json(200, queuePage([comment({ id: 1 })]))
      }
      return unhandled(call)
    })
    render(<App />)
    const field = await screen.findByLabelText('Dashboard password')
    fireEvent.change(field, { target: { value: 'right' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('Author 1')
  })
})

describe('a session that ends mid-triage', () => {
  it('shows the form and says the session ended, not that the queue is empty', async () => {
    // The whole point of this file. A 401 on the queue read is not "no comments".
    let expired = false
    stubFetch((call) => {
      if (call.path === '/admin/api/session') return json(200, SIGNED_IN)
      if (call.path.startsWith('/admin/api/queue')) {
        return expired
          ? apiError(401, 'UNAUTHORIZED', 'Sign in to use the dashboard.')
          : json(200, queuePage([comment({ id: 1 })]))
      }
      return unhandled(call)
    })

    render(<App />)
    await screen.findByText('Author 1')

    expired = true
    // Switching view is the cheapest way to make the next read happen.
    fireEvent.keyDown(document.body, { key: '2' })

    await screen.findByText(/Your session ended/)
    expect(screen.getByLabelText('Dashboard password')).toBeTruthy()
    // Neither the success copy nor the queue survives.
    expect(screen.queryByText('Nothing waiting on you')).toBeNull()
    expect(screen.queryByText('Author 1')).toBeNull()
  })

  it('leaves the comment in the queue when the decision was the thing that 401ed', async () => {
    // The row was removed optimistically. Signing back in must not show a queue missing
    // a comment nobody ever moderated, so the failure is recorded before the screen
    // changes.
    stubFetch((call) => {
      if (call.path === '/admin/api/session') return json(200, SIGNED_IN)
      if (call.path.startsWith('/admin/api/queue')) {
        return json(200, queuePage([comment({ id: 1 }), comment({ id: 2 })]))
      }
      if (call.method === 'POST') {
        return apiError(401, 'UNAUTHORIZED', 'Sign in to use the dashboard.')
      }
      return unhandled(call)
    })

    render(<App />)
    await screen.findByText('Author 1')
    fireEvent.keyDown(document.body, { key: 's' })

    await screen.findByText(/Your session ended/)
    // Sign back in: the queue is re-read from the server, which still has the comment
    // pending because the write was refused.
    const field = screen.getByLabelText('Dashboard password')
    fireEvent.change(field, { target: { value: 'again' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('Author 1')
  })
})

describe('signing out', () => {
  it('shows the form at once and tells the server after', async () => {
    const stub = stubFetch((call) => {
      if (call.path === '/admin/api/session' && call.method === 'GET') return json(200, SIGNED_IN)
      if (call.path === '/admin/api/session' && call.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      if (call.path.startsWith('/admin/api/queue')) return json(200, queuePage([]))
      return unhandled(call)
    })
    render(<App />)
    await screen.findByText('Nothing waiting on you')
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }))

    await screen.findByLabelText('Dashboard password')
    // Not called an expiry: the owner asked for this.
    expect(screen.queryByText(/Your session ended/)).toBeNull()
    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'DELETE')).toBe(true)
    })
  })
})
