import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkDeployConfig,
  declaredSecrets,
  parseDotenv,
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

const statuses = (result: { violations: Array<{ status: string }> }) =>
  result.violations.map((violation) => violation.status)

const withDeployScript = (deploy: string): Partial<Manifest> => ({
  scripts: { deploy },
})

describe('checkDeployConfig', () => {
  it('passes a repository whose deploy flow collects and migrates everything', async () => {
    await writeHealthyRepo()

    const result = await checkDeployConfig({ cwd })

    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
  })

  // The #12 failure, generalised: a required secret the Deploy form never asks for
  // means a dashboard that 401s every route while comments keep arriving.
  it('fails when a secret src/ declares is missing from the example file', async () => {
    await writeHealthyRepo()
    await write('.dev.vars.example', '')

    const result = await checkDeployConfig({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toContain('unlisted-secret')
    expect(result.violations[0]?.message).toContain('CHARCHA_DASHBOARD_PASSWORD')
    expect(result.violations[0]?.message).toContain('src/admin/env.ts')
  })

  it('fails when the example file asks for a secret no source file reads', async () => {
    await writeHealthyRepo()
    await write('.dev.vars.example', 'CHARCHA_DASHBOARD_PASSWORD=\nOLD_PROVIDER_KEY=\n')

    const result = await checkDeployConfig({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toContain('unread-secret')
  })

  it('fails when the example file ships a value, which the deploy form pre-fills', async () => {
    await writeHealthyRepo()
    await write('.dev.vars.example', 'CHARCHA_DASHBOARD_PASSWORD=hunter2\n')

    const result = await checkDeployConfig({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toContain('example-secret-has-value')
  })

  it('fails when a collected secret has no description for the deploy form', async () => {
    await writeHealthyRepo({ cloudflare: { bindings: {} } })

    const result = await checkDeployConfig({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toEqual(['undescribed-secret'])
  })

  it('fails on a blank description, which renders as no description at all', async () => {
    await writeHealthyRepo({
      cloudflare: { bindings: { CHARCHA_DASHBOARD_PASSWORD: { description: '   ' } } },
    })

    const result = await checkDeployConfig({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toEqual(['undescribed-secret'])
  })

  it('fails when there is no deploy script, because the default one skips migrations', async () => {
    await writeHealthyRepo({ scripts: {} })

    const result = await checkDeployConfig({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toEqual(['no-deploy-script'])
    expect(result.violations[0]?.message).toContain('npx wrangler deploy')
  })

  // This is the state charcha was in when #16 was picked up.
  it('fails when the deploy script only deploys', async () => {
    await writeHealthyRepo(withDeployScript('wrangler deploy'))

    const result = await checkDeployConfig({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toEqual(['deploy-skips-migrations'])
  })

  it('fails when migrations target the database name rather than the binding', async () => {
    await writeHealthyRepo(
      withDeployScript('wrangler d1 migrations apply charcha --remote && wrangler deploy'),
    )

    const result = await checkDeployConfig({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toEqual(['migrates-wrong-target'])
    expect(result.violations[0]?.message).toContain('binding name')
  })

  it('fails when the migration step has no --remote', async () => {
    await writeHealthyRepo(
      withDeployScript('wrangler d1 migrations apply DB --local && wrangler deploy'),
    )

    const result = await checkDeployConfig({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toEqual(['migrates-locally'])
  })

  it('does not read a later command’s flags as the migration’s own', async () => {
    // `--remote` here belongs to `wrangler deploy`, not to the migration. A flag
    // group that ran to the end of the line would satisfy the assertion with a word
    // from a different command, and the check would pass for the wrong reason.
    await writeHealthyRepo(
      withDeployScript('wrangler d1 migrations apply DB --local && wrangler deploy --remote'),
    )

    const result = await checkDeployConfig({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toEqual(['migrates-locally'])
  })

  it('fails when the deploy happens before the migration', async () => {
    await writeHealthyRepo(
      withDeployScript('wrangler deploy && wrangler d1 migrations apply DB --remote'),
    )

    const result = await checkDeployConfig({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toContain('migrates-after-deploy')
  })

  it('reports a missing example file once, rather than as a fault per secret', async () => {
    await writeHealthyRepo()
    await rm(join(cwd, '.dev.vars.example'))

    const result = await checkDeployConfig({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toEqual(['no-example-secrets-file'])
  })

  it('stops at an unparseable wrangler config rather than guessing the binding', async () => {
    await writeHealthyRepo()
    await write('wrangler.jsonc', '{ "d1_databases": [')

    const result = await checkDeployConfig({ cwd })

    expect(result.ok).toBe(false)
    expect(statuses(result)).toEqual(['unreadable-wrangler-config'])
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

  it('ignores an Env interface that is not merged into the global scope', async () => {
    // `AdminEnv`-style local views of `Env` are not declarations of new secrets, and
    // counting them would demand a deploy-form field for every re-export.
    await write(
      'src/admin/view.ts',
      `export interface Env {
  readonly SOMETHING_ELSE?: string
}
`,
    )

    expect(await declaredSecrets(cwd)).toEqual([])
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
})

describe('parseDotenv', () => {
  it('reads names, drops comments, and strips a trailing inline comment', () => {
    expect(parseDotenv('# heading\n\nA=\nB=value # why\n')).toEqual([
      { name: 'A', value: '' },
      { name: 'B', value: 'value' },
    ])
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
})
