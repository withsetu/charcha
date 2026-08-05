// The Setup tab (#158): what it says when nothing is configured, what it says when
// everything is, and the two things it must never do — render a value, or report a
// failed read as a feature being off.
//
// The panel is rendered directly here rather than through `Triage`, because what is
// being asserted is its copy and its states. The wiring — the fourth tab, the `4`
// shortcut, and the queue keys being inert while it is in front — is
// test/dashboard/shortcuts.test.tsx and test/dashboard/triage.test.tsx.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
/** One section's own live region, since the tab has three and they must differ. */
function statusIn(sectionTitle: string): string {
  const heading = screen
    .getAllByRole('heading', { level: 2 })
    .find((candidate) => candidate.textContent === sectionTitle)
  const status = heading?.closest('section')?.querySelector('[role="status"]')
  return status?.textContent ?? '(no status region)'
}

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
  /**
   * The worst case for length: nothing configured, so every section is at full size.
   *
   * Set at what the tab actually renders rather than at a round number with slack in it,
   * because slack is what the last cut left and what grew back into it.
   */
  const BUDGET_UNCONFIGURED: Record<string, number> = {
    'No comments are being accepted': 1,
    'Dashboard password': 2,
    'Moderation policy': 5,
    'Turnstile bot check': 3,
    'Email notifications': 5,
    'Per-commenter rate limiting': 2,
    'Spam classifier': 1,
    'Third-party spam service': 2,
    'Your site’s address': 2,
    'Allowed origins': 1,
  }

  /** And the case #158 cares about: a finished deployment finds almost nothing here. */
  const BUDGET_CONFIGURED: Record<string, number> = {
    'Moderation policy': 4,
    'Turnstile bot check': 2,
    'Email notifications': 4,
    'Per-commenter rate limiting': 1,
    'Spam classifier': 1,
    'Third-party spam service': 1,
    'Your site’s address': 2,
    'Allowed origins': 1,
  }

  /**
   * And the whole tab, which buys exactly one thing the ceilings above do not.
   *
   * **It is not a second constraint on the sections that are listed**, and saying it was
   * would be the coverage-shaped assertion this file exists to avoid: the budgets are set
   * at what each section actually renders, so their sum *is* this number and the total
   * cannot fail while they all pass. What it catches is the case the map cannot — a
   * **tenth section**, which `visibleParagraphs` is never called for because the loop
   * above only walks the titles it knows. Without this the tab could grow a whole new
   * section of prose and every assertion here would stay green.
   *
   * The figures include field hints and radio-option descriptions, which are control copy
   * rather than prose: eight of the configured sixteen are those.
   */
  const TOTAL_UNCONFIGURED = 24
  const TOTAL_CONFIGURED = 16

  function totalParagraphs(): number {
    return screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => visibleParagraphs(heading.textContent ?? ''))
      .reduce((sum, n) => sum + n, 0)
  }

  it('keeps every section inside its budget when nothing is configured', async () => {
    answering(() => json(200, report({}, true)))
    mount()

    await screen.findByText('Dashboard password')
    for (const [title, budget] of Object.entries(BUDGET_UNCONFIGURED)) {
      expect(visibleParagraphs(title), title).toBeLessThanOrEqual(budget)
    }
    expect(totalParagraphs()).toBeLessThanOrEqual(TOTAL_UNCONFIGURED)
  })

  it('opens on no preamble at all', async () => {
    // It used to explain what the On and Off badges meant and which parts of the screen
    // were editable, which is what the badges and the controls say by being there. The
    // first thing on the tab is now a section.
    answering(() => json(200, report({}, true)))
    mount()

    await screen.findByText('Dashboard password')
    const panel = screen.getByText('Dashboard password').closest('div.space-y-4')
    expect(panel?.firstElementChild?.tagName).toBe('SECTION')
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
    expect(totalParagraphs()).toBeLessThanOrEqual(TOTAL_CONFIGURED)
  })

  it('names the recipient here, and keeps the whole disclosure one click away', async () => {
    // **CLAUDE.md's rule is about the UI that *enables* a provider, and this tab has no
    // toggle on it** — Akismet is switched on by setting a secret, which a Worker cannot
    // do to itself. So the screen an owner decides on is charcha.dev's, and that is where
    // the field list, the recipient and the paragraph they owe their privacy notice live
    // at length. What this tab may not do is compress the disclosure to nothing: the
    // recipient and the two fields nobody expects to be sent stay in the copy, and the
    // link that carries the rest has to be present and has to promise it. The same shape
    // for Turnstile, which is the one feature that puts somebody else's script in a
    // reader's browser (card rule 8).
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Third-party spam service')
    const provider = screen.getByText('Third-party spam service').closest('section')
    // The recipient, and both fields — with the hedge the docs carry, because the email
    // field is optional in Charcha and a disclosure that overstates is still wrong.
    expect(provider?.textContent).toContain('IP address, and their email address if they gave one')
    expect(provider?.textContent).toContain('Automattic')
    // Reachable, and named as the disclosure rather than as the feature.
    const providerLink = within(provider as HTMLElement).getByRole('link', {
      name: /What it would send/,
    })
    expect(providerLink.getAttribute('href')).toBe('https://charcha.dev/spam-providers/')

    const turnstile = screen.getByText('Turnstile bot check').closest('section')
    const browserLink = within(turnstile as HTMLElement).getByRole('link', {
      name: /reader’s browser/,
    })
    expect(browserLink.getAttribute('href')).toBe(
      'https://charcha.dev/spam/#what-it-puts-in-a-readers-browser',
    )
  })

  it('says the same on a deployment that already connected one', async () => {
    // The `On` state is where the owner is composing their own privacy notice, so the
    // link has to name that rather than the feature — and the recipient stays on screen.
    answering(() => json(200, report({ AKISMET_API_KEY: true })))
    mount()

    await screen.findByText('Third-party spam service')
    const provider = screen.getByText('Third-party spam service').closest('section')
    expect(provider?.textContent).toContain('Automattic')
    const link = within(provider as HTMLElement).getByRole('link', {
      name: /the paragraph you owe your readers/,
    })
    expect(link.getAttribute('href')).toBe('https://charcha.dev/spam-providers/')
  })

  it('names the form in every save announcement, not just the one with no button', async () => {
    // **Three live regions on one scrolling tab, and a screen-reader user has to be able to
    // tell which one landed.** `useSettingsSave` takes the name as a required parameter so a
    // fourth caller cannot quietly go back to a bare "Saved." — but a required parameter
    // only forces *a* string, so the two forms the moderation fix did not prompt are the
    // ones asserted here. Their announcements are driven for real rather than read off the
    // source.
    stubFetch((call) => {
      if (call.path === '/admin/api/setup') return json(200, report({ RESEND_API_KEY: true }))
      if (call.method === 'GET') return json(200, settingsBody())
      return json(200, settingsBody({ notifyTo: 'maya@maya.build', siteUrl: 'https://maya.build' }))
    })
    mount()

    await screen.findByText('Email notifications')
    fireEvent.change(screen.getByLabelText('Send notifications to'), {
      target: { value: 'maya@maya.build' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save notification settings' }))
    await waitFor(() => {
      expect(statusIn('Email notifications')).toBe('Notification settings saved.')
    })

    fireEvent.change(screen.getByLabelText('Home page address'), {
      target: { value: 'https://maya.build' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save site address' }))
    await waitFor(() => {
      expect(statusIn('Your site’s address')).toBe('Site address saved.')
    })
    // And the two are distinguishable, which is the property the parameter exists for.
    expect(statusIn('Email notifications')).not.toBe(statusIn('Your site’s address'))
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
      'No comments are being accepted',
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
    // Ahead of the command it is an alternative to. One comparison over the whole panel
    // rather than per block, because `HowToSet` is the only thing that renders either
    // string and it emits them in this order structurally.
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
      // The #224 notice leads whenever no address has been declared, which is what this
      // fixture's settings body says.
      'No comments are being accepted',
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

  it('is quiet once it is trained, and reports the decisions it learned from', async () => {
    showing({
      state: 'trained',
      hamCount: 41,
      spamCount: 38,
      updatedAt: 1_800_000_000,
    })

    const text = (await section()).textContent ?? ''
    expect(text).toContain('41')
    expect(text).toContain('38')
    // And no instructions: a working layer has nothing for its owner to do, which is
    // #158's rule applied to the one section here that has no secret behind it.
    expect(text).not.toContain('wrangler')
  })

  it('is a status line and nothing else once it is working', async () => {
    // **The `On` state is the one that has to stay a line, because it is the state a
    // finished deployment sits in forever.** What it says is the two things only this
    // screen knows: whose decisions trained it, and when training last succeeded. The
    // reason token it marks a held comment with is a fact about the queue rather than
    // about this deployment's configuration, and it is on charcha.dev with the rest of
    // how the layer behaves — unlike Turnstile's, which stays because #104 is a
    // misconfiguration only this screen can surface.
    showing({ state: 'trained', hamCount: 41, spamCount: 38, updatedAt: 1_800_000_000 })

    const text = (await section()).textContent ?? ''
    expect(text).not.toContain('classifier: similar-to-spam')
    expect(visibleParagraphs('Spam classifier')).toBe(1)
    // Still reachable, which is the half a cut is allowed to keep.
    expect(
      within(await section())
        .getByRole('link', { name: /How it learns/ })
        .getAttribute('href'),
    ).toBe('https://charcha.dev/spam/#7-the-classifier')
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

  it('says it while it is still learning too, which is where a stall hides longest', async () => {
    // **The state the date is worth the most in, and the one the #216 rewrite dropped it
    // from before this test existed.** A deployment stuck at 6 of 30 whose training writes
    // are failing shows a count that has stopped and nothing else — and `learning` is the
    // long state, so "quiet site" and "broken trainer" look alike here for months. A test
    // asserting the date only on `trained` instruments the case that needs it least.
    const threeDaysAgo = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60
    showing({ state: 'learning', hamCount: 6, spamCount: 40, updatedAt: threeDaysAgo })

    const text = (await section()).textContent ?? ''
    expect(text).toContain('3 days ago')
    expect(text).toContain('training has stopped')
  })

  it('claims no learning history on a deployment that has none', async () => {
    showing({ state: 'learning', hamCount: 0, spamCount: 0, updatedAt: null })

    expect((await section()).textContent).not.toContain('It last learned something')
  })

  it('says the layer never runs when there is no binding, and how to give it one', async () => {
    // Distinguishable from *cold* by what it asks for: a binding rather than more
    // moderating. Nothing else on the deployment is affected, which the copy says
    // outright — a warning about a spam layer reads as a threat to the queue otherwise.
    showing({ state: 'no-binding', hamCount: 6, spamCount: 40 })

    const text = (await section()).textContent ?? ''
    expect(text).toContain('No Workers AI binding')
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
      // Only the #224 notice outranks it, and only while this deployment is refusing
      // every comment.
      'No comments are being accepted',
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
    expect(panelText()).toContain('Shorter than the 15 characters')
    // And who says so, cited in the place the claim is made. The argument that a length
    // check is only a length check moved to charcha.dev with #216; the number's source
    // did not, because a floor asserted without one invites "says who".
    expect(screen.getByRole('link', { name: /NIST requires/ }).getAttribute('href')).toBe(
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
      // The #224 notice leads whenever no address has been declared, which is what this
      // fixture's settings body says.
      'No comments are being accepted',
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
    expect(section.textContent).toContain('free')
    // Scoped to the layers that judge a comment, and the exception named, because rate
    // limiting is layer 4 and measures volume rather than an absence (src/spam/index.ts),
    // so the claim is scoped to asking for evidence rather than to "every other layer",
    // which would be the sort of overclaim a reader can falsify.
    expect(section.textContent).toContain('the only layer that asks for evidence')
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

  it('names the trap in the state that hides it, which is the configured one', async () => {
    // #104 is a secret key with no sitekey: every comment held, silently, on a deployment
    // whose Setup tab says On. Charcha cannot see the site's pages, so this screen is the
    // only place a reader would find out — and it has to say so in the state that looks
    // finished. One sentence since #216; the two-keys explanation is on charcha.dev.
    answering(() => json(200, report({ TURNSTILE_SECRET_KEY: true })))
    mount()

    const text = (await turnstileSection()).textContent ?? ''
    expect(text).toContain('Charcha cannot see your pages')
    expect(text).toContain('data-turnstile-sitekey')
    expect(text).toContain('every comment is held')
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
    // Including the widget-creation route: the sitekey fact is true of a configured
    // deployment and stays, but "go and add a widget" is an instruction to redo something
    // already done, on the first section a finished tab opens on.
    expect(section.textContent).not.toContain('Add widget')
    expect(section.textContent).not.toContain('Create a widget')
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

  it('offers the browser disclosure above the command, not below it', async () => {
    // The product rule for anything that transmits: what is sent and to whom comes before
    // the control that turns it on. The disclosure itself is on charcha.dev now — this
    // tab has no toggle, so it is not the surface the rule is about — but the *link* to
    // it is the thing a recommendation would otherwise push below the fold.
    answering(() => json(200, report()))
    mount()

    const section = await turnstileSection()
    const text = section.textContent ?? ''
    const link = within(section).getByRole('link', { name: /reader’s browser/ })
    expect(link.getAttribute('href')).toBe(
      'https://charcha.dev/spam/#what-it-puts-in-a-readers-browser',
    )
    expect(text.indexOf('reader’s browser')).toBeLessThan(text.indexOf('wrangler secret put'))
  })

  it('says both keys exist in the unconfigured state too, so neither is a surprise', async () => {
    answering(() => json(200, report()))
    mount()

    await screen.findByText('Turnstile bot check')
    expect(panelText()).toContain('data-turnstile-sitekey')
    expect(panelText()).toContain('Set both or neither')
  })
})

describe('the notice that says no comments are being accepted (#224)', () => {
  /** The heading, which is the state; the alert below it is the action. */
  const HEADING = 'No comments are being accepted'

  it('is the first thing on the tab when no address has been declared', async () => {
    // Above the short-password warning, deliberately: a guessable credential is a risk, and
    // this is a deployment losing every comment right now, invisibly — the queue just stays
    // empty. Position is the only prominence a tab of equal sections has.
    answering(() => json(200, report({}, true)))
    mount()

    await screen.findByText(HEADING)
    const panel = screen.getByText(HEADING).closest('div.space-y-4')
    expect(panel?.firstElementChild?.textContent).toContain(HEADING)
  })

  it('names the one action, and links to what is accepted', async () => {
    answering(() => json(200, report()))
    mount()

    const section = (await screen.findByText(HEADING)).closest('section') as HTMLElement
    expect(section.textContent).toContain('Set your site’s address')
    expect(section.textContent).toContain('every comment is being refused')
    expect(within(section).getByRole('link', { name: /Which addresses are accepted/ })).toBeTruthy()
  })

  it('is the loudest thing on the screen, not one line among ten', async () => {
    // The register the short-password warning uses, one step up: a destructive alert with
    // its own badge. Asserted through the rendered attributes rather than class names, so
    // this survives a restyle but not a demotion to an ordinary paragraph.
    answering(() => json(200, report({}, true)))
    mount()

    const section = (await screen.findByText(HEADING)).closest('section') as HTMLElement
    expect(section.querySelector('[data-slot="alert"]')?.className).toContain('destructive')
    expect(section.querySelector('[data-variant="destructive"]')).toBeTruthy()
  })

  it('disappears completely once the site address is saved (#158 — no nagging)', async () => {
    answering(
      () => json(200, report({}, true)),
      () => json(200, settingsBody({ siteUrl: 'https://maya.build' })),
    )
    mount()

    await screen.findByText('Dashboard password')
    expect(screen.queryByText(HEADING)).toBeNull()
  })

  it('disappears when an origin is listed instead', async () => {
    answering(
      () => json(200, report()),
      () => json(200, settingsBody({ allowedOrigins: ['https://maya.build'] })),
    )
    mount()

    await screen.findByText('Allowed origins')
    expect(screen.queryByText(HEADING)).toBeNull()
  })

  it('does not fire on a deployment still served by the deprecated site-address secret', async () => {
    // The field is empty because the dashboard will not print a secret's value (#207), and
    // that deployment is accepting comments perfectly well. A warning here would be the
    // loudest false alarm on the tab.
    answering(
      () => json(200, report()),
      () => json(200, settingsBody({ siteUrl: '', fromDeprecatedSecrets: ['site_url'] })),
    )
    mount()

    await screen.findByText('Allowed origins')
    expect(screen.queryByText(HEADING)).toBeNull()
  })

  it('does not claim anything while the settings read is still in flight', async () => {
    // An unresolved read is not "nothing is declared". Announcing a total outage from a
    // loading state would be a false alarm on every page load.
    stubFetch((call) => {
      if (call.path === '/admin/api/setup') return json(200, report())
      if (call.path === '/admin/api/settings') return apiError(500, 'UNAVAILABLE', 'No.')
      return unhandled(call)
    })
    mount()

    await screen.findByText('Could not read the allowed origins')
    expect(screen.queryByText(HEADING)).toBeNull()
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
      // own now, so an unscoped `getByRole('status')` finds three. **And the sentence names
      // this form**, which is why `useSettingsSave` takes the name rather than announcing a
      // bare "Saved.": three live regions on one scrolling tab all saying the same word
      // leave a screen-reader user unable to tell which landed, and this is the control
      // with no Save button of its own to anchor it to.
      expect(policyStatus()).toBe('Moderation policy saved.')
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
    expect(description).toContain('the network they comment from both have to match')
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
    expect(text).toContain('Marking their comment as spam takes it away')
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
