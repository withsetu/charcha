import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkUpstream, parsePin, TAG_CANDIDATES_FOR } from '../../scripts/actions-upstream.mjs'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'charcha-upstream-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1'
const OTHER_SHA = 'a'.repeat(40)
const TAG_OBJECT_SHA = '008330803749db0355799c700092d9a85fd074e9'

async function writeWorkflow(name: string, steps: string) {
  await mkdir(join(cwd, '.github/workflows'), { recursive: true })
  await writeFile(
    join(cwd, '.github/workflows', name),
    `name: CI\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n`,
  )
}

/**
 * A fake GitHub API. `routes` maps a path (everything after api.github.com) to
 * either a JSON body, or a `{ status }` to return that status with no body, or
 * an Error to throw — which is what a DNS failure or a dropped socket looks
 * like to `fetch`.
 */
function fakeGitHub(routes: Record<string, unknown>) {
  const calls: string[] = []
  const respond = (ok: boolean, status: number, body: unknown) => ({
    ok,
    status,
    json: () => Promise.resolve(body),
  })
  const fetchImpl = (url: string) => {
    const path = new URL(url).pathname
    calls.push(path)
    const route = routes[path]
    if (route === undefined) return Promise.resolve(respond(false, 404, { message: 'Not Found' }))
    if (route instanceof Error) return Promise.reject(route)
    if (typeof route === 'object' && route !== null && 'status' in route) {
      return Promise.resolve(
        respond(false, (route as { status: number }).status, { message: 'no' }),
      )
    }
    return Promise.resolve(respond(true, 200, route))
  }
  return { fetchImpl, calls }
}

const lightweightTag = (sha: string) => ({ object: { type: 'commit', sha } })
const annotatedTag = (tagSha: string) => ({ object: { type: 'tag', sha: tagSha } })

describe('parsePin', () => {
  it('splits owner, repo and SHA out of a pinned reference', () => {
    expect(
      parsePin({ line: 1, ref: `actions/checkout@${CHECKOUT_SHA}`, trailing: '# v7.0.1' }),
    ).toEqual({
      kind: 'pin',
      owner: 'actions',
      repo: 'checkout',
      sha: CHECKOUT_SHA,
      tag: 'v7.0.1',
    })
  })

  it('keeps the repository, not the subdirectory, when the action lives in a subpath', () => {
    expect(
      parsePin({ line: 1, ref: `owner/repo/sub/action@${CHECKOUT_SHA}`, trailing: '# v1.2.3' }),
    ).toMatchObject({ kind: 'pin', owner: 'owner', repo: 'repo', tag: 'v1.2.3' })
  })

  it('takes only the first token of the trailing comment as the tag', () => {
    expect(
      parsePin({
        line: 1,
        ref: `actions/checkout@${CHECKOUT_SHA}`,
        trailing: '# v7.0.1 pinned by hand',
      }),
    ).toMatchObject({ tag: 'v7.0.1' })
  })

  it('reports a local action as out of scope rather than as a problem', () => {
    expect(parsePin({ line: 1, ref: './.github/actions/setup', trailing: '' })).toMatchObject({
      kind: 'not-applicable',
    })
  })

  it('reports a docker image as out of scope — it is not a GitHub repository', () => {
    expect(
      parsePin({ line: 1, ref: `docker://alpine@sha256:${'a'.repeat(64)}`, trailing: '' }),
    ).toMatchObject({
      kind: 'not-applicable',
    })
  })

  it('reports a tag reference as unpinned rather than trying to resolve it', () => {
    expect(parsePin({ line: 1, ref: 'actions/checkout@v7', trailing: '' })).toMatchObject({
      kind: 'not-pinned',
    })
  })

  it('reports a SHA pin with no version comment as unpinned — there is no tag to resolve against', () => {
    expect(
      parsePin({ line: 1, ref: `actions/checkout@${CHECKOUT_SHA}`, trailing: '' }),
    ).toMatchObject({
      kind: 'not-pinned',
    })
  })
})

describe('TAG_CANDIDATES_FOR', () => {
  it('tries the comment verbatim first, then the other v-prefix convention', () => {
    expect(TAG_CANDIDATES_FOR('v7.0.1')).toEqual(['v7.0.1', '7.0.1'])
    expect(TAG_CANDIDATES_FOR('7.0.1')).toEqual(['7.0.1', 'v7.0.1'])
  })
})

describe('checkUpstream', () => {
  it('verifies a pin against a lightweight tag', async () => {
    await writeWorkflow('ci.yml', `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1`)
    const { fetchImpl } = fakeGitHub({
      '/repos/actions/checkout/git/ref/tags/v7.0.1': lightweightTag(CHECKOUT_SHA),
    })

    const result = await checkUpstream({ cwd, fetchImpl })

    expect(result.ok).toBe(true)
    expect(result.verified).toBe(1)
    expect(result.skipped).toBe(0)
    expect(result.results[0]).toMatchObject({ status: 'verified' })
  })

  // pnpm/action-setup tags this way, and a checker that only reads the ref
  // would report every one of its pins as a mismatch.
  it('dereferences an annotated tag to the commit it points at', async () => {
    await writeWorkflow('ci.yml', `      - uses: pnpm/action-setup@${CHECKOUT_SHA} # v6.0.9`)
    const { fetchImpl, calls } = fakeGitHub({
      '/repos/pnpm/action-setup/git/ref/tags/v6.0.9': annotatedTag(TAG_OBJECT_SHA),
      [`/repos/pnpm/action-setup/git/tags/${TAG_OBJECT_SHA}`]: {
        object: { type: 'commit', sha: CHECKOUT_SHA },
      },
    })

    const result = await checkUpstream({ cwd, fetchImpl })

    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ status: 'verified' })
    expect(calls).toHaveLength(2)
  })

  it('fails when the SHA is not what the tag in the comment points at', async () => {
    await writeWorkflow('ci.yml', `      - uses: actions/checkout@${OTHER_SHA} # v7.0.1`)
    const { fetchImpl } = fakeGitHub({
      '/repos/actions/checkout/git/ref/tags/v7.0.1': lightweightTag(CHECKOUT_SHA),
    })

    const result = await checkUpstream({ cwd, fetchImpl })

    expect(result.ok).toBe(false)
    expect(result.results[0]).toMatchObject({ status: 'mismatch' })
    expect(result.results[0]?.message).toContain(CHECKOUT_SHA)
  })

  // The whole point: a well-formed SHA that upstream never published — from a
  // fork, or invented — passes the offline shape check and fails here.
  it('fails a well-formed SHA that the tag does not resolve to, which is the fork case', async () => {
    await writeWorkflow(
      'ci.yml',
      `      - uses: actions/checkout@0000000000000000000000000000000000000000 # v7.0.1`,
    )
    const { fetchImpl } = fakeGitHub({
      '/repos/actions/checkout/git/ref/tags/v7.0.1': lightweightTag(CHECKOUT_SHA),
    })

    const result = await checkUpstream({ cwd, fetchImpl })

    expect(result.ok).toBe(false)
    expect(result.results[0]).toMatchObject({ status: 'mismatch' })
  })

  it('fails when the comment names a tag that does not exist upstream', async () => {
    await writeWorkflow('ci.yml', `      - uses: actions/checkout@${CHECKOUT_SHA} # v99.0.0`)
    const { fetchImpl } = fakeGitHub({})

    const result = await checkUpstream({ cwd, fetchImpl })

    expect(result.ok).toBe(false)
    expect(result.results[0]).toMatchObject({ status: 'unknown-tag' })
  })

  it('falls back to the other v-prefix convention before declaring the tag unknown', async () => {
    await writeWorkflow('ci.yml', `      - uses: some/action@${CHECKOUT_SHA} # 1.2.3`)
    const { fetchImpl } = fakeGitHub({
      '/repos/some/action/git/ref/tags/v1.2.3': lightweightTag(CHECKOUT_SHA),
    })

    const result = await checkUpstream({ cwd, fetchImpl })

    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ status: 'verified' })
  })

  it('fails an unpinned reference rather than quietly ignoring it', async () => {
    await writeWorkflow('ci.yml', '      - uses: actions/checkout@v7')
    const { fetchImpl } = fakeGitHub({})

    const result = await checkUpstream({ cwd, fetchImpl })

    expect(result.ok).toBe(false)
    expect(result.results[0]).toMatchObject({ status: 'not-pinned' })
  })

  // GitHub being slow is not this repository being wrong. A gate that goes red
  // for an outage is a gate people learn to re-run until it is green.
  it('skips — loudly, and without failing — when the API is rate limited', async () => {
    await writeWorkflow('ci.yml', `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1`)
    const { fetchImpl } = fakeGitHub({
      '/repos/actions/checkout/git/ref/tags/v7.0.1': { status: 403 },
    })

    const result = await checkUpstream({ cwd, fetchImpl })

    expect(result.ok).toBe(true)
    expect(result.verified).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.results[0]).toMatchObject({ status: 'skipped' })
    expect(result.results[0]?.message).toContain('403')
  })

  it('skips when the API returns a server error', async () => {
    await writeWorkflow('ci.yml', `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1`)
    const { fetchImpl } = fakeGitHub({
      '/repos/actions/checkout/git/ref/tags/v7.0.1': { status: 503 },
    })

    const result = await checkUpstream({ cwd, fetchImpl })

    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ status: 'skipped' })
  })

  it('skips when the network is unreachable', async () => {
    await writeWorkflow('ci.yml', `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1`)
    const { fetchImpl } = fakeGitHub({
      '/repos/actions/checkout/git/ref/tags/v7.0.1': new Error(
        'getaddrinfo ENOTFOUND api.github.com',
      ),
    })

    const result = await checkUpstream({ cwd, fetchImpl })

    expect(result.ok).toBe(true)
    expect(result.results[0]).toMatchObject({ status: 'skipped' })
    expect(result.results[0]?.message).toContain('ENOTFOUND')
  })

  it('fails when the ref resolves to something that is neither a commit nor a tag', async () => {
    await writeWorkflow('ci.yml', `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1`)
    const { fetchImpl } = fakeGitHub({
      '/repos/actions/checkout/git/ref/tags/v7.0.1': { object: { type: 'tree', sha: OTHER_SHA } },
    })

    const result = await checkUpstream({ cwd, fetchImpl })

    expect(result.ok).toBe(false)
    expect(result.results[0]).toMatchObject({ status: 'unresolvable' })
  })

  it('resolves each repository and tag once, however many steps use it', async () => {
    await writeWorkflow(
      'ci.yml',
      `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1\n      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1`,
    )
    const { fetchImpl, calls } = fakeGitHub({
      '/repos/actions/checkout/git/ref/tags/v7.0.1': lightweightTag(CHECKOUT_SHA),
    })

    const result = await checkUpstream({ cwd, fetchImpl })

    expect(result.ok).toBe(true)
    expect(result.verified).toBe(2)
    expect(calls).toEqual(['/repos/actions/checkout/git/ref/tags/v7.0.1'])
  })

  it('scans composite action definitions, which a workflow reference alone would hide', async () => {
    await writeWorkflow('ci.yml', '      - uses: ./.github/actions/setup')
    await mkdir(join(cwd, '.github/actions/setup'), { recursive: true })
    await writeFile(
      join(cwd, '.github/actions/setup/action.yml'),
      `name: setup\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-node@${OTHER_SHA} # v7.0.0\n`,
    )
    const { fetchImpl } = fakeGitHub({
      '/repos/actions/setup-node/git/ref/tags/v7.0.0': lightweightTag(CHECKOUT_SHA),
    })

    const result = await checkUpstream({ cwd, fetchImpl })

    expect(result.ok).toBe(false)
    expect(result.results[0]).toMatchObject({ status: 'mismatch' })
    expect(result.results[0]?.message).toContain('.github/actions/setup/action.yml:5')
  })

  // Same reasoning as scripts/bundle-size.mjs: a check that finds nothing to
  // check is broken, not satisfied.
  it('fails when there is nothing to resolve, rather than passing vacuously', async () => {
    await writeWorkflow('ci.yml', '      - run: pnpm install --frozen-lockfile')
    const { fetchImpl } = fakeGitHub({})

    const result = await checkUpstream({ cwd, fetchImpl })

    expect(result.ok).toBe(false)
    expect(result.results[0]).toMatchObject({ status: 'no-pins' })
  })

  function recordingFetch(seen: Array<Record<string, string>>) {
    return (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(lightweightTag(CHECKOUT_SHA)),
      })
    }
  }

  it('sends the token as a bearer credential when one is supplied', async () => {
    await writeWorkflow('ci.yml', `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1`)
    const seen: Array<Record<string, string>> = []

    await checkUpstream({ cwd, fetchImpl: recordingFetch(seen), token: 'ghs_example' })

    expect(seen[0]?.Authorization).toBe('Bearer ghs_example')
  })

  it('sends no Authorization header when there is no token', async () => {
    await writeWorkflow('ci.yml', `      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1`)
    const seen: Array<Record<string, string>> = []

    await checkUpstream({ cwd, fetchImpl: recordingFetch(seen), token: '' })

    expect(seen[0]).not.toHaveProperty('Authorization')
  })
})
