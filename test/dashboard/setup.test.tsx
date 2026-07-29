// The Setup tab (#158): what it says when nothing is configured, what it says when
// everything is, and the two things it must never do — render a value, or report a
// failed read as a feature being off.
//
// The panel is rendered directly here rather than through `Triage`, because what is
// being asserted is its copy and its states. The wiring — the fourth tab, the `4`
// shortcut, and the queue keys being inert while it is in front — is
// test/dashboard/shortcuts.test.tsx and test/dashboard/triage.test.tsx.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SETUP_SECRETS, type SetupSecret } from '../../src/dashboard/api'
import { Setup } from '../../src/dashboard/components/setup'
import { apiError, json, stubFetch, unhandled, type Responder } from './harness'

function noop() {
  return
}

/** A report with every secret unset, then whatever the caller says. */
function report(set: Partial<Record<SetupSecret, boolean>> = {}) {
  return {
    secrets: Object.fromEntries(SETUP_SECRETS.map((name) => [name, set[name] ?? false])),
  }
}

const NO_ORIGINS = { allowedOrigins: [], selfOrigin: 'https://comments.example.com' }

/** Answers both of the panel's reads, and refuses anything else loudly. */
function answering(setup: () => Response, settings: () => Response = () => json(200, NO_ORIGINS)) {
  const responder: Responder = (call) => {
    if (call.path === '/admin/api/setup') return setup()
    if (call.path === '/admin/api/settings' && call.method === 'GET') return settings()
    return unhandled(call)
  }
  return stubFetch(responder)
}

function mount(overrides: { onEditOrigins?: () => void; onExpired?: () => void } = {}) {
  render(
    <Setup
      onEditOrigins={overrides.onEditOrigins ?? noop}
      onExpired={overrides.onExpired ?? noop}
      originsSavedAt={0}
    />,
  )
}

/** The whole panel's text, for the assertions that are about what is *not* in it. */
function panelText(): string {
  return document.body.textContent ?? ''
}

describe('a deployment with nothing switched on', () => {
  it('says so for each feature, and names the secrets that are missing', async () => {
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Email notifications')
    expect(screen.getAllByText('Off')).toHaveLength(3)
    for (const name of SETUP_SECRETS) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0)
    }
  })

  it('gives the exact command, for somebody who has a checkout', async () => {
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Email notifications')
    const commands = [...document.querySelectorAll('pre')].map((block) => block.textContent ?? '')
    expect(commands.join('\n')).toContain('pnpm wrangler secret put TURNSTILE_SECRET_KEY')
    expect(commands.join('\n')).toContain('pnpm wrangler secret put IP_HASH_SECRET')
    // The email trio is one block, because they are set together or not at all.
    expect(commands).toContain(
      'pnpm wrangler secret put RESEND_API_KEY\npnpm wrangler secret put CHARCHA_NOTIFY_FROM\npnpm wrangler secret put CHARCHA_NOTIFY_TO',
    )
  })

  it('gives the dashboard route too, because most deployers have no terminal', async () => {
    // #57's history: the workaround needed a checkout, wrangler and an API token with D1
    // on it, and the owner of this project had none of them either.
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Email notifications')
    expect(screen.getAllByText(/Variables and Secrets/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Workers & Pages/).length).toBeGreaterThan(0)
  })

  it('says what being off actually costs, rather than only that it is off', async () => {
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Email notifications')
    expect(panelText()).toContain('Nothing is emailed when a comment arrives')
    expect(panelText()).toContain('per-IP half of rate limiting abstains')
  })
})

describe('a deployment with everything switched on', () => {
  it('is quiet: no instructions, and nothing to do', async () => {
    // Not a nag, and not congratulatory either. A finished deployment has no commands on
    // this screen at all.
    answering(() =>
      json(200, report(Object.fromEntries(SETUP_SECRETS.map((name) => [name, true])))),
    )
    mount()

    await screen.findByText('Email notifications')
    expect(screen.getAllByText('On')).toHaveLength(3)
    expect(screen.queryByText('Off')).toBeNull()
    expect(panelText()).not.toContain('wrangler secret put')
  })
})

describe('email notifications, which are three secrets or nothing', () => {
  it('reports a half-configured deployment as off, and says which half', async () => {
    answering(() => json(200, report({ RESEND_API_KEY: true, CHARCHA_NOTIFY_TO: true })))
    mount()

    await screen.findByText('Email notifications')
    expect(panelText()).toContain('Partly set up, so nothing is sent')
    // Every one of the three is listed with its own state, which is the whole of "say
    // which are missing".
    expect(screen.getAllByText('Set').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('Not set').length).toBeGreaterThanOrEqual(1)
    // And only the missing one is in the command block.
    const commands = [...document.querySelectorAll('pre')].map((block) => block.textContent ?? '')
    expect(commands).toContain('pnpm wrangler secret put CHARCHA_NOTIFY_FROM')
  })

  it('says the from-address needs a verified domain, and that failure is silence', async () => {
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Email notifications')
    expect(panelText()).toContain('verified with your email provider')
    expect(panelText()).toContain('looks exactly like the feature being switched off')
  })
})

describe('Turnstile, whose two halves live in two places', () => {
  it('spells the sitekey out even when the secret is set — which is #104', async () => {
    // The deployment that refused every comment silently had the secret and no
    // `data-turnstile-sitekey` anywhere. Charcha cannot see the site's pages, so this
    // screen is where a reader would find that out — and it has to say it in the state
    // that looks finished, not only in the one that looks broken.
    answering(() => json(200, report({ TURNSTILE_SECRET_KEY: true })))
    mount()

    await screen.findByText('Turnstile bot check')
    expect(panelText()).toContain('data-turnstile-sitekey')
    expect(panelText()).toContain('The other half is on your site, not here.')
    expect(panelText()).toContain('held for review')
  })

  it('says it in the unconfigured state too, so neither half is a surprise later', async () => {
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Turnstile bot check')
    expect(panelText()).toContain('data-turnstile-sitekey')
    expect(panelText()).toContain('Set both or neither')
  })
})

describe('the allowed origins, which are the one thing here that is editable', () => {
  it('names this deployment’s own address when the list is empty', async () => {
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Allowed origins')
    expect(await screen.findByText('https://comments.example.com')).toBeTruthy()
    expect(panelText()).toContain('No addresses listed yet')
  })

  it('lists what is stored, and hands editing to the dialog that already exists', async () => {
    const onEditOrigins = vi.fn()
    answering(
      () => json(200, report()),
      () => json(200, { allowedOrigins: ['https://maya.build'], selfOrigin: 'https://c.example' }),
    )
    mount({ onEditOrigins })

    expect(await screen.findByText('https://maya.build')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Edit allowed origins/ }))
    expect(onEditOrigins).toHaveBeenCalledTimes(1)
  })

  it('does not offer a save button for anything a Worker cannot write', async () => {
    // A Worker cannot set its own secrets, so a control that looked like it could would
    // be a dead button. The only one on this panel is the origins editor.
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Email notifications')
    const buttons = screen.getAllByRole('button').map((button) => button.textContent)
    expect(buttons).toEqual(['Edit allowed origins'])
  })
})

describe('what it refuses to do', () => {
  it('never renders a value, even if the server sends one', async () => {
    // **The client half of the leak guard.** The endpoint answers booleans
    // (src/admin/setup.ts, test/worker/admin/setup.test.ts). If a future one did not,
    // the natural reading of a string here is truthy — so it would render as *On* with
    // the value in hand. `readSetup` refuses the whole report instead.
    answering(() =>
      json(200, {
        secrets: {
          ...report().secrets,
          TURNSTILE_SECRET_KEY: '0x4AAAAAAA-sentinel-secret',
        },
      }),
    )
    mount()

    await screen.findByText('Could not read what is configured')
    expect(panelText()).not.toContain('0x4AAAAAAA-sentinel-secret')
    expect(panelText()).not.toContain('sentinel')
  })

  it('refuses a report missing a field, rather than calling that feature off', async () => {
    // `undefined` renders as *not set*, which is indistinguishable from the real answer
    // — so an owner would be told to configure something they configured months ago.
    const partial = report().secrets
    delete partial.TURNSTILE_SECRET_KEY
    answering(() => json(200, { secrets: partial }))
    mount()

    await screen.findByText('Could not read what is configured')
    expect(screen.queryByText('Turnstile bot check')).toBeNull()
  })

  it('reports a failed read as a failure, never as a deployment with nothing on', async () => {
    answering(() => apiError(503, 'UNAVAILABLE', 'Something went wrong. Try again.'))
    mount()

    await screen.findByText('Could not read what is configured')
    expect(screen.getByText(/Something went wrong. Try again./)).toBeTruthy()
    expect(screen.queryByText('Email notifications')).toBeNull()
  })

  it('reports a rejected fetch rather than a skeleton that never resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
    mount()

    await screen.findByText('Could not read what is configured')
    // Both reads fail offline, and each says so in its own section rather than one of
    // them silently rendering as an answer.
    expect(screen.getAllByText(/Check your connection/)).toHaveLength(2)
    expect(screen.getByText('Could not read the allowed origins')).toBeTruthy()
  })

  it('ends the session on a 401, the way every other call on this surface does', async () => {
    const onExpired = vi.fn()
    answering(() => apiError(401, 'UNAUTHORIZED', 'Sign in to use the dashboard.'))
    mount({ onExpired })

    await waitFor(() => {
      expect(onExpired).toHaveBeenCalled()
    })
  })

  it('keeps the two reads independent, so one failure does not hide the other', async () => {
    answering(
      () => json(200, report()),
      () => apiError(503, 'UNAVAILABLE', 'Something went wrong. Try again.'),
    )
    mount()

    await screen.findByText('Could not read the allowed origins')
    // The secret report still arrived, and is still worth the trip.
    expect(screen.getByText('Email notifications')).toBeTruthy()
  })
})
