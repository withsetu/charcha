// The wiring, driven through the deployed Worker rather than through the pipeline.
//
// test/worker/notify/pipeline-seam.test.ts covers the seam itself, with a notifier
// and a `defer` handed in — and every case in it passed while `POST /comments`
// supplied neither, so the whole feature was inert and fully green (#125). This file
// is the difference: it posts a real comment at the real route and asks whether a
// send was attempted, which is the one question a test with injected dependencies
// cannot ask.
//
// Nothing here reaches Resend. `globalThis.fetch` is stubbed for the whole file, and
// the stub is what the assertions read — a test that let a request out would be
// mailing a third party from CI.
//
// **The isolate's send budget is a real constraint on this file, and it is spent.**
// The production notifier draws on the module-scope bucket in src/notify/index.ts —
// NOTIFY_BURST, five tokens, refilling once every fifteen minutes — and nothing here
// can reset it, which is exactly the property src/notify/throttle.ts is for. Five
// tests below attempt a send, in file order, which is the whole burst. A sixth would
// be rate-limited and would fail while reading as a broken wiring, so a new test that
// needs a send **replaces** one rather than joining them.

import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeSetting } from '../../../src/db'
import { RESEND_SEND_URL } from '../../../src/notify/resend'
import { NOTIFY_TO_SETTING, SITE_URL_SETTING } from '../../../src/settings'
import { ELAPSED_FIELD, HONEYPOT_FIELD } from '../../../src/spam/fields'
import { reportingDefer } from '../../../src/submit/route'
import type { WaitUntilContext } from '../../../src/submit/route'
import { app } from '../../../src/index'

const db = env.DB
const origin = 'https://charcha.example'

/**
 * The three secrets, as `env` actually carries them.
 *
 * `env` is one object shared by every test file in the isolate, so what was there at
 * import is read once and put back — the rule test/worker/admin/env.ts states for the
 * dashboard password, for the same reason.
 */
const mutable = env as unknown as {
  RESEND_API_KEY?: string
  CHARCHA_NOTIFY_FROM?: string
  CHARCHA_NOTIFY_TO?: string
}
const real = {
  RESEND_API_KEY: mutable.RESEND_API_KEY,
  CHARCHA_NOTIFY_FROM: mutable.CHARCHA_NOTIFY_FROM,
  CHARCHA_NOTIFY_TO: mutable.CHARCHA_NOTIFY_TO,
}

/** A key that reaches no network, because `fetch` is stubbed before it is used. */
const FAKE_KEY = 'test-key-that-never-leaves-this-isolate'

function configureNotify(): void {
  mutable.RESEND_API_KEY = FAKE_KEY
  mutable.CHARCHA_NOTIFY_FROM = 'Charcha <comments@maya.build>'
  mutable.CHARCHA_NOTIFY_TO = 'maya@maya.build'
}

function unconfigureNotify(): void {
  delete mutable.RESEND_API_KEY
  delete mutable.CHARCHA_NOTIFY_FROM
  delete mutable.CHARCHA_NOTIFY_TO
}

function restoreNotify(): void {
  for (const [name, value] of Object.entries(real)) {
    if (value === undefined) delete mutable[name as keyof typeof real]
    else mutable[name as keyof typeof real] = value
  }
}

interface Outbound {
  url: string
  body: string
  authorization: string | null
}

/** Records every outbound request and answers each with `respond`. */
function stubFetch(respond: () => Promise<Response>): Outbound[] {
  const calls: Outbound[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      body: typeof init?.body === 'string' ? init.body : '',
      authorization: new Headers(init?.headers).get('authorization'),
    })
    return await respond()
  })
  return calls
}

const accepted = () => Promise.resolve(new Response('{"id":"re_1"}', { status: 200 }))

function comment(fields: Record<string, unknown> = {}) {
  return JSON.stringify({
    authorName: 'Rahul Kanwar',
    body: 'The part people underestimate is the export, and nobody checks it until they leave.',
    url: 'https://maya.build/notes/leaving',
    [HONEYPOT_FIELD]: '',
    [ELAPSED_FIELD]: 31_000,
    ...fields,
  })
}

function post(fields: Record<string, unknown> = {}) {
  return exports.default.fetch(`${origin}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: comment(fields),
  })
}

async function countComments() {
  const row = await db.prepare('select count(*) as n from comments').first<{ n: number }>()
  return row?.n ?? -1
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  // Since #207 the notification addresses are rows, so a row left behind by one test is a
  // configuration the next one did not choose — the same reason the two tables above are
  // cleared rather than trusted to be empty.
  await db.exec('DELETE FROM settings')
  // The address every submission below reports, declared — without it the route refuses
  // them before the notifier is reached at all (#224). One row, and it costs no statement:
  // it is in the same batched settings read the notification addresses come from.
  await writeSetting(db, SITE_URL_SETTING, 'https://maya.build', 1_753_300_000)
})

afterEach(() => {
  restoreNotify()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('POST /comments — the notifier is actually wired to the route', () => {
  it('attempts one send to Resend, carrying the comment, and answers the reader 202', async () => {
    // The test #125 exists for. Every assertion below held with `createNotifier`
    // never called at all, except this one: that a request left for Resend.
    configureNotify()
    const calls = stubFetch(accepted)

    const response = await post()

    expect(response.status).toBe(202)
    expect(await countComments()).toBe(1)
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    expect(calls[0]?.url).toBe(RESEND_SEND_URL)
    expect(calls[0]?.authorization).toBe(`Bearer ${FAKE_KEY}`)
    expect(calls[0]?.body).toContain('The part people underestimate is the export')
  })

  it('costs the reader nothing when Resend never answers', async () => {
    // The reason the seam takes a `defer` rather than an `await`. The stub holds the
    // request open; the reader's POST must be answered anyway, and the comment must
    // already be in the queue.
    configureNotify()
    let release: (response: Response) => void = () => undefined
    const held = new Promise<Response>((resolve) => {
      release = resolve
    })
    const calls = stubFetch(() => held)

    const response = await post()

    expect(response.status).toBe(202)
    expect(await countComments()).toBe(1)
    expect(calls).toHaveLength(1)
    // Released rather than abandoned, so the runtime is not left holding a promise
    // that never settles for the rest of the file.
    release(new Response('{"id":"re_2"}', { status: 200 }))
  })

  it('reports a Resend failure rather than dropping it, and still answers 202', async () => {
    // Inside `waitUntil` a rejection is discarded with no trace, so the failure has
    // to report itself or it never happened. Cloudflare documents the lifetime
    // extension and the 30-second limit, and documents no reporting of a rejected
    // promise: https://developers.cloudflare.com/workers/runtime-apis/context/
    configureNotify()
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    stubFetch(() => Promise.resolve(new Response('nope', { status: 500 })))

    const response = await post()

    expect(response.status).toBe(202)
    expect(await countComments()).toBe(1)
    await vi.waitFor(() => {
      expect(errors.join('\n')).toContain('"event":"notify_send"')
    })
    expect(errors.join('\n')).toContain('http-500')
  })
})

describe('POST /comments — unconfigured means off, not broken', () => {
  it('sends nothing and still takes the comment when the three secrets are absent', async () => {
    // The default on every deployment. No key, no email, no error, and the comment
    // is stored and queued exactly as it would be with notifications switched on.
    unconfigureNotify()
    const calls = stubFetch(accepted)

    const response = await post()

    expect(response.status).toBe(202)
    expect(await countComments()).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it('sends nothing when only two of the three are set', async () => {
    // A half-configured deployment has nowhere to send. It must be as silent as an
    // unconfigured one rather than a broken send path.
    configureNotify()
    delete mutable.CHARCHA_NOTIFY_TO
    const calls = stubFetch(accepted)

    const response = await post()

    expect(response.status).toBe(202)
    expect(calls).toHaveLength(0)
  })
})

describe('POST /comments — the settings rows are what the Worker actually reads (#207)', () => {
  it('stops sending when the owner clears the row, even with the old secret still set', async () => {
    // The migration's sharp edge, driven through the real route. The deprecated secret is
    // read only when the row has never been written — an owner who cleared `notify_to` in
    // the dashboard has asked for no notifications, and restoring the secret they thought
    // they had replaced would keep mailing them after a save they watched succeed.
    //
    // **Placed here, before the burst is spent, and that is not incidental.** This test's
    // evidence is that *nothing* was sent, and once the isolate's five tokens are gone
    // nothing is sent whatever the settings say — the assertion would hold for the wrong
    // reason and the guard could be removed without a red test. Two tokens are still in
    // the bucket at this point, so a fallback that wrongly fired would make a real
    // request and be recorded. Kill-shot confirmed.
    configureNotify()
    await writeSetting(db, NOTIFY_TO_SETTING, '', Math.floor(Date.now() / 1000))
    const calls = stubFetch(accepted)

    const response = await post({
      url: 'https://maya.build/notes/cleared',
      body: 'A comment on a deployment whose owner turned the notifications off.',
    })

    expect(response.status).toBe(202)
    expect(await countComments()).toBe(1)
    expect(calls).toHaveLength(0)
  })
})

describe('POST /comments — a comment the spam layers rejected never mails', () => {
  it('mails for the comment that got through and not for the one the honeypot caught', async () => {
    // A spam flood becoming an email flood at the owner's expense is the failure this
    // rules out. The seam sits after the write and the reject path returns before it,
    // so a stopped flood costs zero emails and zero of the owner's Resend quota.
    //
    // The accepted comment is in the same test deliberately, and is not decoration: a
    // bare "nothing was sent" passes just as well when nothing is wired, when the
    // secrets are unset, and when the stub was never installed. One send and exactly
    // one is the assertion that can tell those apart from the property.
    configureNotify()
    const calls = stubFetch(accepted)

    const rejected = await post({ [HONEYPOT_FIELD]: 'https://buy-pills.example' })
    const accepted202 = await post({ body: 'A comment written by somebody who is not a robot.' })

    expect(rejected.status).toBe(403)
    expect(accepted202.status).toBe(202)
    expect(await countComments()).toBe(1)
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    // The one send is the accepted comment's, not the rejected one's.
    expect(calls[0]?.body).toContain('somebody who is not a robot')
    expect(calls[0]?.body).not.toContain('buy-pills')
  })
})

describe('POST /comments — the notification costs no D1 queries', () => {
  /**
   * What one root comment on a new thread costs, with no `Origin` header, in order:
   * the batched settings read, the per-page rate-limit count, the duplicate-body check,
   * the classifier's model read, the thread insert, the comment insert.
   *
   * **The settings read is one statement and it stays one (#207).** It carries the
   * moderation policy, layer 8's site URL, and the notifier's two addresses and display
   * name — five rows that would otherwise be five seeks, and a sixth setting that would
   * be a sixth. It replaced a conditional `readSetting` for the policy, so the number
   * below did not move by five; it moved by one, and the conditional went away with it.
   *
   * Both bodies below are past `DUPLICATE_MIN_LENGTH` (60, src/spam/content.ts) on
   * purpose: under it the duplicate check does not run and this is one lower, which
   * would read as the wiring having saved a query rather than as the fixture being
   * short.
   *
   * **The classifier's read is `READ_SPAM_MODEL_SQL` (#10)** — a rowid seek on a
   * table the schema allows a single row in. It happens whether or not a model has
   * been trained, because the counts that decide are in that row, and this fixture
   * has trained none. So what this pins is the *untrained* cost; the count on a
   * trained deployment, where the classify path runs to the end, is pinned in
   * test/worker/spam/order.test.ts and test/worker/spam/classifier.test.ts. Both are
   * needed: only the trained one can catch a read per stored vector, which is the
   * shape a nearest-neighbour classifier would have had.
   *
   * Written down rather than only compared against itself. An on-versus-off
   * comparison is blind to a statement the wiring added *unconditionally* — the
   * notifier is built on every submission, configured or not — and that was a real
   * kill-shot this test survived before the number was pinned. If it moves, the
   * question is whether the invocation still costs the same at any thread size (the
   * 50-query budget is per invocation, and constant is the rule); a submit path that
   * legitimately gains a statement updates this line.
   */
  const STATEMENTS_PER_SUBMISSION = 6

  it('prepares the same six statements with notifications on as with them off', async () => {
    const prepare = db.prepare.bind(db)
    const seen: string[] = []
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      seen.push(sql)
      return prepare(sql)
    })

    unconfigureNotify()
    stubFetch(accepted)
    await post({
      url: 'https://maya.build/notes/off',
      body: 'One comment on a page nobody has commented on before, notifications off.',
    })
    const withoutNotify = seen.length

    seen.length = 0
    configureNotify()
    await post({
      url: 'https://maya.build/notes/on',
      body: 'One comment on a page nobody has commented on before, notifications on.',
    })
    const withNotify = seen.length

    expect(withoutNotify).toBe(STATEMENTS_PER_SUBMISSION)
    expect(withNotify).toBe(STATEMENTS_PER_SUBMISSION)
  })

  it('reads every setting in one statement rather than one per row', async () => {
    // The property the number above rests on. A total alone would be satisfied by two
    // settings reads and one fewer somewhere else, and #207's whole point is that the
    // count stops depending on how many settings this project has.
    const prepare = db.prepare.bind(db)
    const seen: string[] = []
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      seen.push(sql)
      return prepare(sql)
    })

    unconfigureNotify()
    stubFetch(accepted)
    await post({
      url: 'https://maya.build/notes/one-read',
      body: 'One comment on a page nobody has commented on before, counting settings reads.',
    })

    expect(seen.filter((sql) => sql.includes('from settings'))).toHaveLength(1)
  })
})

describe('what is handed to waitUntil reports its own failure', () => {
  /** A `waitUntil` that keeps what it was given, so a test can settle it. */
  function collector() {
    const handed: Promise<unknown>[] = []
    const ctx: WaitUntilContext = {
      waitUntil(work: Promise<unknown>) {
        handed.push(work)
      },
    }
    return { ctx, handed }
  }

  it('logs a rejected deferred promise instead of letting the runtime discard it', async () => {
    // The bug this exists to prevent has no symptom: `ctx.waitUntil(work)` with a
    // rejecting `work` is silence, and silence is what a working notifier looks like
    // to everyone except the owner who is not getting email.
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    const { ctx, handed } = collector()

    reportingDefer(ctx)(Promise.reject(new Error('resend exploded')))
    await Promise.all(handed)

    expect(errors.join('\n')).toContain('notify: deferred work failed')
    expect(errors.join('\n')).toContain('resend exploded')
  })

  it('hands the runtime a promise that never rejects', async () => {
    // The other half, and the reason the `.catch` is inside `waitUntil` rather than
    // around the call: what the runtime holds must settle, not reject.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { ctx, handed } = collector()

    reportingDefer(ctx)(Promise.reject(new Error('resend exploded')))
    const settled = await Promise.allSettled(handed)

    expect(settled.map((one) => one.status)).toEqual(['fulfilled'])
  })

  it('still defers the work itself — the reporting is not a replacement for it', async () => {
    const { ctx, handed } = collector()
    let ran = false

    reportingDefer(ctx)(Promise.resolve().then(() => (ran = true)))
    await Promise.all(handed)

    expect(ran).toBe(true)
    expect(handed).toHaveLength(1)
  })
})

describe('POST /comments — no ExecutionContext, no notification', () => {
  it('takes the comment and sends nothing when there is nowhere to defer to', async () => {
    // `app.fetch(request, env)` is a Worker invoked without an ExecutionContext, and
    // Hono's `c.executionCtx` throws rather than returning undefined. There is then
    // no way to run work after the response, and the pipeline's answer is to do
    // nothing: awaiting the send would put Resend in front of the reader's POST, and
    // dropping the promise would discard its failures. The comment still arrives.
    //
    // The announcement is asserted rather than assumed, because "no send" alone
    // cannot tell this apart from the shape where Hono returned undefined instead of
    // throwing: `deferFor` would hand back a live closure, the pipeline's own
    // try/catch would swallow the resulting TypeError, and this test would stay green
    // while production logged a dispatch failure on every single comment. Found in
    // review.
    configureNotify()
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    const calls = stubFetch(accepted)

    const response = await app.fetch(
      new Request(`${origin}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: comment(),
      }),
      env,
    )

    expect(response.status).toBe(202)
    expect(await countComments()).toBe(1)
    expect(calls).toHaveLength(0)
    expect(logs.join('\n')).toContain('no ExecutionContext')
  })
})
