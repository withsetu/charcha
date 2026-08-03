// Shared scaffolding for the dashboard's component tests.
//
// `fetch` is stubbed rather than the API client being mocked, deliberately: the client
// is where the same-origin request, the credentials mode and the error-shape reading
// live, so a test that replaced it would prove the components work against a contract
// nothing checks. Stubbing the network keeps the real client in every path.

import { cleanup, configure } from '@testing-library/react'
import { afterEach, expect, vi } from 'vitest'

import type { ClassifierStatus, QueueCounts, QueuedComment } from '../../src/dashboard/api'
import { SETUP_SECRETS } from '../../src/dashboard/api'

// Testing Library's default `findBy`/`waitFor` budget is one second, which is plenty on
// its own and not plenty when this project's whole suite runs — 66 files across five
// vitest projects, one of which boots workerd. A keyboard test failed exactly once that
// way: the assertion was correct and the machine was busy. A flaky security suite is
// worse than a smaller one, because the next failure is assumed to be the flake.
configure({ asyncUtilTimeout: 5_000 })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

export interface RecordedCall {
  method: string
  path: string
  body: unknown
}

export interface FetchStub {
  calls: RecordedCall[]
  /** Every path requested so far, for a quick assertion on order. */
  paths: () => string[]
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>

/** A JSON answer in the shape src/admin/api.ts produces. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** The `{error:{code,message}}` shape, so tests use the same one the server does. */
export function apiError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } })
}

/**
 * The URL a `fetch` call was made with, without stringifying an object.
 *
 * The client only ever passes a string, so this is really a type-safe way of saying so
 * — `String(request)` on a `Request` would silently record `[object Object]`, and a
 * path assertion would then pass or fail for a reason nothing on screen explains.
 */
function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

export function stubFetch(responder: Responder): FetchStub {
  const calls: RecordedCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
      const call: RecordedCall = {
        method: init.method ?? 'GET',
        path: requestPath(input),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      }
      calls.push(call)
      return Promise.resolve(responder(call))
    }),
  )
  return { calls, paths: () => calls.map((call) => call.path) }
}

/**
 * A responder that answers the session call as signed in and the queue with `page`,
 * and refuses anything else loudly.
 *
 * Loudly, because a component quietly fetching something no test accounted for is
 * exactly the drift a stub is supposed to catch.
 */
export function signedIn(handle: Responder): Responder {
  return (call) => {
    if (call.path === '/admin/api/session' && call.method === 'GET') {
      return json(200, { authenticated: true, via: 'session' })
    }
    return handle(call)
  }
}

export function unhandled(call: RecordedCall): never {
  throw new Error(`no stub for ${call.method} ${call.path}`)
}

let nextId = 1

export function comment(overrides: Partial<QueuedComment> = {}): QueuedComment {
  const id = overrides.id ?? nextId++
  return {
    id,
    threadId: 1,
    parentId: null,
    depth: 0,
    authorName: `Author ${String(id)}`,
    body: `Comment body ${String(id)}`,
    byOwner: false,
    status: 'pending',
    createdAt: 1_700_000_000 - id,
    moderatedAt: null,
    pageKey: '/posts/hello',
    pageTitle: 'Hello world',
    // The commonest deployment: `site_url` is unset, so the Worker can build no link and
    // the card degrades to the page's name (#203). Tests that want the link say so.
    permalink: null,
    spamReason: null,
    ...overrides,
  }
}

/**
 * A queue page, with counts that agree with it unless a test says otherwise (#135).
 *
 * The default is `pending: comments.length` because a page with no cursor *is* the whole
 * queue, so the honest total is what is on it — which keeps every test that is not about
 * counts free of numbers it does not care about. A page that hands back a cursor gets one
 * more than it holds, which is the least it can honestly claim; a test that cares how
 * many more says so.
 */
export function queuePage(
  comments: QueuedComment[],
  nextCursor: string | null = null,
  counts: QueueCounts = {
    pending: comments.length + (nextCursor === null ? 0 : 1),
    spam: 0,
    approved: 0,
  },
) {
  return { comments, nextCursor, counts }
}

/**
 * The decision endpoint's answer, which carries the counts as they are afterwards.
 *
 * Defaulted to zeroes: most tests are about the row leaving the list rather than about
 * the badge, and a decision that clears the only comment does leave the queue empty.
 */
export function decision(
  id: number,
  status: string,
  counts: QueueCounts = { pending: 0, spam: 0, approved: 0 },
  cascaded = 0,
) {
  return { id, status, moderatedAt: 1, counts, cascaded }
}

/** The rows currently on screen, by their accessible name's author. */
export function rowNames(): string[] {
  return [...document.querySelectorAll('[role="group"]')].map(
    (row) => row.getAttribute('aria-label') ?? '',
  )
}

/** The row the keyboard is on, which is also the focused element. */
export function currentRow(): Element | null {
  return document.querySelector('[role="group"][aria-current="true"]')
}

export function expectFocusIsCurrentRow(): void {
  expect(document.activeElement).toBe(currentRow())
}

/**
 * A `GET /admin/api/settings` body with every field the client validates (#207).
 *
 * One helper rather than a literal per test file, because `settingsRequest` in
 * src/dashboard/api.ts refuses a body missing any of them — which is the point of that
 * check, and would otherwise mean every settings fixture in this directory has to be
 * remembered separately the next time a setting is added.
 */
export function settingsBody(overrides: Record<string, unknown> = {}) {
  return {
    allowedOrigins: [],
    selfOrigin: 'https://comments.example.com',
    moderationPolicy: 'hold-all',
    siteUrl: '',
    notifyFrom: '',
    notifyTo: '',
    notifyFromName: '',
    fromDeprecatedSecrets: [],
    ...overrides,
  }
}

/**
 * A `GET /admin/api/setup` body with every field the client validates (#158, #120, #177).
 *
 * **The same helper `settingsBody` is, and it exists because the warning written beside
 * the literals it replaces came true.** Three files stubbed this endpoint by hand, each
 * carrying a note that a hand-written literal "turns a future secret into six timeouts
 * rather than one clear failure" — and #177's `classifier` field did exactly that: the
 * panel mounts inside `Triage`, `readSetup` refuses a report missing a field it expects,
 * and the tabs those files drive then never render.
 *
 * `classifier` defaults to a freshly deployed site: the binding is there, because a
 * one-click deploy provisions Workers AI, and nothing has trained it yet.
 */
export function setupBody(overrides: Record<string, unknown> = {}) {
  return {
    secrets: Object.fromEntries(SETUP_SECRETS.map((name) => [name, false])),
    shortPassword: false,
    classifier: classifierBody(),
    ...overrides,
  }
}

/**
 * The classifier half of that body, typed, so a field the Worker adds is a type error
 * here rather than a `MALFORMED` nobody expected.
 *
 * The default is a freshly deployed site: the binding is there and nothing has trained it
 * yet. *Learning* is deliberately neither On nor Off, which is what keeps every
 * `getAllByText('Off')` count in this directory meaning what it did before #177.
 */
export function classifierBody(overrides: Partial<ClassifierStatus> = {}): ClassifierStatus {
  return {
    state: 'learning',
    hamCount: 0,
    spamCount: 0,
    minPerClass: 30,
    updatedAt: null,
    ...overrides,
  }
}

/** Every secret reported as set, for the tests about a finished deployment. */
export function allSecretsSet(): Record<string, boolean> {
  return Object.fromEntries(SETUP_SECRETS.map((name) => [name, true]))
}
