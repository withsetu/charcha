// `pnpm check:actions` proves a pin is *shaped* like a full commit SHA carrying
// a `# vX.Y.Z` comment. It cannot prove the SHA exists, and it cannot prove the
// comment is true, because it runs offline. This script is the other half: it
// asks GitHub what the named tag actually points at, and asserts the pin equals
// it.
//
// Why that is worth a network call. GitHub's own guidance is not merely "pin to
// a SHA" but "when selecting a SHA, you should verify it is from the action's
// repository and not a repository fork"
// (https://docs.github.com/en/actions/reference/security/secure-use). A fork's
// commits live in the same object network as the upstream repository, so an
// attacker-authored commit is a real, resolvable, 40-character SHA that the
// offline shape check waves through and a reviewer reads as legitimate because
// of the comment beside it. Resolving the *tag* — which belongs to the action's
// own repository, and which a fork cannot write — is what closes that. It
// catches an invented SHA and a comment that has drifted from its pin for free.
//
// ── Why this is NOT in `pnpm check` ──────────────────────────────────────────
//
// `pnpm check` is offline and deterministic, and it is the command CLAUDE.md
// tells every session to run before pushing. Putting a GitHub API call in it
// would make the whole gate fail when GitHub is slow rather than when this
// repository is wrong — and a gate that goes red for an outage is a gate people
// learn to re-run until it is green. So this runs as its own workflow
// (`.github/workflows/actions-upstream.yml`), and its failure taxonomy is built
// so that it can only ever go red for a deterministic, repository-caused reason:
//
//   mismatch / unknown-tag / not-pinned / unresolvable  → exit 1. The repo is
//     wrong, and re-running will not change the answer.
//   skipped                                            → exit 0, loudly. The
//     network, a rate limit or a 5xx got in the way. Every unverified pin is
//     named in the output and counted in the summary, so a skip can never read
//     as a pass. This is the case that must not train anyone to bypass a gate.
//
// Rate limits, for the record: 60 requests/hour unauthenticated, 1,000/hour per
// repository for GITHUB_TOKEN inside Actions
// (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
// This repository resolves a handful of pins, deduplicated by repository and
// tag, so neither ceiling is in play — the token is here so a shared runner IP's
// 60/hour cannot be spent by somebody else's job.
//
// Enforced by test/node/actions-upstream.test.ts.

import { collectUses } from './actions-pinned.mjs'

const API = 'https://api.github.com'
const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * The narrowest slice of `fetch` this script uses. Declaring it structurally
 * rather than as `typeof fetch` is what lets the tests hand over a fake without
 * constructing a whole `Response`, and it is also what makes the boundary the
 * tests exercise the same one production runs.
 *
 * @typedef {(url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>} GitHubFetch
 */

/**
 * Tag naming is a repository convention, not a rule — most `actions/*` repos tag
 * `v7.0.1`, some drop the `v`. The comment is tried verbatim first so the
 * repository's own convention always wins.
 *
 * @param {string} tag
 * @returns {string[]}
 */
export function tagCandidatesFor(tag) {
  return tag.startsWith('v') ? [tag, tag.slice(1)] : [tag, `v${tag}`]
}

/**
 * @param {{ line: number, ref: string, trailing: string }} use
 * @returns {{ kind: 'pin', owner: string, repo: string, sha: string, tag: string }
 *   | { kind: 'not-applicable', reason: string }
 *   | { kind: 'not-pinned', reason: string }}
 */
export function parsePin(use) {
  const { ref, trailing } = use

  // This repository's own reviewed code; there is no upstream to resolve.
  if (ref.startsWith('./')) return { kind: 'not-applicable', reason: 'local action' }

  // A registry digest, not a git object — `check:actions` owns its pinning.
  if (ref.startsWith('docker://')) {
    return { kind: 'not-applicable', reason: 'docker image reference' }
  }

  const separator = ref.lastIndexOf('@')
  const version = separator === -1 ? '' : ref.slice(separator + 1)
  if (!FULL_SHA.test(version)) {
    return {
      kind: 'not-pinned',
      reason: `'${ref}' is not pinned to a full 40-character commit SHA`,
    }
  }

  const tag = (/^#\s*(\S+)/.exec(trailing)?.[1] ?? '').trim()
  if (tag === '') {
    return {
      kind: 'not-pinned',
      reason: `'${ref}' has no trailing '# vX.Y.Z' comment, so there is no tag to resolve it against`,
    }
  }

  // `owner/repo/sub/path@sha` — the action may live in a subdirectory, but the
  // tag belongs to `owner/repo`.
  const [owner, repo] = ref.slice(0, separator).split('/')
  if (!owner || !repo) {
    return { kind: 'not-pinned', reason: `'${ref}' is not an owner/repo action reference` }
  }

  return { kind: 'pin', owner, repo, sha: version, tag }
}

/**
 * Anything that is not a definitive answer about the repository. A rate limit
 * (403/429), an outage (5xx) and a bad or expired token (401) are all conditions
 * of the network rather than of this repository, and none of them may fail the
 * job — see the header.
 *
 * @param {number} status
 * @returns {boolean}
 */
function isInfrastructureStatus(status) {
  return status === 401 || status === 403 || status === 429 || status >= 500
}

/**
 * Resolve one `owner/repo` + tag to the commit SHA the tag names.
 *
 * Two shapes come back from the refs API and both are normal: a lightweight tag
 * points straight at a commit, while an annotated tag points at a tag object
 * that has to be dereferenced. `pnpm/action-setup` uses annotated, signed tags,
 * so a checker that only read the ref would report every one of its pins as a
 * mismatch. Verified against the live API on 2026-07-24.
 * Source: https://docs.github.com/en/rest/git/refs
 *
 * @param {GitHubFetch} fetchImpl
 * @param {Record<string, string>} headers
 * @param {string} owner
 * @param {string} repo
 * @param {string} tag
 * @returns {Promise<{ kind: 'commit', sha: string } | { kind: 'unknown-tag' } | { kind: 'skipped', reason: string } | { kind: 'unresolvable', reason: string }>}
 */
async function resolveTag(fetchImpl, headers, owner, repo, tag) {
  for (const candidate of tagCandidatesFor(tag)) {
    let response
    try {
      response = await fetchImpl(`${API}/repos/${owner}/${repo}/git/ref/tags/${candidate}`, {
        headers,
      })
    } catch (error) {
      return { kind: 'skipped', reason: error instanceof Error ? error.message : String(error) }
    }

    if (!response.ok) {
      if (isInfrastructureStatus(response.status)) {
        return { kind: 'skipped', reason: `GitHub API returned ${response.status}` }
      }
      // 404 — try the next naming convention before declaring the tag unknown.
      continue
    }

    const ref = await response.json()
    const object = ref?.object
    if (object?.type === 'commit' && FULL_SHA.test(object.sha ?? '')) {
      return { kind: 'commit', sha: object.sha }
    }

    if (object?.type === 'tag') {
      // The API response is external data, and this is the one field from it
      // that gets interpolated back into a URL. Validate before dereferencing
      // rather than trusting the shape.
      if (!FULL_SHA.test(object.sha ?? '')) {
        return {
          kind: 'unresolvable',
          reason: `refs/tags/${candidate} names a tag object with no usable SHA`,
        }
      }

      let tagResponse
      try {
        tagResponse = await fetchImpl(`${API}/repos/${owner}/${repo}/git/tags/${object.sha}`, {
          headers,
        })
      } catch (error) {
        return { kind: 'skipped', reason: error instanceof Error ? error.message : String(error) }
      }
      if (!tagResponse.ok) {
        return isInfrastructureStatus(tagResponse.status)
          ? { kind: 'skipped', reason: `GitHub API returned ${tagResponse.status}` }
          : {
              kind: 'unresolvable',
              reason: `tag object ${object.sha} could not be read (${tagResponse.status})`,
            }
      }
      const annotated = await tagResponse.json()
      if (annotated?.object?.type === 'commit' && FULL_SHA.test(annotated.object.sha ?? '')) {
        return { kind: 'commit', sha: annotated.object.sha }
      }
      return {
        kind: 'unresolvable',
        reason: `annotated tag ${candidate} dereferences to a '${annotated?.object?.type}', not a commit`,
      }
    }

    return {
      kind: 'unresolvable',
      reason: `refs/tags/${candidate} points at a '${object?.type}', not a commit or a tag object`,
    }
  }

  return { kind: 'unknown-tag' }
}

const FAILING = new Set(['mismatch', 'unknown-tag', 'not-pinned', 'unresolvable', 'no-pins'])

/**
 * @param {{ cwd?: string, fetchImpl?: GitHubFetch, token?: string }} options
 * @returns {Promise<{ ok: boolean, verified: number, skipped: number, results: Array<{ status: string, message: string }> }>}
 */
export async function checkUpstream({ cwd = process.cwd(), fetchImpl = fetch, token = '' } = {}) {
  const { uses, problems } = await collectUses({ cwd })
  if (problems.length > 0) {
    return { ok: false, verified: 0, skipped: 0, results: problems }
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'charcha-actions-upstream',
    ...(token === '' ? {} : { Authorization: `Bearer ${token}` }),
  }

  const results = []
  /** @type {Map<string, Awaited<ReturnType<typeof resolveTag>>>} */
  const resolved = new Map()
  let pins = 0
  let verified = 0
  let skipped = 0

  for (const use of uses) {
    const at = `${use.file}:${use.line}`
    const pin = parsePin(use)

    if (pin.kind === 'not-applicable') continue

    if (pin.kind === 'not-pinned') {
      pins += 1
      results.push({
        status: 'not-pinned',
        message: `${at}: ${pin.reason} — \`pnpm check:actions\` is the gate that explains this`,
      })
      continue
    }

    pins += 1
    const key = `${pin.owner}/${pin.repo}@${pin.tag}`
    if (!resolved.has(key)) {
      resolved.set(key, await resolveTag(fetchImpl, headers, pin.owner, pin.repo, pin.tag))
    }
    const upstream = resolved.get(key)

    if (upstream.kind === 'skipped') {
      skipped += 1
      results.push({
        status: 'skipped',
        message: `${at}: could not resolve ${key} — ${upstream.reason}. This pin is UNVERIFIED`,
      })
      continue
    }

    if (upstream.kind === 'unknown-tag') {
      results.push({
        status: 'unknown-tag',
        message: `${at}: ${pin.owner}/${pin.repo} has no tag '${pin.tag}' — the version comment names a release that does not exist upstream`,
      })
      continue
    }

    if (upstream.kind === 'unresolvable') {
      results.push({ status: 'unresolvable', message: `${at}: ${key} — ${upstream.reason}` })
      continue
    }

    if (upstream.sha !== pin.sha) {
      results.push({
        status: 'mismatch',
        message:
          `${at}: pinned to ${pin.sha} but ${key} is ${upstream.sha}. ` +
          'The SHA was never published under that tag — it may come from a fork, or the comment has drifted from the pin',
      })
      continue
    }

    verified += 1
    results.push({ status: 'verified', message: `${at}: ${key} is ${pin.sha}` })
  }

  // Same reasoning as scripts/bundle-size.mjs: a checker that found nothing to
  // check is broken, not satisfied.
  if (pins === 0) {
    results.push({
      status: 'no-pins',
      message: `no third-party action pins found across ${uses.length} 'uses:' step(s) — the check matched nothing`,
    })
  }

  return { ok: !results.some((result) => FAILING.has(result.status)), verified, skipped, results }
}

const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (isCli) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
  const { ok, verified, skipped, results } = await checkUpstream({ token })

  for (const result of results) {
    console.log(`[${result.status === 'verified' ? 'ok' : result.status}] ${result.message}`)
  }

  console.log(
    `\n[actions-upstream] ${verified} pin(s) verified against the GitHub API` +
      (skipped > 0 ? `, ${skipped} UNVERIFIED (see [skipped] above)` : '') +
      (token === '' ? ' — unauthenticated, 60 requests/hour' : ''),
  )

  if (!ok) {
    console.error(
      '\nactions-upstream: a pinned action does not match the tag its comment names.' +
        '\nResolve the tag yourself before trusting the pin — see scripts/actions-upstream.mjs.',
    )
    process.exit(1)
  }
}
