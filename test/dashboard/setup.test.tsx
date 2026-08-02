// The Setup tab (#158): what it says when nothing is configured, what it says when
// everything is, and the two things it must never do — render a value, or report a
// failed read as a feature being off.
//
// The panel is rendered directly here rather than through `Triage`, because what is
// being asserted is its copy and its states. The wiring — the fourth tab, the `4`
// shortcut, and the queue keys being inert while it is in front — is
// test/dashboard/shortcuts.test.tsx and test/dashboard/triage.test.tsx.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SETUP_SECRETS, type ClassifierStatus, type SetupSecret } from '../../src/dashboard/api'
import { Setup } from '../../src/dashboard/components/setup'
import {
  apiError,
  classifierBody as classifier,
  json,
  settingsBody,
  setupBody,
  stubFetch,
  unhandled,
  type Responder,
} from './harness'

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
function report(
  set: Partial<Record<SetupSecret, boolean>> = {},
  shortPassword = false,
  classifierStatus: ClassifierStatus = classifier(),
) {
  return setupBody({
    secrets: Object.fromEntries(SETUP_SECRETS.map((name) => [name, set[name] ?? false])),
    shortPassword,
    classifier: classifierStatus,
  })
}

/**
 * The settings body of a deployment that has configured nothing.
 *
 * Every field is present because `readSettings` validates each of them and refuses a body
 * missing one (#173, #207) — see `settingsBody` in ./harness.tsx, which is what keeps that
 * list in one place across this directory.
 */
const NO_ORIGINS = settingsBody()

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

/**
 * What a settings field currently shows.
 *
 * A narrowing rather than a cast, because the two TypeScript projects that read this file
 * disagree about what `getByLabelText` returns and only one of them accepts an assertion —
 * and `instanceof` is the answer both take. It returns `''` for anything that is not an
 * input, which is a value no assertion below expects, so a query that stopped finding the
 * field fails rather than passing on a blank.
 */
function fieldValue(label: string): string {
  const element = screen.getByLabelText(label)
  return element instanceof HTMLInputElement ? element.value : '(not an input)'
}

/** The whole panel's text, for the assertions that are about what is *not* in it. */
function panelText(): string {
  return document.body.textContent ?? ''
}

/**
 * The paragraph budget (#216), asserted per section rather than as a total.
 *
 * **A total would be satisfied by moving prose from one section into another**, which is
 * the failure mode this tab already has: every paragraph on it was individually
 * justified and nobody was counting. A per-section ceiling is the number that fails when
 * a later change re-grows one of them.
 *
 * Screen-reader-only status regions are excluded, because they are not on the page a
 * sighted owner reads and cutting one would be an accessibility regression rather than a
 * simplification. Everything else counts, including field hints and warning bodies.
 */
function visibleParagraphs(sectionTitle: string): number {
  // By heading rather than by text: the moderation policy's `IP_HASH_SECRET` warning
  // names another section in bold, so `getByText` finds two elements for it.
  const heading = screen
    .getAllByRole('heading', { level: 2 })
    .find((candidate) => candidate.textContent === sectionTitle)
  const section = heading?.closest('section')
  if (section == null) throw new Error(`no section is headed ${sectionTitle}`)
  return [...section.querySelectorAll('p')].filter((p) => !p.classList.contains('sr-only')).length
}

describe('the tab is state, action and link, not a textbook (#216)', () => {
  /** The worst case for length: nothing configured, so every section is at full size. */
  const BUDGET_UNCONFIGURED: Record<string, number> = {
    'Dashboard password': 3,
    'Moderation policy': 6,
    'Turnstile bot check': 4,
    'Email notifications': 5,
    'Per-commenter rate limiting': 2,
    'Spam classifier': 2,
    'Third-party spam service': 2,
    'Your site’s address': 2,
    'Allowed origins': 2,
  }

  /** And the case #158 cares about: a finished deployment finds almost nothing here. */
  const BUDGET_CONFIGURED: Record<string, number> = {
    'Moderation policy': 4,
    'Turnstile bot check': 2,
    'Email notifications': 4,
    'Per-commenter rate limiting': 1,
    'Spam classifier': 1,
    'Third-party spam service': 2,
    'Your site’s address': 2,
    'Allowed origins': 2,
  }

  it('keeps every section inside its budget when nothing is configured', async () => {
    answering(() => json(200, report({}, true)))
    mount()

    await screen.findByText('Dashboard password')
    for (const [title, budget] of Object.entries(BUDGET_UNCONFIGURED)) {
      expect(visibleParagraphs(title), title).toBeLessThanOrEqual(budget)
    }
  })

  it('says even less on a deployment that has finished configuring itself', async () => {
    answering(
      () =>
        json(
          200,
          report(
            Object.fromEntries(SETUP_SECRETS.map((name) => [name, true])),
            false,
            classifier({ state: 'trained', hamCount: 41, spamCount: 38 }),
          ),
        ),
      () =>
        json(
          200,
          settingsBody({
            notifyFrom: 'comments@maya.build',
            notifyTo: 'maya@maya.build',
            siteUrl: 'https://maya.build',
            allowedOrigins: ['https://maya.build'],
          }),
        ),
    )
    mount()

    await screen.findByText('Email notifications')
    for (const [title, budget] of Object.entries(BUDGET_CONFIGURED)) {
      expect(visibleParagraphs(title), title).toBeLessThanOrEqual(budget)
    }
  })

  it('sends the explanation to the docs rather than deleting it', async () => {
    // The other half of the cut: every section that lost prose keeps a way to the page
    // that now carries it. A link per section, not one link at the bottom of the tab.
    answering(() => json(200, report({}, true)))
    mount()

    await screen.findByText('Dashboard password')
    const linked = [...document.querySelectorAll('a[href^="https://charcha.dev/"]')]
    const sections = new Set(
      linked.map((link) => link.closest('section')?.querySelector('h2')?.textContent),
    )
    expect([...sections].sort()).toEqual([
      'Allowed origins',
      'Dashboard password',
      'Email notifications',
      'Moderation policy',
      'Per-commenter rate limiting',
      'Spam classifier',
      'Third-party spam service',
      'Turnstile bot check',
      'Your site’s address',
    ])
  })
})

describe('a deployment with nothing switched on', () => {
  it('says so for each feature, and names the secrets that are missing', async () => {
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Email notifications')
    expect(screen.getAllByText('Off')).toHaveLength(4)
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
    // Email notifications are one secret since #207 — the two addresses stopped being
    // secrets and became fields on this screen, so the command block shrank to the key.
    expect(commands).toContain('pnpm wrangler secret put RESEND_API_KEY')
    expect(commands.join('\n')).not.toContain('CHARCHA_NOTIFY')
  })

  it('gives the dashboard route too, because most deployers have no terminal', async () => {
    // #57's history: the workaround needed a checkout, wrangler and an API token with D1
    // on it, and the owner of this project had none of them either. #216 turned the
    // six-step click path into a link, because it was on the page four times over — but
    // the route is still *named first*, ahead of the command, and it is still one click
    // rather than a terminal.
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Email notifications')
    const routes = screen.getAllByRole('link', { name: /Variables and Secrets/ })
    expect(routes.length).toBeGreaterThan(0)
    for (const route of routes) {
      expect(route.getAttribute('href')).toBe('https://charcha.dev/secrets/')
    }
    // Ahead of the command it is an alternative to, in every block that has one.
    const text = panelText()
    expect(text.indexOf('Variables and Secrets')).toBeLessThan(text.indexOf('wrangler secret put'))
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
    answering(
      () => json(200, report(Object.fromEntries(SETUP_SECRETS.map((name) => [name, true])))),
      // Configured includes the settings now, not only the secrets: email notifications
      // are the key *and* two addresses, and two of the three are rows since #207.
      () =>
        json(200, settingsBody({ notifyFrom: 'comments@maya.build', notifyTo: 'maya@maya.build' })),
    )
    mount()

    await screen.findByText('Email notifications')
    expect(screen.getAllByText('On')).toHaveLength(4)
    expect(screen.queryByText('Off')).toBeNull()
    expect(panelText()).not.toContain('wrangler secret put')
    // Including the one item this tab recommends (#174): a recommendation that still
    // shows after it has been taken is the nag #158 ruled out.
    expect(panelText()).not.toContain('Recommended')
  })
})

describe('the spam classifier, which trains itself and says nothing until it can (#177)', () => {
  /** The classifier section alone — several others print counts and commands too. */
  async function section(): Promise<HTMLElement> {
    const heading = await screen.findByText('Spam classifier')
    const found = heading.closest('section')
    if (found === null) throw new Error('the classifier heading is not inside a section')
    return found
  }

  function showing(status: Partial<ClassifierStatus>) {
    answering(() => json(200, report({}, false, classifier(status))))
    mount()
  }

  it('sits between the local layers and the one that transmits, in pipeline order', async () => {
    // Layer 7 then layer 8 (CLAUDE.md), which is also the privacy ordering: this one runs
    // inside the deployment and sends nothing, and the section under it is the only
    // feature in Charcha that sends anything about a reader anywhere. The other way round
    // would put the disclosure before the thing it is a trade against.
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Spam classifier')
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([
      'Moderation policy',
      'Turnstile bot check',
      'Email notifications',
      'Per-commenter rate limiting',
      'Spam classifier',
      'Third-party spam service',
      'Your site’s address',
      'Allowed origins',
    ])
  })

  it('leads with what is missing, not with a statistic', async () => {
    // #177's own worked example, and its own instruction: "the spam classifier starts
    // helping after 30 approvals and 30 spam decisions; you have 6 and 40". The number
    // that changes what the owner does is 24, and it is the one they cannot work out
    // from a progress bar without doing the subtraction themselves.
    showing({ state: 'learning', hamCount: 6, spamCount: 40, updatedAt: 1_800_000_000 })

    expect((await section()).textContent).toContain('24 more approvals')
  })

  it('names both remaining classes when both are short, counted separately', async () => {
    showing({ state: 'learning', hamCount: 6, spamCount: 28 })

    const text = (await section()).textContent ?? ''
    expect(text).toContain('24 more approvals')
    expect(text).toContain('2 more spam decisions')
  })

  it('says which buttons teach it, because that is the action the number implies', async () => {
    // The half #177 says is missing: an owner cannot know they are 24 approvals away, or
    // that approving is the thing that gets them there. Delete is named as *not* teaching
    // it, because that is the guess a reader would otherwise make (src/spam/train.ts).
    showing({ state: 'learning', hamCount: 6, spamCount: 40 })

    const text = (await section()).textContent ?? ''
    expect(text).toContain('Approve')
    expect(text).toContain('Delete does not')
  })

  it('says the badge word Learning rather than borrowing On or Off', async () => {
    // A layer that is running and abstaining is neither. Calling it Off would send an
    // owner to switch on something that is already on; calling it On would claim it is
    // judging comments when it is not.
    showing({ state: 'learning', hamCount: 6, spamCount: 40 })

    expect((await section()).textContent).toContain('Learning')
    expect(screen.getAllByText('Off')).toHaveLength(4)
  })

  it('reports a deployment that has trained nothing without implying a failure', async () => {
    showing({ state: 'learning', hamCount: 0, spamCount: 0, updatedAt: null })

    expect((await section()).textContent).toContain('has not learned anything yet')
  })

  it('is quiet once it is trained, and says what it does with what it learned', async () => {
    showing({
      state: 'trained',
      hamCount: 41,
      spamCount: 38,
      updatedAt: 1_800_000_000,
    })

    const text = (await section()).textContent ?? ''
    expect(text).toContain('41')
    expect(text).toContain('38')
    // The authority the layer actually has, stated where an owner reads about it: it can
    // hold a comment and it can never refuse one (src/spam/classifier.ts).
    expect(text).toContain('never refuse')
    expect(text).not.toContain('wrangler')
  })

  it('names the reason it writes, so the owner can go and see it working', async () => {
    // The strongest evidence available that the model is doing something, and it costs
    // nothing: `CLASSIFIER_REASON` is on every comment this layer held, in the queue the
    // owner is already looking at. The Turnstile section makes the same move with
    // `turnstile: no-token-unverified-deployment`.
    showing({ state: 'trained', hamCount: 41, spamCount: 38, updatedAt: 1_800_000_000 })

    expect((await section()).textContent).toContain('classifier: similar-to-spam')
  })

  it('says when it last learned, which is the only symptom a stalled trainer has', async () => {
    // Relative to the real clock rather than a frozen one: `findBy` needs timers to
    // advance, and `vi.useFakeTimers()` here deadlocks the query instead of pinning the
    // date. Three days back is well inside `formatAge`'s relative window and far enough
    // from its boundaries that nothing here depends on when the suite runs.
    const threeDaysAgo = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60
    showing({ state: 'trained', hamCount: 41, spamCount: 38, updatedAt: threeDaysAgo })

    expect((await section()).textContent).toContain('3 days ago')
  })

  it('says the layer never runs when there is no binding, and how to give it one', async () => {
    // Distinguishable from *cold* by what it asks for: a binding rather than more
    // moderating. Nothing else on the deployment is affected, which the copy says
    // outright — a warning about a spam layer reads as a threat to the queue otherwise.
    showing({ state: 'no-binding', hamCount: 6, spamCount: 40 })

    const text = (await section()).textContent ?? ''
    expect(text).toContain('no Workers AI binding')
    expect(text).toContain('Bindings')
    expect(text).toContain('Off')
  })

  it('says the stored decisions survive a missing binding rather than reading as lost', async () => {
    showing({ state: 'no-binding', hamCount: 6, spamCount: 40 })

    expect((await section()).textContent).toContain('still stored')
  })

  it('does not claim a training history a deployment with no binding never had', async () => {
    showing({ state: 'no-binding', hamCount: 0, spamCount: 0, updatedAt: null })

    expect((await section()).textContent).not.toContain('still stored')
  })

  it('says weights from another model are being ignored, and what the next decision costs', async () => {
    // The silent failure: every count reads healthy and the layer abstains on every
    // comment. src/spam/train.ts resets on the next decision, so the honest thing to say
    // is what that reset discards — not "trained" and not "learning".
    showing({ state: 'model-changed', hamCount: 412, spamCount: 380 })

    const text = (await section()).textContent ?? ''
    expect(text).toContain('412')
    expect(text).toContain('not carried over')
    expect(text).toContain('Off')
  })

  it('shows no score, accuracy or percentage in any state', async () => {
    // #175 has not calibrated a threshold, so there is no number anybody could honestly
    // read as "how good is it" — and a percentage on a dashboard is believed. The
    // assertion is on every state at once, because the tempting place to add one is
    // whichever state a later reader thinks looks thin.
    for (const state of ['no-binding', 'learning', 'trained', 'model-changed'] as const) {
      cleanup()
      showing({ state, hamCount: 41, spamCount: 38, updatedAt: 1_800_000_000 })

      const text = (await section()).textContent ?? ''
      expect(text, state).not.toMatch(/%|accuracy|confidence|precision|recall/i)
    }
  })

  it('refuses a report with no classifier verdict rather than inventing one', async () => {
    // `undefined` would render as *no binding* or as zeroes — either one is a confident
    // answer nobody sent, on the screen an owner opened to find out. The same rule
    // `shortPassword` follows (#120).
    const { secrets, shortPassword } = report()
    answering(() => json(200, { secrets, shortPassword }))
    mount()

    await screen.findByText('Could not read what is configured')
    expect(screen.queryByText('Spam classifier')).toBeNull()
  })

  it('refuses a state this dashboard does not know, rather than rendering nothing', async () => {
    // The drift `SETUP_SECRETS` warns about, in its second form: the union is written out
    // in src/dashboard/api.ts because that project cannot import from src/spam. A Worker
    // that grew a fifth state would otherwise render as a section with no words in it.
    answering(() =>
      json(200, { ...report(), classifier: { ...classifier(), state: 'quantum-superposition' } }),
    )
    mount()

    await screen.findByText('Could not read what is configured')
    expect(screen.queryByText('Spam classifier')).toBeNull()
  })

  it('counts agree with their nouns, including at one', async () => {
    // A deployment is in `model-changed` from its *first* decision — src/spam/train.ts
    // writes the row then — so one is an ordinary number in this copy rather than an edge
    // case, and "The 1 approvals" is what shipped before a cold read of the diff.
    showing({ state: 'model-changed', hamCount: 1, spamCount: 1 })

    const text = (await section()).textContent ?? ''
    expect(text).toContain('1 approval and 1 spam decision')
    expect(text).not.toContain('1 approvals')
  })

  it('says one more approval, not one more approvals, on the last decision before it starts', async () => {
    showing({ state: 'learning', hamCount: 29, spamCount: 40 })

    const text = (await section()).textContent ?? ''
    expect(text).toContain('1 more approval')
    expect(text).not.toContain('1 more approvals')
  })

  it('refuses an unusable timestamp rather than crashing the tab on it', async () => {
    // `new Date(1e300).toISOString()` throws a RangeError, and this dashboard has no error
    // boundary — so an unchecked value here unmounts the whole tree on the one screen an
    // owner opened to find out what was wrong.
    answering(() => json(200, { ...report(), classifier: { ...classifier(), updatedAt: 1e300 } }))
    mount()

    await screen.findByText('Could not read what is configured')
    expect(screen.queryByText('Spam classifier')).toBeNull()
  })

  it('refuses counts that are not numbers, rather than printing them', async () => {
    answering(() =>
      json(200, { ...report(), classifier: { ...classifier(), hamCount: '6 or so' } }),
    )
    mount()

    await screen.findByText('Could not read what is configured')
    expect(panelText()).not.toContain('6 or so')
  })
})

describe('email notifications, which are a key and two addresses or nothing (#207)', () => {
  it('reports a half-configured deployment as off, whichever half is missing', async () => {
    // The key set and no recipient. It is still all-or-nothing, and the badge has to say
    // off — a deployment that reads as on and sends nothing is #107 on this screen.
    answering(
      () => json(200, report({ RESEND_API_KEY: true })),
      () => json(200, settingsBody({ notifyFrom: 'comments@maya.build' })),
    )
    mount()

    await screen.findByText('Email notifications')
    expect(panelText()).toContain('Partly set up, so nothing is sent')
    // The key is set, so no command block for it, and the addresses are fields rather
    // than status rows.
    expect(panelText()).not.toContain('wrangler secret put RESEND_API_KEY')
    expect(screen.getByLabelText('Send notifications to')).toBeTruthy()
  })

  it('reports the missing key as off even when both addresses are saved', async () => {
    answering(
      () => json(200, report()),
      () =>
        json(200, settingsBody({ notifyFrom: 'comments@maya.build', notifyTo: 'maya@maya.build' })),
    )
    mount()

    await screen.findByText('Email notifications')
    expect(panelText()).toContain('Partly set up, so nothing is sent')
    const commands = [...document.querySelectorAll('pre')].map((block) => block.textContent ?? '')
    expect(commands).toContain('pnpm wrangler secret put RESEND_API_KEY')
  })

  it('puts the saved addresses in the fields, so an owner can see what is stored', async () => {
    answering(
      () => json(200, report({ RESEND_API_KEY: true })),
      () =>
        json(
          200,
          settingsBody({
            notifyFrom: 'comments@maya.build',
            notifyTo: 'maya@maya.build',
            notifyFromName: 'maya.build comments',
          }),
        ),
    )
    mount()

    await screen.findByText('Email notifications')
    expect(fieldValue('Send notifications to')).toBe('maya@maya.build')
    expect(fieldValue('Send them from')).toBe('comments@maya.build')
    expect(fieldValue('Sender name (optional)')).toBe('maya.build comments')
  })

  it('sends the three settings when the form is saved, and shows the server’s answer back', async () => {
    let saved: unknown = null
    const stub = stubFetch((call) => {
      if (call.path === '/admin/api/setup') return json(200, report({ RESEND_API_KEY: true }))
      if (call.method === 'GET') return json(200, settingsBody())
      saved = call.body
      // Trimmed by the server, which is what the field must show afterwards rather than
      // what was typed.
      return json(
        200,
        settingsBody({
          notifyFrom: 'comments@maya.build',
          notifyTo: 'maya@maya.build',
          notifyFromName: 'Charcha',
        }),
      )
    })
    mount()

    await screen.findByText('Email notifications')
    fireEvent.change(screen.getByLabelText('Send notifications to'), {
      target: { value: 'maya@maya.build' },
    })
    fireEvent.change(screen.getByLabelText('Send them from'), {
      target: { value: 'comments@maya.build' },
    })
    // Untrimmed on purpose, and on the one field that keeps what is typed: an `input`
    // of type `email` or `url` strips surrounding whitespace itself, so only this field
    // can show that the *server's* answer is what the form ends up displaying.
    fireEvent.change(screen.getByLabelText('Sender name (optional)'), {
      target: { value: '  Charcha  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save notification settings' }))

    await waitFor(() => {
      expect(saved).toEqual({
        notifyFrom: 'comments@maya.build',
        notifyTo: 'maya@maya.build',
        notifyFromName: '  Charcha  ',
      })
    })
    await waitFor(() => {
      expect(fieldValue('Sender name (optional)')).toBe('Charcha')
    })
    expect(stub.paths()).toContain('/admin/api/settings')
  })

  it('shows the server’s refusal verbatim rather than restating the rules (#208)', async () => {
    // The sender name is the one field on this tab whose value reaches a mail header, and
    // the Worker names the character it refused (src/admin/settings.ts). A second copy of
    // those rules here is two lists that can disagree on the field where being wrong
    // writes a From: line.
    stubFetch((call) => {
      if (call.path === '/admin/api/setup') return json(200, report({ RESEND_API_KEY: true }))
      if (call.method === 'GET') return json(200, settingsBody())
      return apiError(400, 'BAD_REQUEST', 'A sender name cannot contain “<”.')
    })
    mount()

    await screen.findByText('Email notifications')
    fireEvent.change(screen.getByLabelText('Sender name (optional)'), {
      target: { value: 'Charcha <security@bank.example>' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save notification settings' }))

    expect(await screen.findByText(/A sender name cannot contain/)).toBeTruthy()
    expect(panelText()).toContain('Nothing on this deployment has been changed')
  })

  it('says the from-address needs a verified domain, and that failure is silence', async () => {
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Email notifications')
    expect(panelText()).toContain('verified with your email provider')
    expect(panelText()).toContain('looks exactly like the feature being switched off')
  })

  it('does not clear the fallback when the owner saves without touching the addresses', async () => {
    // **The failure this whole migration exists to prevent, arriving through the screen
    // that announces the migration.** On the fallback the address boxes are empty because
    // this surface refuses to render a secret's value — not because the owner emptied
    // them. An owner who types only a sender name and saves must not thereby write two
    // empty rows, kill the fallback and stop their own notifications, with "Saved." on
    // screen. Found in review.
    let saved: unknown = null
    stubFetch((call) => {
      if (call.path === '/admin/api/setup') return json(200, report({ RESEND_API_KEY: true }))
      if (call.method === 'GET') {
        return json(200, settingsBody({ fromDeprecatedSecrets: ['notify_from', 'notify_to'] }))
      }
      saved = call.body
      return json(200, settingsBody({ fromDeprecatedSecrets: ['notify_from', 'notify_to'] }))
    })
    mount()

    await screen.findByText('Email notifications')
    fireEvent.change(screen.getByLabelText('Sender name (optional)'), {
      target: { value: 'Charcha' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save notification settings' }))

    await waitFor(() => {
      expect(saved).not.toBeNull()
    })
    // The name, and only the name. An absent field leaves its row alone; an empty one
    // would clear it.
    expect(saved).toEqual({ notifyFromName: 'Charcha' })
  })

  it('still lets the owner clear an address they have actually saved', async () => {
    // The other half, and what stops the guard above from becoming "this field can never
    // be emptied". Once a row exists the key leaves `fromDeprecatedSecrets`, so an empty
    // box is an instruction again.
    let saved: unknown = null
    stubFetch((call) => {
      if (call.path === '/admin/api/setup') return json(200, report({ RESEND_API_KEY: true }))
      if (call.method === 'GET') {
        return json(200, settingsBody({ notifyTo: 'maya@maya.build', notifyFrom: 'c@maya.build' }))
      }
      saved = call.body
      return json(200, settingsBody({ notifyFrom: 'c@maya.build' }))
    })
    mount()

    await screen.findByText('Email notifications')
    fireEvent.change(screen.getByLabelText('Send notifications to'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save notification settings' }))

    await waitFor(() => {
      expect(saved).toEqual({ notifyFrom: 'c@maya.build', notifyTo: '', notifyFromName: '' })
    })
  })

  it('says where the value is coming from when a deprecated secret is still serving it', async () => {
    // The #207 migration, on screen. The value is not rendered — #158's rule is that this
    // surface shows no secret's value — so the field is empty and the alert is what stops
    // that reading as "your notifications are unconfigured".
    answering(
      () => json(200, report({ RESEND_API_KEY: true })),
      () => json(200, settingsBody({ fromDeprecatedSecrets: ['notify_from', 'notify_to'] })),
    )
    mount()

    await screen.findByText('Email notifications')
    expect(panelText()).toContain('still coming from secrets you set with wrangler')
    expect(fieldValue('Send notifications to')).toBe('')
    // And it is reported as on, because it genuinely is.
    expect(panelText()).not.toContain('Partly set up')
  })
})

describe('your site’s address, which used to be a secret (#207)', () => {
  it('puts the saved value in a field rather than a wrangler command', async () => {
    answering(
      () => json(200, report()),
      () => json(200, settingsBody({ siteUrl: 'https://maya.build' })),
    )
    mount()

    await screen.findByText('Your site’s address')
    expect(fieldValue('Home page address')).toBe('https://maya.build')
    expect(panelText()).not.toContain('wrangler secret put CHARCHA_SITE_URL')
  })

  it('sends only the site address, so a save here cannot undo anything else', async () => {
    let saved: unknown = null
    stubFetch((call) => {
      if (call.path === '/admin/api/setup') return json(200, report())
      if (call.method === 'GET') return json(200, settingsBody())
      saved = call.body
      return json(200, settingsBody({ siteUrl: 'https://maya.build' }))
    })
    mount()

    await screen.findByText('Your site’s address')
    fireEvent.change(screen.getByLabelText('Home page address'), {
      target: { value: 'https://maya.build/' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save site address' }))

    await waitFor(() => {
      expect(saved).toEqual({ siteUrl: 'https://maya.build/' })
    })
    // The canonical form the server stored, not the spelling that was typed — the same
    // feedback the allowlist gives.
    await waitFor(() => {
      expect(fieldValue('Home page address')).toBe('https://maya.build')
    })
  })

  it('does not clear the fallback when the owner saves without typing an address', async () => {
    // The site-address half of the same failure: an empty box that is empty because
    // `CHARCHA_SITE_URL` is supplying the value is not an instruction to clear it, and
    // clearing it would switch layer 8 off on a deployment that was paying for it.
    let saved: unknown = null
    stubFetch((call) => {
      if (call.path === '/admin/api/setup') return json(200, report())
      if (call.method === 'GET') {
        return json(200, settingsBody({ fromDeprecatedSecrets: ['site_url'] }))
      }
      saved = call.body
      return json(200, settingsBody())
    })
    mount()

    await screen.findByText('Your site’s address')
    fireEvent.click(screen.getByRole('button', { name: 'Save site address' }))

    // Nothing was sent at all — there is no field to save and nothing to clear.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save site address' })).toBeTruthy()
    })
    expect(saved).toBeNull()
  })

  it('has no On or Off badge, because empty is a working default', async () => {
    answering(() => json(200, report()))
    mount()

    const heading = await screen.findByText('Your site’s address')
    const section = heading.closest('section')
    expect(section?.textContent).not.toContain('Off')
    expect(section?.textContent).not.toContain('On ')
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
      'Moderation policy',
      'Turnstile bot check',
      'Email notifications',
      'Per-commenter rate limiting',
      'Spam classifier',
      'Third-party spam service',
      'Your site’s address',
      'Allowed origins',
    ])
  })

  it('says what it is short *of*, and that it is a length test and only that', async () => {
    answering(() => json(200, report({}, true)))
    mount()

    await screen.findByText('Dashboard password')
    expect(panelText()).toContain('shorter than the 15 characters')
    // And who says so, cited in the place the claim is made. The argument that a length
    // check is only a length check moved to charcha.dev with #216; the number's source
    // did not, because a floor asserted without one invites "says who".
    expect(screen.getByRole('link', { name: /NIST states/ }).getAttribute('href')).toBe(
      'https://pages.nist.gov/800-63-4/sp800-63b.html',
    )
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
    expect(panelText()).toContain('Nothing has stopped working and nothing will')
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
    expect(section?.textContent).toContain('Replace it from the Cloudflare dashboard')
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
    expect(panelText()).toContain('sign out every open session, including this one')
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
    expect(screen.getAllByText('Off')).toHaveLength(4)
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

  it('comes first of the optional four, because it is the one being recommended', async () => {
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Email notifications')
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([
      'Moderation policy',
      'Turnstile bot check',
      'Email notifications',
      'Per-commenter rate limiting',
      'Spam classifier',
      'Third-party spam service',
      'Your site’s address',
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
    expect(text).toContain('a secret key with no sitekey holds every comment for review')
    expect(text).toContain('a sitekey with no secret key is the harmless direction')
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
    expect(panelText()).toContain('holds every comment for review')
  })

  it('says it in the unconfigured state too, so neither half is a surprise later', async () => {
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Turnstile bot check')
    expect(panelText()).toContain('data-turnstile-sitekey')
    expect(panelText()).toContain('set both or neither')
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
      () =>
        json(
          200,
          settingsBody({ allowedOrigins: ['https://maya.build'], selfOrigin: 'https://c.example' }),
        ),
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
      () => json(200, settingsBody({ allowedOrigins: stored, selfOrigin: 'https://c.example' })),
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

  it('offers a control for every setting and none for any secret', async () => {
    // **The line #158 drew, restated now that four settings are editable here.** A Worker
    // cannot write its own secrets, so a Save button beside one would be a dead control —
    // and every button on this panel has to belong to something that genuinely lives in
    // the database. `Off` sections for `TURNSTILE_SECRET_KEY`, `IP_HASH_SECRET`,
    // `AKISMET_API_KEY` and `RESEND_API_KEY` are all rendered by this fixture, so a
    // button that had crept onto one of them would be in this list.
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Email notifications')
    const buttons = screen.getAllByRole('button').map((button) => button.textContent)
    expect(buttons).toEqual([
      'Save notification settings',
      'Save site address',
      'Edit allowed origins',
    ])
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
    // Both reads fail offline, and every section that depended on one says so rather
    // than any of them silently rendering as an answer — an empty address field on a
    // failed read reads as *not configured*, which is indistinguishable from the truth,
    // the same argument #173 made for the policy control not rendering `hold-all` as
    // Four rather than three: the site address is a settings section of its own now
    // (#207). The notification form is not a fifth, because it lives inside the Email
    // section, which the *setup* read gates — on a total outage that section is absent
    // rather than showing a failure alert of its own.
    expect(screen.getAllByText(/Check your connection/)).toHaveLength(4)
    expect(screen.getByText('Could not read the allowed origins')).toBeTruthy()
    expect(screen.getByText('Could not read the moderation policy')).toBeTruthy()
    expect(screen.getByText('Could not read your site’s address')).toBeTruthy()
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

// The moderation policy (#173). It is the one control on this tab that changes what
// readers see, so what is asserted here is the copy as much as the wiring: an owner who
// misreads "someone you approved before" as meaning an email address would be wrong
// about what they just switched on.
describe('the moderation policy', () => {
  /** Answers the settings read with a policy, and the write with whatever it is given. */
  function policyResponder(policy: string, write?: () => Response): Responder {
    return (call) => {
      if (call.path === '/admin/api/setup') return json(200, report())
      if (call.path === '/admin/api/settings' && call.method === 'GET') {
        return json(200, { ...NO_ORIGINS, moderationPolicy: policy })
      }
      if (call.path === '/admin/api/settings' && call.method === 'PUT') {
        return write === undefined ? unhandled(call) : write()
      }
      return unhandled(call)
    }
  }

  function policySection(): HTMLElement {
    const heading = screen.getByText('Moderation policy')
    const section = heading.closest('section')
    if (section === null) throw new Error('the policy heading is not inside a section')
    return section
  }

  function option(name: RegExp): HTMLElement {
    return screen.getByRole('radio', { name })
  }

  /**
   * The moderation section's own status line.
   *
   * Scoped since #207: the notification form and the site-address form each have one too,
   * so an unscoped `getByRole('status')` finds three and throws.
   */
  function policyStatus(): string {
    const section = screen.getByText('Moderation policy').closest('section')
    if (section === null) throw new Error('the Moderation policy heading is not inside a section')
    const status = section.querySelector('[role="status"]')
    return status?.textContent ?? ''
  }

  it('shows the policy this deployment is on, not a guess', async () => {
    stubFetch(policyResponder('trust-returning'))
    mount()

    await screen.findByText('Moderation policy')
    expect(option(/hold every comment/i).getAttribute('aria-checked')).toBe('false')
    expect(option(/trust a commenter/i).getAttribute('aria-checked')).toBe('true')
  })

  it('offers exactly the three policies that exist', async () => {
    // Still no "publish anything the layers allowed": #173 proposes `trust-clean` and it
    // is deliberately not shipped. The third radio is `trust-vouched` (#189), which acts
    // only on a provider's positive verdict — a fourth would be a decision nobody took.
    stubFetch(policyResponder('hold-all'))
    mount()

    await screen.findByText('Moderation policy')
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(policySection().textContent).not.toContain('trust-clean')
  })

  it('saves the choice, sending the policy and nothing else', async () => {
    // Only this field, because the endpoint leaves an absent one alone: a body carrying
    // the allowlist too would let this screen undo an edit made in the dialog.
    const stub = stubFetch(
      policyResponder('hold-all', () =>
        json(200, { ...NO_ORIGINS, moderationPolicy: 'trust-returning' }),
      ),
    )
    mount()

    await screen.findByText('Moderation policy')
    fireEvent.click(option(/trust a commenter/i))

    await waitFor(() => {
      expect(option(/trust a commenter/i).getAttribute('aria-checked')).toBe('true')
    })
    const put = stub.calls.find((call) => call.method === 'PUT')
    expect(put?.body).toEqual({ moderationPolicy: 'trust-returning' })
  })

  it('shows what the server saved, not what was clicked', async () => {
    // The screen has to agree with the deployment. A control that showed the click
    // would report a policy the Worker is not applying.
    stubFetch(
      policyResponder('hold-all', () => json(200, { ...NO_ORIGINS, moderationPolicy: 'hold-all' })),
    )
    mount()

    await screen.findByText('Moderation policy')
    fireEvent.click(option(/trust a commenter/i))

    await waitFor(() => {
      // Scoped: the notification and site-address forms each have a status line of their
      // own now, so an unscoped `getByRole('status')` finds three. The sentence is
      // `useSettingsSave`'s since #216 — this control stopped carrying a second copy of
      // the save machinery, and with it a second way to word the same outcome.
      expect(policyStatus()).toContain('Saved')
    })
    expect(option(/hold every comment/i).getAttribute('aria-checked')).toBe('true')
  })

  it('reports a refused save rather than leaving the radio where it was clicked', async () => {
    stubFetch(
      policyResponder('hold-all', () =>
        apiError(400, 'BAD_REQUEST', '“trust-clean” is not a moderation policy.'),
      ),
    )
    mount()

    await screen.findByText('Moderation policy')
    fireEvent.click(option(/trust a commenter/i))

    expect(await screen.findByText('Not saved')).toBeTruthy()
    expect(screen.getByText(/is not a moderation policy/)).toBeTruthy()
    expect(option(/hold every comment/i).getAttribute('aria-checked')).toBe('true')
  })

  it('reports a rejected fetch rather than a control that silently did nothing', async () => {
    stubFetch((call) => {
      if (call.method === 'PUT') throw new TypeError('Failed to fetch')
      return policyResponder('hold-all')(call)
    })
    mount()

    await screen.findByText('Moderation policy')
    fireEvent.click(option(/trust a commenter/i))

    expect(await screen.findByText('Not saved')).toBeTruthy()
  })

  it('ends the session on a 401 rather than showing a save failure', async () => {
    const onExpired = vi.fn()
    stubFetch(
      policyResponder('hold-all', () =>
        apiError(401, 'UNAUTHORIZED', 'Sign in to use the dashboard.'),
      ),
    )
    mount({ onExpired })

    await screen.findByText('Moderation policy')
    fireEvent.click(option(/trust a commenter/i))

    await waitFor(() => {
      expect(onExpired).toHaveBeenCalled()
    })
  })

  it('says the identity is not an email address, on the option it is true of', async () => {
    // The crux of #173, and since #216 it is in the description of the radio it describes
    // rather than in a paragraph under the group — which is a paragraph a reader who has
    // already clicked never reaches. "Someone you approved before" reads as an email
    // address, and an email address on a Charcha comment is optional and unverified, so
    // the copy has to say that the network has to match too.
    stubFetch(policyResponder('hold-all'))
    mount()

    await screen.findByText('Moderation policy')
    const description = screen.getByRole('radio', { name: /trust a commenter/i }).closest('div')
      ?.parentElement?.textContent
    expect(description).toContain('is not an email address')
    expect(description).toContain('Nobody verifies an email on a comment')
    expect(description).toContain('the network they are commenting from both match')
  })

  it('says what trust does not cover, in the place it is switched on', async () => {
    stubFetch(policyResponder('hold-all'))
    mount()

    await screen.findByText('Moderation policy')
    const text = policySection().textContent ?? ''
    // A flagged comment is still held; marking a trusted person spam revokes it; and the
    // hash retention window makes trust fade. None of the three is discoverable from a
    // radio button, and each is a question an owner has within a day of choosing this.
    expect(text).toContain('object to is held for you whatever is chosen here')
    expect(text).toContain('marking a trusted person’s comment as spam takes it away')
    expect(text).toContain('Trust fades')
  })

  it('warns that nobody can be recognised without IP_HASH_SECRET', async () => {
    // The #107 case for this feature: with no secret there is no address hash, so half
    // the identity does not exist and the policy is a switch that does nothing.
    stubFetch((call) => {
      if (call.path === '/admin/api/setup') return json(200, report({ IP_HASH_SECRET: false }))
      return policyResponder('hold-all')(call)
    })
    mount()

    await screen.findByText('Nobody can be recognised on this deployment yet')
    expect(policySection().textContent).toContain('will do nothing')
  })

  it('drops that warning once the secret is set', async () => {
    stubFetch((call) => {
      if (call.path === '/admin/api/setup') return json(200, report({ IP_HASH_SECRET: true }))
      return policyResponder('hold-all')(call)
    })
    mount()

    await screen.findByText('Moderation policy')
    await waitFor(() => {
      expect(screen.queryByText('Nobody can be recognised on this deployment yet')).toBeNull()
    })
  })
})
