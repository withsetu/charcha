// The page at `/`. Designed on issue #140.
//
// Two halves are tested here and they pull in opposite directions: the page has to
// say enough that a deployer stops thinking the deploy failed, and it is a public,
// unauthenticated URL that must say nothing about this deployment's contents or its
// configuration. Most of the file is the second half.

import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { embedSnippet, renderRootPage } from '../../../src/root/page'

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

  it('says the Worker is running, in those words', async () => {
    expect(await (await get()).text()).toContain('Charcha is running')
  })

  it('says the database is ready when the migrations have been applied', async () => {
    expect(await (await get()).text()).toContain('Database ready')
  })

  it('points at the dashboard, which is where everything else is done', async () => {
    expect(await (await get()).text()).toContain('/admin')
  })

  it('names the allowed-origins setting, the thing a fresh deployment still needs', async () => {
    // #57: the deployment accepts its own origin out of the box, and the owner's real
    // site still has to be listed. This page is where they are told so, at the one
    // moment they are looking.
    expect(await (await get()).text()).toContain('Allowed origins')
  })
})

describe('the embed snippet it hands over', () => {
  it('carries this deployment’s own origin, already filled in', async () => {
    const html = await (await get()).text()

    expect(html).toContain(`${DEPLOYMENT}/embed.js`)
  })

  it('is the documented snippet — the mount element and a deferred script', () => {
    expect(embedSnippet(DEPLOYMENT)).toBe(
      `<div id="charcha"></div>\n<script src="${DEPLOYMENT}/embed.js" defer></script>`,
    )
  })

  it('escapes the origin rather than trusting it, because it came off the wire', () => {
    // `request.url` is built from the Host the edge resolved, so this cannot carry
    // markup on a routed deployment — but the snippet is the one place on this page
    // where any value is interpolated at all, and escaping is what makes that
    // unremarkable rather than something to reason about.
    const html = renderRootPage({
      origin: 'https://a.example/"><script>alert(1)',
      database: 'ready',
    })

    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('&lt;script&gt;alert(1)')
  })

  it('is left out entirely when the origin cannot be read, rather than shown broken', () => {
    // #140: "A snippet that differs from the documented one is worse than none."
    const html = renderRootPage({ origin: null, database: 'ready' })

    expect(html).not.toContain('embed.js')
    expect(html).toContain('Charcha is running')
  })
})

describe('what it deliberately does not say', () => {
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

describe('the headers it is served with', () => {
  it('is noindex, in the header and in the markup — a crawler may read only one', async () => {
    const response = await get()

    expect(response.headers.get('x-robots-tag')).toContain('noindex')
    expect(await response.text()).toContain('noindex')
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

  it('is never cached, because "is it running" is a question about right now', async () => {
    expect((await get()).headers.get('cache-control')).toBe('no-store')
  })

  it('is not served for any other address, which stays a 404', async () => {
    const response = await get(`${DEPLOYMENT}/nope`)

    expect(response.status).toBe(404)
  })
})

describe('when the deploy did not entirely work', () => {
  it('says the database still needs migrating rather than claiming everything is fine', () => {
    // The real failure mode from #129: Cloudflare creates the database and does not
    // migrate it, and a build token without D1 makes the migration step fail with no
    // useful output. A Worker published against an empty database answers `select 1`
    // perfectly well.
    const html = renderRootPage({ origin: DEPLOYMENT, database: 'unmigrated' })

    expect(html).toContain('migration')
    expect(html).not.toContain('Database ready')
  })

  it('says the database could not be reached when D1 will not answer', () => {
    const html = renderRootPage({ origin: DEPLOYMENT, database: 'unreachable' })

    expect(html).toContain('could not be reached')
    expect(html).not.toContain('Database ready')
  })
})
