import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkDeployConfig,
  declaredSecrets,
  parseDotenv,
  postDeployInstruction,
  stripJsonComments,
} from '../../scripts/deploy-config.mjs'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'charcha-deploy-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

const write = async (name: string, contents: string) => {
  const path = join(cwd, name)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, contents)
}

type Manifest = {
  scripts?: Record<string, string>
  cloudflare?: { bindings?: Record<string, { description?: string }> }
}

const HEALTHY_MANIFEST: Manifest = {
  scripts: {
    deploy: 'wrangler d1 migrations apply DB --remote && wrangler deploy',
  },
  cloudflare: {
    bindings: {
      CHARCHA_DASHBOARD_PASSWORD: { description: 'The dashboard password.' },
    },
  },
}

const HEALTHY_WRANGLER = `{
  // The Deploy button rewrites database_id.
  "d1_databases": [{ "binding": "DB", "database_name": "charcha", "database_id": "0" }]
}`

const HEALTHY_ENV_MODULE = `declare global {
  interface Env {
    /** Doc comment with a brace in it: \`{}\`. */
    readonly CHARCHA_DASHBOARD_PASSWORD?: string
  }
}

export type AdminEnv = Pick<Env, 'CHARCHA_DASHBOARD_PASSWORD'>
`

/** The shape this guard is meant to accept: one secret, listed, described, migrated. */
async function writeHealthyRepo(overrides: Partial<Manifest> = {}) {
  await write('package.json', JSON.stringify({ ...HEALTHY_MANIFEST, ...overrides }))
  await write('wrangler.jsonc', HEALTHY_WRANGLER)
  await write('.dev.vars.example', '# A comment\nCHARCHA_DASHBOARD_PASSWORD=\n')
  await write('src/admin/env.ts', HEALTHY_ENV_MODULE)
}

/**
 * A second secret the fixture repository reads and the deploy form must *not* collect —
 * the #139 shape, where the only value a deployer could invent would break something.
 */
async function writeOptionalSecret() {
  await write(
    'src/spam/env.ts',
    'declare global {\n  interface Env {\n    readonly OPTIONAL_PROVIDER_KEY?: string\n  }\n}\n',
  )
}

/**
 * What the synthetic repositories below collect at deploy time.
 *
 * They declare their own secrets, so charcha's real `DEPLOY_FORM_SECRETS` is the wrong
 * list to hold them to — `IP_HASH_SECRET` is on it and no fixture declares one. The
 * repository's actual list is asserted separately, by `passes this repository`.
 */
const FIXTURE_FORM_SECRETS = ['CHARCHA_DASHBOARD_PASSWORD']

const check = (options: { cwd?: string; formSecrets?: string[] } = {}) =>
  checkDeployConfig({ cwd, formSecrets: FIXTURE_FORM_SECRETS, ...options })

const statuses = (result: { violations: Array<{ status: string }> }) =>
  result.violations.map((violation) => violation.status)

const withDeployScript = (deploy: string): Partial<Manifest> => ({
  scripts: { deploy },
})

describe('checkDeployConfig', () => {
  // The gate that actually protects a deployer. Every other test here proves the
  // checker works; only this one says anything about the config being shipped, and
  // without it the whole file could pass against a repository whose deploy is broken.
  it('passes this repository', async () => {
    const repoRoot = join(import.meta.dirname, '..', '..')

    const result = await checkDeployConfig({ cwd: repoRoot })

    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('passes a repository whose deploy flow collects and migrates everything', async () => {
    await writeHealthyRepo()

    const result = await check()

    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
  })

  // The #12 failure, generalised: a required secret the Deploy form never asks for
  // means a dashboard that 401s every route while comments keep arriving. #139 made
  // "not in the form" a legitimate choice for *optional* secrets, so the guard now asks
  // the deployer's question — is this secret reachable anywhere — and both answers have
  // to be missing before it fires.
  it('fails when a secret src/ declares is in neither the example file nor the README', async () => {
    await writeHealthyRepo()
    await writeOptionalSecret()

    const result = await check()

    expect(statuses(result)).toEqual(['unlisted-secret'])
    expect(result.violations[0]?.message).toContain('OPTIONAL_PROVIDER_KEY')
    expect(result.violations[0]?.message).toContain(join('src', 'spam', 'env.ts'))
  })

  // The #139 shape: the deploy form requires every field it shows and offers no way to
  // mark one optional (workers-sdk#14075), so a secret whose only safe value is nothing
  // must not be a field. It still has to be findable.
  it('accepts an optional secret documented as a post-deploy step instead of collected', async () => {
    await writeHealthyRepo()
    await writeOptionalSecret()
    await write('README.md', `Afterwards: \`${postDeployInstruction('OPTIONAL_PROVIDER_KEY')}\`\n`)

    const result = await check()

    expect(result.violations).toEqual([])
  })

  // Naming the secret is not documenting it. A deployer reading "you may also want to
  // set OPTIONAL_PROVIDER_KEY" has been told a fact, not given an instruction, and the
  // whole reason the secret left the form is that setting it is now their job.
  it('does not accept prose that merely mentions the secret’s name', async () => {
    await writeHealthyRepo()
    await writeOptionalSecret()
    await write('README.md', 'Charcha also reads OPTIONAL_PROVIDER_KEY.\n')

    const result = await check()

    expect(statuses(result)).toEqual(['unlisted-secret'])
  })

  it('fails a post-deploy secret whose README instruction names a different secret', async () => {
    await writeHealthyRepo()
    await writeOptionalSecret()
    await write('README.md', `\`${postDeployInstruction('SOME_OTHER_SECRET')}\`\n`)

    const result = await check()

    expect(statuses(result)).toEqual(['unlisted-secret'])
  })

  // The failure a substring search hides, and the one a "documented somewhere" check is
  // most likely to have: `OPTIONAL_PROVIDER` is a prefix of the documented
  // `OPTIONAL_PROVIDER_KEY`, so a plain `includes` would count a line that never
  // mentions it as instructions for it.
  it('does not let a secret ride along on a documented secret it is a prefix of', async () => {
    await writeHealthyRepo()
    await write(
      'src/spam/env.ts',
      'declare global {\n  interface Env {\n    readonly OPTIONAL_PROVIDER?: string\n  }\n}\n',
    )
    await write('README.md', `\`${postDeployInstruction('OPTIONAL_PROVIDER_KEY')}\`\n`)

    const result = await check()

    expect(statuses(result)).toEqual(['unlisted-secret'])
    expect(result.violations[0]?.message).toContain('OPTIONAL_PROVIDER')
  })

  // What gets left behind when a secret moves out of the form. The description reads
  // like guidance that was given and is attached to a field that no longer exists, so
  // it is seen by nobody and looks like coverage to the next maintainer.
  it('fails when a description outlives the deploy-form field it explained', async () => {
    await writeHealthyRepo({
      cloudflare: {
        bindings: {
          CHARCHA_DASHBOARD_PASSWORD: { description: 'The dashboard password.' },
          OPTIONAL_PROVIDER_KEY: { description: 'Left behind by the move.' },
        },
      },
    })
    await writeOptionalSecret()
    await write('README.md', `\`${postDeployInstruction('OPTIONAL_PROVIDER_KEY')}\`\n`)

    const result = await check()

    expect(statuses(result)).toEqual(['undisplayed-description'])
    expect(result.violations[0]?.message).toContain('OPTIONAL_PROVIDER_KEY')
  })

  // `cloudflare.bindings` describes every binding type, not only secrets, and the D1
  // database *is* a deploy-form field. An earlier version of the check above rejected
  // this, which would have made legitimate help text fail `pnpm check`.
  it('allows a description for a binding that is not a secret', async () => {
    await writeHealthyRepo({
      cloudflare: {
        bindings: {
          CHARCHA_DASHBOARD_PASSWORD: { description: 'The dashboard password.' },
          DB: { description: 'Where your comments are stored. The default name is fine.' },
        },
      },
    })

    const result = await check()

    expect(result.violations).toEqual([])
  })

  // The half a README line must never be able to buy. Without this, the two checks
  // above are one unconditional OR and the secret the dashboard cannot start without
  // could leave the form entirely — found in review of #139.
  it('fails when a secret the form is supposed to collect has left the example file', async () => {
    await writeHealthyRepo({ cloudflare: {} })
    await write('.dev.vars.example', '')
    await write('README.md', `\`${postDeployInstruction('CHARCHA_DASHBOARD_PASSWORD')}\`\n`)

    const result = await check()

    expect(statuses(result)).toEqual(['missing-form-field'])
    expect(result.violations[0]?.message).toContain('CHARCHA_DASHBOARD_PASSWORD')
  })

  // And the other direction, which is the #104 path: a secret nobody decided belongs on
  // the form becomes a field the deployer must invent a value for.
  it('fails when the example file collects a secret that is not on the form list', async () => {
    await writeHealthyRepo({
      cloudflare: {
        bindings: {
          CHARCHA_DASHBOARD_PASSWORD: { description: 'The dashboard password.' },
          OPTIONAL_PROVIDER_KEY: { description: 'Should not be a field.' },
        },
      },
    })
    await writeOptionalSecret()
    await write('.dev.vars.example', 'CHARCHA_DASHBOARD_PASSWORD=\nOPTIONAL_PROVIDER_KEY=\n')

    const result = await check()

    expect(statuses(result)).toEqual(['unexpected-form-field'])
    expect(result.violations[0]?.message).toContain('OPTIONAL_PROVIDER_KEY')
  })

  it('finds a secret declared without `readonly`, which TypeScript does not require', async () => {
    await writeHealthyRepo()
    await write(
      'src/spam/env.ts',
      'declare global {\n  interface Env {\n    NEW_SECRET?: string\n  }\n}\n',
    )

    const result = await check()

    expect(statuses(result)).toEqual(['unlisted-secret'])
    expect(result.violations[0]?.message).toContain('NEW_SECRET')
  })

  it('finds a secret declared in a .tsx file', async () => {
    await writeHealthyRepo()
    await write(
      'src/dashboard/config.tsx',
      'declare global {\n  interface Env {\n    readonly DASHBOARD_SECRET?: string\n  }\n}\n',
    )

    const result = await check()

    expect(statuses(result)).toEqual(['unlisted-secret'])
    expect(result.violations[0]?.message).toContain('DASHBOARD_SECRET')
  })

  it('fails when the example file asks for a secret no source file reads', async () => {
    await writeHealthyRepo()
    await write('.dev.vars.example', 'CHARCHA_DASHBOARD_PASSWORD=\nOLD_PROVIDER_KEY=\n')

    const result = await check()

    // Three separate things are wrong with the same line, and each is a different
    // reason a deployer meets a field they cannot answer: nobody put it on the form
    // list, nothing reads it, and nothing explains it.
    expect(statuses(result)).toEqual([
      'unexpected-form-field',
      'unread-secret',
      'undescribed-secret',
    ])
  })

  it('fails when the example file ships a value, which the deploy form pre-fills', async () => {
    await writeHealthyRepo()
    await write('.dev.vars.example', 'CHARCHA_DASHBOARD_PASSWORD=hunter2\n')

    const result = await check()

    expect(statuses(result)).toEqual(['example-secret-has-value'])
  })

  it('does not echo the value it found, which would copy a credential into the log', async () => {
    await writeHealthyRepo()
    await write('.dev.vars.example', 'CHARCHA_DASHBOARD_PASSWORD=hunter2\n')

    const result = await check()

    expect(result.violations[0]?.message).not.toContain('hunter2')
  })

  it('sees through quotes, so `NAME=""` is not read as empty', async () => {
    await writeHealthyRepo()
    await write('.dev.vars.example', 'CHARCHA_DASHBOARD_PASSWORD="a # b"\n')

    const result = await check()

    expect(statuses(result)).toEqual(['example-secret-has-value'])
  })

  // .gitignore un-ignores .env.example, and Cloudflare reads either file. A guard
  // that opens only one of them leaves a hole the exact shape of the check.
  it('reads .env.example too, and catches a value committed there', async () => {
    await writeHealthyRepo()
    await write('.env.example', 'CHARCHA_DASHBOARD_PASSWORD=hunter2\n')

    const result = await check()

    expect(statuses(result)).toEqual(['example-secret-has-value'])
    expect(result.violations[0]?.message).toContain('.env.example')
  })

  it('accepts a secret listed only in .env.example', async () => {
    await writeHealthyRepo()
    await rm(join(cwd, '.dev.vars.example'))
    await write('.env.example', 'CHARCHA_DASHBOARD_PASSWORD=\n')

    const result = await check()

    expect(result.violations).toEqual([])
  })

  it('fails when a collected secret has no description for the deploy form', async () => {
    await writeHealthyRepo({ cloudflare: { bindings: {} } })

    const result = await check()

    expect(statuses(result)).toEqual(['undescribed-secret'])
  })

  it('fails on a blank description, which renders as no description at all', async () => {
    await writeHealthyRepo({
      cloudflare: { bindings: { CHARCHA_DASHBOARD_PASSWORD: { description: '   ' } } },
    })

    const result = await check()

    expect(statuses(result)).toEqual(['undescribed-secret'])
  })

  it('fails when there is no deploy script, because the default one skips migrations', async () => {
    await writeHealthyRepo({ scripts: {} })

    const result = await check()

    expect(statuses(result)).toEqual(['no-deploy-script'])
    expect(result.violations[0]?.message).toContain('npx wrangler deploy')
  })

  // This is the state charcha was in when #16 was picked up.
  it('fails when the deploy script only deploys', async () => {
    await writeHealthyRepo(withDeployScript('wrangler deploy'))

    const result = await check()

    expect(statuses(result)).toEqual(['deploy-skips-migrations'])
  })

  it('fails when the deploy script migrates but never deploys', async () => {
    await writeHealthyRepo(withDeployScript('wrangler d1 migrations apply DB --remote'))

    const result = await check()

    expect(statuses(result)).toEqual(['deploy-does-not-deploy'])
  })

  it('accepts `wrangler versions upload` as the deploying step', async () => {
    await writeHealthyRepo(
      withDeployScript('wrangler d1 migrations apply DB --remote && wrangler versions upload'),
    )

    const result = await check()

    expect(result.violations).toEqual([])
  })

  it('fails when migrations target the database name rather than the binding', async () => {
    await writeHealthyRepo(
      withDeployScript('wrangler d1 migrations apply charcha --remote && wrangler deploy'),
    )

    const result = await check()

    expect(statuses(result)).toEqual(['migrates-wrong-target'])
    expect(result.violations[0]?.message).toContain('binding name')
  })

  it('fails when the migration step has no --remote', async () => {
    await writeHealthyRepo(
      withDeployScript('wrangler d1 migrations apply DB --local && wrangler deploy'),
    )

    const result = await check()

    expect(statuses(result)).toEqual(['migrates-locally'])
  })

  it('does not read a later command’s flags as the migration’s own', async () => {
    // `--remote` here belongs to `wrangler deploy`, not to the migration. A flag
    // group that ran to the end of the line would satisfy the assertion with a word
    // from a different command, and the check would pass for the wrong reason.
    await writeHealthyRepo(
      withDeployScript('wrangler d1 migrations apply DB --local && wrangler deploy --remote'),
    )

    const result = await check()

    expect(statuses(result)).toEqual(['migrates-locally'])
  })

  it('fails when the deploy happens before the migration', async () => {
    await writeHealthyRepo(
      withDeployScript('wrangler deploy && wrangler d1 migrations apply DB --remote'),
    )

    const result = await check()

    expect(statuses(result)).toEqual(['migrates-after-deploy'])
  })

  // Ordering alone is not the invariant. `;` runs the deploy whatever happened, and
  // a Worker live against an unmigrated database is exactly what the order is for.
  it.each([
    ['a semicolon', 'wrangler d1 migrations apply DB --remote; wrangler deploy'],
    ['`|| true`', 'wrangler d1 migrations apply DB --remote || true && wrangler deploy'],
    ['a single `&`', 'wrangler d1 migrations apply DB --remote & wrangler deploy'],
  ])('fails when the migration is joined to the deploy by %s', async (_name, script) => {
    await writeHealthyRepo(withDeployScript(script))

    const result = await check()

    expect(statuses(result)).toEqual(['migration-failure-still-deploys'])
  })

  // The reuse convention asks for this form, and Cloudflare's own example uses it.
  it('follows one level of `pnpm run` indirection into another script', async () => {
    await writeHealthyRepo({
      scripts: {
        deploy: 'pnpm run db:migrate:remote && wrangler deploy',
        'db:migrate:remote': 'wrangler d1 migrations apply DB --remote',
      },
    })

    const result = await check()

    expect(result.violations).toEqual([])
  })

  it('still catches a broken migration reached through indirection', async () => {
    await writeHealthyRepo({
      scripts: {
        deploy: 'pnpm db:migrate && wrangler deploy',
        'db:migrate': 'wrangler d1 migrations apply DB --local',
      },
    })

    const result = await check()

    expect(statuses(result)).toEqual(['migrates-locally'])
  })

  it('does not loop forever on a script that references itself', async () => {
    await writeHealthyRepo({ scripts: { deploy: 'pnpm run deploy' } })

    const result = await check()

    expect(statuses(result)).toEqual(['deploy-does-not-deploy', 'deploy-skips-migrations'])
  })

  it('reports a missing example file once, rather than as a fault per secret', async () => {
    await writeHealthyRepo()
    await rm(join(cwd, '.dev.vars.example'))

    const result = await check()

    expect(statuses(result)).toEqual(['no-example-secrets-file'])
  })

  it('stops at an unparseable wrangler config rather than guessing the binding', async () => {
    await writeHealthyRepo()
    await write('wrangler.jsonc', '{ "d1_databases": [')

    const result = await check()

    expect(statuses(result)).toEqual(['unreadable-wrangler-config'])
  })

  it('stops at an unreadable package.json', async () => {
    await writeHealthyRepo()
    await write('package.json', '{ not json')

    const result = await check()

    expect(statuses(result)).toEqual(['unreadable-package-json'])
  })

  it('says so when wrangler.jsonc declares no D1 database to migrate', async () => {
    await writeHealthyRepo()
    await write('wrangler.jsonc', '{ "name": "charcha" }')

    const result = await check()

    expect(statuses(result)).toEqual(['no-d1-binding'])
  })
})

describe('declaredSecrets', () => {
  it('reads secrets out of a declare global block and ignores bindings', async () => {
    await write(
      'src/admin/env.ts',
      `declare global {
  interface Env {
    readonly CHARCHA_DASHBOARD_PASSWORD?: string
    readonly LOGIN_RATE_LIMITER: RateLimit
    readonly DB: D1Database
  }
}
`,
    )

    expect(await declaredSecrets(cwd)).toEqual([
      { name: 'CHARCHA_DASHBOARD_PASSWORD', file: join('src', 'admin', 'env.ts') },
    ])
  })

  // The fixture deliberately contains a `declare global` block, so the scoping is
  // what the assertion rests on. Without one the test would pass by never reaching
  // the code it is named after.
  it('ignores an Env interface outside the declare global block in the same file', async () => {
    await write(
      'src/admin/view.ts',
      `declare global {
  interface Something {
    readonly IRRELEVANT?: string
  }
}

export interface Env {
  readonly LOCAL_ONLY?: string
}
`,
    )

    expect(await declaredSecrets(cwd)).toEqual([])
  })

  it('collects from a second declare global block in the same file', async () => {
    await write(
      'src/admin/env.ts',
      `declare global {
  interface Env {
    readonly FIRST_SECRET?: string
  }
}

declare global {
  interface Env {
    readonly SECOND_SECRET?: string
  }
}
`,
    )

    expect((await declaredSecrets(cwd)).map((secret) => secret.name)).toEqual([
      'FIRST_SECRET',
      'SECOND_SECRET',
    ])
  })

  it('skips the generated binding types', async () => {
    await write(
      'src/worker-configuration.d.ts',
      `declare global {
  interface Env {
    readonly GENERATED_SECRET?: string
  }
}
`,
    )

    expect(await declaredSecrets(cwd)).toEqual([])
  })

  it('collects from every module that extends Env, not just the first', async () => {
    await write(
      'src/spam/env.ts',
      'declare global {\n  interface Env {\n    readonly IP_HASH_SECRET?: string\n  }\n}\n',
    )
    await write(
      'src/admin/env.ts',
      'declare global {\n  interface Env {\n    readonly CHARCHA_DASHBOARD_PASSWORD?: string\n  }\n}\n',
    )

    const names = (await declaredSecrets(cwd)).map((secret) => secret.name)

    expect(names).toEqual(expect.arrayContaining(['IP_HASH_SECRET', 'CHARCHA_DASHBOARD_PASSWORD']))
    expect(names).toHaveLength(2)
  })

  it('finds every secret this repository declares', async () => {
    // The exact set, not a subset, so adding a secret is a decision someone makes
    // here rather than a line that appears in a deploy form unnoticed. Updating this
    // list is the point of the failure, not an obstacle to it.
    const repoRoot = join(import.meta.dirname, '..', '..')

    const names = (await declaredSecrets(repoRoot)).map((secret) => secret.name).sort()

    expect(names).toEqual([
      // The pair of #11, layer 7, which are also a set: either alone leaves the
      // third-party spam check off. Off is the default on every deployment, because
      // it is the one layer that transmits something about a reader.
      'AKISMET_API_KEY',
      'CHARCHA_DASHBOARD_PASSWORD',
      // The three of #14, which are all optional and only work as a set.
      'CHARCHA_NOTIFY_FROM',
      'CHARCHA_NOTIFY_TO',
      'CHARCHA_SITE_URL',
      'IP_HASH_SECRET',
      'RESEND_API_KEY',
      'TURNSTILE_SECRET_KEY',
    ])
  })
})

describe('parseDotenv', () => {
  it('reads names, drops comments, and strips a trailing inline comment', () => {
    expect(parseDotenv('# heading\n\nA=\nB=value # why\n')).toEqual([
      { name: 'A', value: '' },
      { name: 'B', value: 'value' },
    ])
  })

  it('keeps a # that is inside quotes, and unwraps the quotes', () => {
    expect(parseDotenv('A="a # b"\nB=\'c\'\n')).toEqual([
      { name: 'A', value: 'a # b' },
      { name: 'B', value: 'c' },
    ])
  })

  it('reads an empty quoted value as a value, not as empty', () => {
    // `NAME=""` looks empty and is not: the form would pre-fill an empty string
    // rather than leaving the field unset.
    expect(parseDotenv('A=""\n')).toEqual([{ name: 'A', value: '' }])
  })

  it('reads an `export`-prefixed line, which dotenv files often carry', () => {
    expect(parseDotenv('export A=b\n')).toEqual([{ name: 'A', value: 'b' }])
  })
})

describe('stripJsonComments', () => {
  it('removes both comment forms', () => {
    expect(JSON.parse(stripJsonComments('{ // one\n "a": 1 /* two */ }'))).toEqual({ a: 1 })
  })

  it('leaves a // inside a string alone, which a regex would eat', () => {
    const config = '{ "$schema": "https://example.com/schema.json" }'

    expect(JSON.parse(stripJsonComments(config))).toEqual({
      $schema: 'https://example.com/schema.json',
    })
  })

  it('leaves a */ and an escaped quote inside a string alone', () => {
    const config = '{ "a": "*/ still \\" string" }'

    expect(JSON.parse(stripJsonComments(config))).toEqual({ a: '*/ still " string' })
  })

  it('drops an unterminated block comment rather than throwing', () => {
    expect(stripJsonComments('{ "a": 1 } /* to the end')).toContain('"a": 1')
  })
})
