// The page at `/`. Designed on #140, cut back to what a public address may say on #145.
//
// The first block is the whole of what the page is for. Everything after it is the
// constraint, and it is most of the file on purpose: `/` is unauthenticated, so every
// `not.toContain` here is a sentence about what a stranger, a scanner or a crawler
// learns from one GET. The page shipped on #142 answered that question with the
// deployment's migration state, its embed snippet and the address of its dashboard.

import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { ROOT_PAGE } from '../../../src/root/page'

const db = env.DB

const DEPLOYMENT = 'https://chaipecharcha.example.workers.dev'

function get(url = `${DEPLOYMENT}/`) {
  return exports.default.fetch(url)
}

beforeEach(async () => {
  await db.exec('DELETE FROM comments')
  await db.exec('DELETE FROM threads')
  await db.exec('DELETE FROM settings')
})

describe('the page Cloudflare sends a deployer to', () => {
  it('answers, rather than the 404 that reads as a failed deploy', async () => {
    const response = await get()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
  })

  // Deliberately public, and pinned here so that adding auth means deleting a test
  // and reading why. The page exists to greet a deployer in the seconds after a
  // deploy, before any password has been used — a login in front of it would defeat
  // #140 entirely. The consequence is that everything on it is world-readable, which
  // is the constraint the rest of this file enforces (#143).
  it('is readable with no session, because that is the point of it', async () => {
    const response = await get()

    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('says the Worker is running, in those words', async () => {
    expect(await (await get()).text()).toContain('Charcha is running')
  })

  it('says in one line what Charcha is, for whoever is not the deployer', async () => {
    expect(await (await get()).text()).toContain('Self-hosted comments for static sites')
  })

  it('sends that reader to charcha.dev, which is the only thing it has to offer them', async () => {
    expect(await (await get()).text()).toContain('href="https://charcha.dev"')
  })

  // `noopener` because a link that hands the opened tab a handle on this one is a
  // needless grant, and `noreferrer` because the referrer would be this deployment's
  // own address — the one piece of information this page still holds.
  it('opens that link without handing over a window handle or this address', async () => {
    expect(await (await get()).text()).toContain('rel="noopener noreferrer"')
  })

  // The claim it made before #143 was that readers never see it. They can: it is this
  // origin's front door. The sentence stays now that the page is nearly empty, because
  // it is the reason the page is nearly empty — without it this reads as unfinished,
  // which is an invitation to fill it in (#143, #107).
  it('does not tell the reader it is private', async () => {
    const html = await (await get()).text()

    expect(html).not.toMatch(/readers never see/i)
    expect(html).toMatch(/anyone with this address can see this page/i)
  })
})

describe('what a stranger learns from it, which is nothing', () => {
  // The #145 guard, and the one to kill-shot. `Database needs its migration` on a
  // public page is "this deployment is half-broken", world-readable, next to advice
  // naming the step that failed. The page is a constant with no state in it, so this
  // asserts the vocabulary is absent rather than merely unreached — a page that
  // reported status through any other route would still trip it.
  it('reports no database state, healthy or otherwise', async () => {
    const html = await (await get()).text()

    for (const word of [
      'database',
      'Database',
      'migration',
      'migrated',
      'unmigrated',
      'schema',
      'could not be reached',
    ]) {
      expect(html).not.toContain(word)
    }
  })

  // Handing `/admin` to whoever asks saves a scanner the trouble of guessing it. The
  // deployer is told where their dashboard is by the README, which is not public
  // per deployment.
  it('does not name the dashboard, so a scanner is not walked to the login', async () => {
    expect(await (await get()).text()).not.toContain('/admin')
  })

  // The snippet is this deployment's integration line. It is in the README and in
  // docs/theming.md, where a stranger reading it learns nothing about anyone's site.
  it('hands over no embed snippet, and so names no integration surface', async () => {
    const html = await (await get()).text()

    expect(html).not.toContain('embed.js')
    expect(html).not.toContain('id="charcha"')
  })

  it('reports no comment count, on a database that has comments in it', async () => {
    await db.exec(
      "INSERT INTO threads (id, page_key, created_at, updated_at) VALUES (1, 'maya.build/a', 1, 1)",
    )
    await db.exec(
      'INSERT INTO comments (thread_id, author_name, body, body_hash, status, created_at)' +
        " VALUES (1, 'Rahul', 'Hello', 'h', 'approved', 1)",
    )

    const html = await (await get()).text()

    expect(html).not.toContain('maya.build')
    expect(html).not.toContain('Rahul')
    expect(html).not.toMatch(/\b1 comment\b/)
  })

  it('names no configuration, set or unset — that would be a note to attackers', async () => {
    const html = await (await get()).text()

    for (const secret of [
      'Turnstile',
      'TURNSTILE_SECRET_KEY',
      'CHARCHA_DASHBOARD_PASSWORD',
      'IP_HASH_SECRET',
      'RESEND_API_KEY',
      'Resend',
      'Allowed origins',
    ]) {
      expect(html).not.toContain(secret)
    }
  })

  it('does not disclose the allowlist, which is the owner’s list of their own sites', async () => {
    await db
      .prepare('insert into settings (key, value, updated_at) values (?1, ?2, ?3)')
      .bind('allowed_origins', 'https://unlisted-staging.maya.build', 1)
      .run()

    expect(await (await get()).text()).not.toContain('unlisted-staging.maya.build')
  })
})

describe('how it manages to disclose nothing', () => {
  // The page shipped on #142 interpolated this deployment's own origin, and needed an
  // escaping test to be safe about it. It interpolates nothing now, which is a
  // stronger property than escaping correctly: there is no value to get wrong.
  it('is a constant, so the route has nothing to add to it', async () => {
    expect(await (await get()).text()).toBe(ROOT_PAGE)
  })

  it('is byte-identical whatever address it was asked for', async () => {
    const mine = await (await get()).text()
    const theirs = await (await get('https://someone-elses.example.workers.dev/')).text()

    expect(theirs).toBe(mine)
  })
})

describe('the headers it is served with', () => {
  // Kept from #140 and load-bearing for a second reason on #145: `nofollow` at page
  // level applies to every link on the page, which is why the link to charcha.dev
  // carries no `rel="nofollow"` of its own. See src/root/page.ts for why a deployment
  // must not pass ranking signal to charcha.dev at all.
  it('is noindex and nofollow, in the header and in the markup — a crawler may read only one', async () => {
    const response = await get()
    const html = await response.text()

    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(html).toContain('content="noindex, nofollow"')
  })

  it('allows no script at all, which is what keeps this document harmless', async () => {
    // Load-bearing for src/cors.ts: a same-origin request is accepted without an
    // allowlist because the only documents on this origin are this one and /admin,
    // and neither can run injected script. That claim is only true while this is.
    const csp = (await get()).headers.get('content-security-policy') ?? ''

    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toContain('script-src')
  })

  it('cannot be framed, and cannot have its relative URLs repointed', async () => {
    const csp = (await get()).headers.get('content-security-policy') ?? ''

    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("base-uri 'none'")
  })

  // The one address this page still knows is its own, and the outbound link is the
  // only way it could travel. `no-referrer` is what stops charcha.dev accumulating a
  // list of deployments from its own referrer logs.
  it('sends no referrer, so following the link does not report this deployment', async () => {
    expect((await get()).headers.get('referrer-policy')).toBe('no-referrer')
  })

  // Not because the content is volatile — it is a constant now — but because a
  // redeploy is the one thing that changes it, and a deployer checking whether their
  // redeploy landed should not be answered by an intermediary's copy of the last one.
  it('is not stored by anything in front of it', async () => {
    expect((await get()).headers.get('cache-control')).toBe('no-store')
  })

  it('is not served for any other address, which stays a 404', async () => {
    const response = await get(`${DEPLOYMENT}/nope`)

    expect(response.status).toBe(404)
  })
})
