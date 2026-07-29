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

/**
 * A report with every secret unset and a password that clears the floor, then whatever
 * the caller says.
 *
 * `shortPassword: false` is the default because it is the uneventful deployment, which
 * is what most of the assertions below are about.
 */
function report(set: Partial<Record<SetupSecret, boolean>> = {}, shortPassword = false) {
  return {
    secrets: Object.fromEntries(SETUP_SECRETS.map((name) => [name, set[name] ?? false])),
    shortPassword,
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
    // Including the one item this tab recommends (#174): a recommendation that still
    // shows after it has been taken is the nag #158 ruled out.
    expect(panelText()).not.toContain('Recommended')
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

describe('the dashboard password, when it is shorter than the floor (#120)', () => {
  it('says so, first, above everything optional', async () => {
    // It is the only item on this tab that is not optional and the only one guarding
    // every destructive action, so it does not sit under three feature switches.
    answering(() => json(200, report({}, true)))
    mount()

    await screen.findByText('Dashboard password')
    const headings = screen.getAllByRole('heading', { level: 2 })
    expect(headings.map((heading) => heading.textContent)).toEqual([
      'Dashboard password',
      'Turnstile bot check',
      'Email notifications',
      'Per-commenter rate limiting',
      'Allowed origins',
    ])
  })

  it('says what it is short *of*, and that it is a length test and only that', async () => {
    answering(() => json(200, report({}, true)))
    mount()

    await screen.findByText('Dashboard password')
    expect(panelText()).toContain('shorter than 15 characters')
    // The honest caveat, in the place the claim is made rather than in a README.
    expect(panelText()).toContain('been in a breach')
  })

  it('refuses a measurement where a verdict belongs, rather than rendering it', async () => {
    // **The leak guard on this side, and the reason it is a *truthy* non-boolean.** The
    // endpoint answers a boolean (src/admin/setup.ts), so today there is nothing here to
    // leak. If a future one sent the length instead, the natural reading of `4` is
    // truthy — the section would render, having been handed a measurement. A test
    // asserting only that the copy contains no number could not fail, because the copy
    // is static: the component takes no props and has nothing to print. So the assertion
    // is on the client's refusal.
    answering(() => json(200, { ...report(), shortPassword: 4 }))
    mount()

    await screen.findByText('Could not read what is configured')
    expect(screen.queryByText('Dashboard password')).toBeNull()
    expect(panelText()).not.toContain('4')
  })

  it('promises nothing will lock, because that is the fear this warning creates', async () => {
    answering(() => json(200, report({}, true)))
    mount()

    await screen.findByText('Dashboard password')
    expect(panelText()).toContain('keeps working')
  })

  it('gives the command to replace it, and the dashboard path for anyone without one', async () => {
    answering(() => json(200, report({}, true)))
    mount()

    // **Scoped to this section, because the tab has four of them.** With everything
    // unset the other three each render their own command block and their own
    // "Variables and Secrets" line, so an unscoped query passes whether or not this
    // section rendered anything at all.
    const heading = await screen.findByText('Dashboard password')
    const section = heading.closest('section')
    expect(section).not.toBeNull()

    expect(section?.querySelector('pre')?.textContent).toBe(
      'pnpm wrangler secret put CHARCHA_DASHBOARD_PASSWORD',
    )
    expect(section?.textContent).toContain('Variables and Secrets')
    // The lead-in and the block's accessible name have to agree, or a screen reader is
    // told to "set" a secret the visible copy says to "replace".
    expect(section?.textContent).toContain('Replace it from a checkout')
    expect(section?.querySelector('pre')?.getAttribute('aria-label')).toBe(
      'Commands to replace CHARCHA_DASHBOARD_PASSWORD',
    )
  })

  it('warns that replacing it signs every session out, including this one', async () => {
    // Sessions are signed with a key derived from the password (src/admin/session.ts).
    // An owner who rotates mid-triage and is thrown back to the login screen with no
    // warning reads that as the thing breaking.
    answering(() => json(200, report({}, true)))
    mount()

    await screen.findByText('Dashboard password')
    expect(panelText()).toContain('signs out every open session, including this one')
  })

  it('is silent about a password that clears the floor', async () => {
    // Not a nag, and not congratulatory: a deployment with a generated password has no
    // password section at all. A permanent "your password is fine" row would be one
    // more place a credential is named beside a status, for a line that is never news.
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Email notifications')
    expect(screen.queryByText('Dashboard password')).toBeNull()
    expect(panelText()).not.toContain('CHARCHA_DASHBOARD_PASSWORD')
  })

  it('does not turn the password into a fifth On/Off feature', async () => {
    // It is always set — an unconfigured dashboard answers nothing at all — so an On
    // badge beside it would report a fact that reaching the screen already proved.
    answering(() => json(200, report({}, true)))
    mount()

    await screen.findByText('Dashboard password')
    expect(screen.getAllByText('Off')).toHaveLength(3)
    expect(screen.queryByText('On')).toBeNull()
  })
})

describe('Turnstile, which this tab recommends rather than merely lists (#174)', () => {
  /** The Turnstile section on its own — the tab has four sections, and three of them also
   * print a command block and a "Variables and Secrets" line. */
  async function turnstileSection(): Promise<HTMLElement> {
    const heading = await screen.findByText('Turnstile bot check')
    const section = heading.closest('section')
    if (section === null) throw new Error('the Turnstile heading is not inside a section')
    return section
  }

  it('comes first of the optional three, because it is the one being recommended', async () => {
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Email notifications')
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([
      'Turnstile bot check',
      'Email notifications',
      'Per-commenter rate limiting',
      'Allowed origins',
    ])
  })

  it('says it is recommended, and makes the argument rather than the adjective', async () => {
    // "Recommended" on its own is an assertion of taste. What earns it is the one fact
    // that separates this layer from the rest of the pipeline (#174), so the copy has to
    // carry it: every other layer measures an absence, and this one asks for evidence.
    answering(() => json(200, report()))
    mount()

    const section = await turnstileSection()
    expect(section.textContent).toContain('Recommended')
    expect(section.textContent).toContain('the absence of something wrong')
    expect(section.textContent).toContain('free and unmetered')
    // Scoped to the layers that judge a comment, and the exception named, because rate
    // limiting is layer 4 and measures volume rather than an absence (src/spam/index.ts).
    // "Every other layer" would be the sort of overclaim a reader can falsify.
    expect(section.textContent).toContain('Rate limiting bounds how many arrive')
  })

  it('puts Recommended beside the status badge, not loose in the row', async () => {
    // The badges are a column a reader scans down, so `Off` keeps the right-hand edge
    // that `On` holds in every section below. Two loose children of a `justify-between`
    // row spread themselves across it instead, which is what this looked like when it
    // was first driven in a browser.
    answering(() => json(200, report()))
    mount()

    const section = await turnstileSection()
    const badges = [...section.querySelectorAll('[data-slot="badge"]')]
    expect(badges.map((badge) => badge.textContent)).toEqual(['Recommended', 'Off'])

    // **The assertion is that the badges have a parent of their own, and the first
    // attempt at it did not test that.** "Both badges share a parent" is true of the
    // broken layout too — loose in the header row, their shared parent is the row. What
    // separates the two is whether the heading is in there with them: it is exactly the
    // heading that `justify-between` pushes them away from.
    const grouped = badges[0]?.parentElement
    expect(grouped?.contains(badges[1] ?? null)).toBe(true)
    expect(grouped?.querySelector('h2')).toBeNull()
  })

  it('says which half is the trap and which half is harmless', async () => {
    // They are not symmetrical and the copy must not imply they are: a secret with no
    // sitekey holds every comment (#104), while a sitekey with no secret makes the layer
    // abstain and costs nothing (src/spam/turnstile.ts). Told as one undifferentiated
    // warning, the reader cannot tell which mistake they are about to make.
    answering(() => json(200, report()))
    mount()

    const text = (await turnstileSection()).textContent ?? ''
    expect(text).toContain('the two failures are not the same size')
    expect(text).toContain('A sitekey with no secret key is the harmless direction')
    // And the queue does name the reason — src/spam/layer.ts prefixes the layer and
    // src/submit/pipeline.ts stores it, asserted by test/worker/submit/pipeline.test.ts.
    // Saying "nothing anywhere says why" would document a signal the Worker goes out of
    // its way to produce as absent.
    expect(text).toContain('turnstile: no-token-unverified-deployment')
  })

  it('goes quiet the moment the secret is set, rather than nagging', async () => {
    // #158's constraint, and the one a recommendation is most likely to break: a
    // deployment that has already done this must find a status line, not a pitch.
    answering(() => json(200, report({ TURNSTILE_SECRET_KEY: true })))
    mount()

    const section = await turnstileSection()
    expect(section.textContent).not.toContain('Recommended')
    expect(section.textContent).not.toContain('the absence of something wrong')
    expect(section.querySelector('pre')).toBeNull()
  })

  it('names both halves before it gives the command that sets one', async () => {
    // A half-followed recommendation is #104 exactly. So the sitekey cannot sit in a
    // paragraph below the command block, where a reader who has already started typing
    // will never reach it.
    answering(() => json(200, report()))
    mount()

    const text = (await turnstileSection()).textContent ?? ''
    expect(text).toContain('data-turnstile-sitekey')
    expect(text.indexOf('data-turnstile-sitekey')).toBeLessThan(text.indexOf('wrangler secret put'))
  })

  it('discloses the third party before the command, not after it', async () => {
    // The product rule for anything that transmits: say what is sent and to whom before
    // the control that turns it on. Turnstile is the one layer that puts somebody else's
    // script in a reader's browser, and a recommendation is exactly the pressure that
    // would push that sentence below the fold.
    answering(() => json(200, report()))
    mount()

    const text = (await turnstileSection()).textContent ?? ''
    expect(text).toContain('challenges.cloudflare.com')
    expect(text.indexOf('challenges.cloudflare.com')).toBeLessThan(
      text.indexOf('wrangler secret put'),
    )
  })

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

  it('re-reads the list when the dialog reports a save, and not otherwise', async () => {
    // The dialog can be open over this panel while the list is edited, so without the
    // re-read an owner who saved would be looking at the list as it was before — in the
    // one place they came to check the edit landed. Driven for real in a browser too, on
    // the PR; this is the wiring.
    let stored = ['https://old.example']
    const stub = answering(
      () => json(200, report()),
      () => json(200, { allowedOrigins: stored, selfOrigin: 'https://c.example' }),
    )
    const { rerender } = render(<Setup onEditOrigins={noop} onExpired={noop} originsSavedAt={0} />)
    expect(await screen.findByText('https://old.example')).toBeTruthy()
    const reads = () => stub.paths().filter((path) => path === '/admin/api/settings').length
    expect(reads()).toBe(1)

    // A render for any other reason must not refetch — the effect is keyed on the save,
    // not on the component running again.
    rerender(<Setup onEditOrigins={noop} onExpired={noop} originsSavedAt={0} />)
    expect(reads()).toBe(1)

    stored = ['https://maya.build']
    rerender(<Setup onEditOrigins={noop} onExpired={noop} originsSavedAt={17} />)
    expect(await screen.findByText('https://maya.build')).toBeTruthy()
    expect(reads()).toBe(2)
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
        ...report(),
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
    answering(() => json(200, { ...report(), secrets: partial }))
    mount()

    await screen.findByText('Could not read what is configured')
    expect(screen.queryByText('Turnstile bot check')).toBeNull()
  })

  it('refuses a report with no password verdict, rather than reading silence as fine', async () => {
    // #120's version of the field-missing failure, and the worse one: `undefined` is
    // falsy, so a dropped `shortPassword` renders as a password nobody has any concern
    // about — a reassurance the server never sent.
    const { secrets } = report()
    answering(() => json(200, { secrets }))
    mount()

    await screen.findByText('Could not read what is configured')
    expect(screen.queryByText('Dashboard password')).toBeNull()
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
