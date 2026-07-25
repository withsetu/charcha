// Shared scaffolding for the dashboard's component tests.
//
// `fetch` is stubbed rather than the API client being mocked, deliberately: the client
// is where the same-origin request, the credentials mode and the error-shape reading
// live, so a test that replaced it would prove the components work against a contract
// nothing checks. Stubbing the network keeps the real client in every path.

import { cleanup, configure } from '@testing-library/react'
import { afterEach, expect, vi } from 'vitest'

import type { QueuedComment } from '../../src/dashboard/api'

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
    spamReason: null,
    ...overrides,
  }
}

export function queuePage(comments: QueuedComment[], nextCursor: string | null = null) {
  return { comments, nextCursor }
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
