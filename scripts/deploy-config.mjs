// The ways a one-click deploy produces a Worker that does not work.
//
// Nobody on this project can run a Deploy-to-Cloudflare build — it needs a real
// Cloudflare account, and the failure lands on a stranger rather than on us. So the
// parts of that flow which *are* repository state get asserted here instead, in
// `pnpm check` and in CI, where a regression is caught by the person who caused it.
//
// Each violation below is a deploy that goes green and hands someone a broken
// install, which is why they are gates and not documentation:
//
//   1. **A secret `src/` reads that a deployer is never told about — in either of the
//      two places they could be.** The Deploy flow builds its form from the example
//      file — "Worker secrets can be defined in a `.dev.vars.example` or
//      `.env.example` file with a dotenv format"
//      (https://developers.cloudflare.com/workers/platform/deploy-buttons/) — so a
//      name listed there is asked for at deploy time, and a name left out has to be
//      found and set by hand. #12 made `CHARCHA_DASHBOARD_PASSWORD` required and
//      fail-closed: unasked *and* undocumented, it means a dashboard that 401s every
//      route forever while comments keep arriving.
//
//      Leaving a name out is now a legitimate choice rather than always a mistake, and
//      #139 is why: the deploy form **requires every field it shows**, with no
//      documented way to mark one optional
//      (https://github.com/cloudflare/workers-sdk/issues/14075, open, reproduced
//      against the live form on 2026-05-28). For `TURNSTILE_SECRET_KEY` that is worse
//      than a long form — the only value a deployer can invent breaks their own
//      comment form silently (#104), so the safe value is *no field*. The rule this
//      guard enforces is therefore the deployer's view rather than the file's: every
//      secret is either **collected at deploy time** or **documented in README.md as a
//      post-deploy `wrangler secret put`**. Neither, and it is invisible.
//
//      That alone is an unconditional OR, and would let *any* secret leave the form for
//      the cost of one README line — including the one #12 is about. So which side each
//      secret is on is pinned separately, by `DEPLOY_FORM_SECRETS` below, and asserted
//      in both directions. Moving a secret across that line is an edit to a list rather
//      than a side effect of editing a dotenv file.
//   2. **A secret with no description.** Same Cloudflare page: a `cloudflare.bindings`
//      entry in package.json is what puts an explanation next to the field. Without
//      one the deployer sees a bare box labelled with a constant name. The converse is
//      checked too — a description for a name the form does not show is text nobody
//      will ever read, and it is exactly what gets left behind when a secret moves out
//      of the form, so it would otherwise rot into a false record of guidance given.
//   3. **A `deploy` script that does not apply migrations, or does not stop when
//      they fail.** Cloudflare provisions the D1 database and rewrites
//      `database_id`, and it does not run migrations — "If you would like to run
//      migrations as part of your setup, you can specify this in your `package.json`
//      by running your migrations as part of your `deploy` script." An unmigrated
//      database fails on the first request, so the migration has to run first *and*
//      be joined to the deploy by `&&`: with `;` or `|| true` a failed migration
//      still ships a live Worker against a schema that is not there.
//   4. **Migrating by database *name*.** Same page, and it is explicit: "The
//      migration command should reference the binding name rather than the database
//      name to ensure migrations are successful when users specify a database name
//      that is different from that of your source repository." The deploy form lets
//      a deployer rename the database; the binding is the only stable handle.
//
// All four checked against Cloudflare's docs on 2026-07-25; the required-field
// behaviour in (1) is not in those docs and is cited to the workers-sdk issue instead.
//
// Enforced by test/node/deploy-config.test.ts, which also asserts that *this*
// repository passes — a guard exercised only against synthetic fixtures proves the
// checker works and says nothing about the config being shipped.

import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * Files the Deploy flow will read secrets from, both of them.
 *
 * Checking only the first would leave the second as a hole exactly the shape of the
 * thing being checked: `.gitignore` un-ignores `.env.example`, so one could be
 * committed with a value in it and pass a guard that never opened it.
 */
export const EXAMPLE_SECRETS_FILES = ['.dev.vars.example', '.env.example']

/** Where the Worker's own source lives, relative to the repository root. */
export const SOURCE_DIR = 'src'

/**
 * The file a secret has to be documented in when the deploy form does not collect it.
 *
 * README.md rather than anywhere under docs/, because this is the page a deployer is
 * already on: the Deploy button lives in it, and Cloudflare shows it beside the form.
 */
export const POST_DEPLOY_DOCS_FILE = 'README.md'

/**
 * The literal a secret's post-deploy documentation has to contain, which is the command
 * that sets it.
 *
 * Prose mentioning the name would satisfy a looser check while telling a deployer
 * nothing they can run, and the whole reason a secret is out of the form is that
 * setting it afterwards is now their job. So the check is for the instruction, not for
 * the word — though it is a search for a string rather than an understanding of it,
 * and a README saying *not* to run the command would pass. That is the weakness a
 * reviewer should know about; it is not one a deployer can be hurt by.
 *
 * @param {string} name
 * @returns {string}
 */
export function postDeployInstruction(name) {
  return `wrangler secret put ${name}`
}

/**
 * Whether `docs` gives a runnable instruction for setting `name` after the deploy.
 *
 * The trailing boundary is the point. A plain substring search would let
 * `wrangler secret put IP_HASH_SECRET` document a secret called `IP_HASH` for free —
 * any name that is a prefix of a documented one passes without a word written about
 * it, which is the failure a "documented somewhere" check is most likely to hide.
 *
 * @param {string} docs
 * @param {string} name
 * @returns {boolean}
 */
function documentsPostDeploy(docs, name) {
  // The name is a JS identifier by construction — `declaredSecrets` only collects
  // /[A-Z][A-Z0-9_]*/ — so there is nothing here to escape for the regex.
  return new RegExp(`${postDeployInstruction(name)}(?![A-Za-z0-9_])`).test(docs)
}

/**
 * The secrets the Deploy to Cloudflare form collects, and the whole of the decision
 * #139 took.
 *
 * It is a list rather than something derived because it is a judgement no file records:
 * a secret belongs on that form only when a value is genuinely **required** *and* any
 * value a hurried deployer invents is **safe**. Both halves are needed. The form
 * requires every field it shows (workers-sdk#14075), so a name here that a deployer has
 * no value for leaves them inventing one — which for `TURNSTILE_SECRET_KEY` refuses
 * every comment on their site for good (#104) — and a name missing from here that the
 * deployment cannot work without is #12, a dashboard that 401s its own login forever.
 *
 * Asserted in both directions below, so moving a secret across this line is an edit to
 * this list and therefore a decision someone makes, rather than a consequence of
 * editing a dotenv file. Without it the two checks are one unconditional OR, and
 * `CHARCHA_DASHBOARD_PASSWORD` could leave the form entirely for the cost of one README
 * line — found in review.
 */
export const DEPLOY_FORM_SECRETS = ['CHARCHA_DASHBOARD_PASSWORD', 'IP_HASH_SECRET']

/**
 * Secrets `src/` still reads but that a deployer must **not** be told to set (#207).
 *
 * `CHARCHA_SITE_URL`, `CHARCHA_NOTIFY_FROM` and `CHARCHA_NOTIFY_TO` are `settings` rows
 * now, editable in the dashboard. The `Env` declarations survive because an existing
 * deployment's values are still honoured when the matching row has never been written —
 * that fallback is the migration, and #209 removes it.
 *
 * **This is a hole in rule (1), so it is a list with its own three checks rather than an
 * exemption.** Without them, "deprecated" would be a word in a comment and the gate would
 * simply stop covering three names:
 *
 *   - it must not be on the deploy form, for the reason it left `env` at all;
 *   - README must **not** carry `wrangler secret put <NAME>`, because that instruction now
 *     sends a deployer to configure a value the code reads only when the dashboard field
 *     is empty — which works until they edit the field, and then silently stops;
 *   - README must still **name** it, because a deployment already running on one needs to
 *     find out where its value moved to. That is the half a plain exemption would drop.
 *
 * Emptying this list is what #209 is; adding to it is a decision someone makes here.
 */
export const DEPRECATED_SECRETS = ['CHARCHA_SITE_URL', 'CHARCHA_NOTIFY_FROM', 'CHARCHA_NOTIFY_TO']

/** Extensions a secret could be declared in. `.tsx` because the dashboard is React. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx']

/**
 * The generated binding types. Skipped when collecting secrets, because it
 * declares every *binding* wrangler.jsonc names — `DB`, `LOGIN_RATE_LIMITER` —
 * and those are provisioned rather than typed in by a deployer.
 */
const GENERATED_TYPES = 'worker-configuration.d.ts'

/**
 * Strips `//` and `/* *\/` comments from JSONC without touching string contents.
 *
 * A regex would be shorter and wrong: wrangler.jsonc's `$schema` is a path, and
 * any future string value holding a URL would lose everything after its `//`. So
 * this walks the text and only treats a delimiter as one when it is outside a
 * string.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripJsonComments(text) {
  let out = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      out += char
      continue
    }

    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
      continue
    }

    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }

    out += char
  }

  return out
}

/**
 * Every source file under a directory, recursively.
 *
 * @param {string} dir
 * @param {string} root
 * @returns {Promise<string[]>} paths relative to `root`
 */
async function sourceFiles(dir, root) {
  /** @type {string[]} */
  const found = []
  /** @type {import('node:fs').Dirent[]} */
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }

  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await sourceFiles(path, root)))
    else if (
      SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) &&
      entry.name !== GENERATED_TYPES
    )
      found.push(relative(root, path))
  }

  return found.sort()
}

/**
 * The body of the block opened by the `{` at or after `from`, found by counting
 * braces rather than by a lazy regex — these blocks hold doc comments with braces
 * in them, and `[\s\S]*?\}` stops at the first one.
 *
 * @param {string} source
 * @param {number} from index of the `{`
 * @returns {string | null}
 */
function blockBody(source, from) {
  if (source[from] !== '{') return null

  let depth = 1
  for (let i = from + 1; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(from + 1, i)
    }
  }

  return null
}

/**
 * The bodies of every `interface Env { … }` **inside** a `declare global` block.
 *
 * The scoping is checked rather than assumed, and that matters in both directions:
 * a `declare global` anywhere in the file is not licence to read an unrelated
 * `export interface Env` further down as a secret declaration, and a file with two
 * `declare global` blocks must not have the second silently dropped.
 *
 * @param {string} source
 * @returns {string[]}
 */
function globalEnvBodies(source) {
  /** @type {string[]} */
  const bodies = []

  for (const match of source.matchAll(/declare\s+global\s*\{/g)) {
    const block = blockBody(source, match.index + match[0].length - 1)
    if (block === null) continue

    for (const env of block.matchAll(/interface\s+Env\s*\{/g)) {
      const body = blockBody(block, env.index + env[0].length - 1)
      if (body !== null) bodies.push(body)
    }
  }

  return bodies
}

/**
 * The secrets this Worker reads, collected from the `declare global` blocks that
 * merge into `Env`.
 *
 * That is where a charcha secret is declared, and the convention is not incidental:
 * `wrangler types` generates types only for what wrangler.jsonc declares, and a
 * secret is not declared there, so `src/spam/env.ts` and `src/admin/env.ts` extend
 * `Env` from source instead of editing a generated file. Reading the same
 * declarations back is therefore reading the project's own list rather than a
 * second, drifting copy of it.
 *
 * Only members typed `string` are collected, which is intended to separate secrets
 * — always strings, always typed in by a deployer — from bindings, which are
 * provisioned and typed as objects. It is a heuristic and not a proof: a secret
 * narrowed to a union of string literals would be missed, and a reviewer adding one
 * should widen the pattern here rather than assume it was considered.
 *
 * @param {string} cwd
 * @returns {Promise<Array<{ name: string, file: string }>>}
 */
export async function declaredSecrets(cwd) {
  const root = join(cwd, SOURCE_DIR)
  const files = await sourceFiles(root, cwd)
  /** @type {Array<{ name: string, file: string }>} */
  const secrets = []

  for (const file of files) {
    const source = await readFile(join(cwd, file), 'utf8')
    if (!source.includes('declare global')) continue

    for (const body of globalEnvBodies(source)) {
      // `readonly` is optional: TypeScript does not require it, and a secret
      // declared without it would otherwise be invisible to this whole check.
      for (const match of body.matchAll(
        /(?:readonly\s+)?([A-Z][A-Z0-9_]*)\s*\??\s*:\s*string\b/g,
      )) {
        const name = match[1]
        if (!secrets.some((secret) => secret.name === name)) secrets.push({ name, file })
      }
    }
  }

  return secrets
}

/**
 * Parses an example secrets file as the dotenv file the Deploy flow reads it as.
 *
 * Quotes are handled because the emptiness rule depends on them: `NAME=""` is a
 * value that looks empty to a naive reader and is not one, and a `#` inside quotes
 * is part of the value rather than a comment.
 *
 * @param {string} contents
 * @returns {Array<{ name: string, value: string }>}
 */
export function parseDotenv(contents) {
  /** @type {Array<{ name: string, value: string }>} */
  const entries = []

  for (const line of contents.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(trimmed)
    if (match === null) continue

    const raw = match[2].trim()
    const quoted = /^(['"])((?:\\.|[^\\])*?)\1/.exec(raw)
    // A trailing `# comment` is part of the documented format, not part of the
    // value — but only outside quotes.
    const value = quoted === null ? raw.replace(/\s+#.*$/, '').trim() : quoted[2]
    entries.push({ name: match[1], value })
  }

  return entries
}

/**
 * The D1 binding names in a wrangler configuration file.
 *
 * @param {unknown} config
 * @returns {string[]}
 */
function d1Bindings(config) {
  if (typeof config !== 'object' || config === null) return []
  const databases = /** @type {{ d1_databases?: unknown }} */ (config).d1_databases
  if (!Array.isArray(databases)) return []
  return databases
    .map((database) =>
      typeof database === 'object' && database !== null
        ? /** @type {{ binding?: unknown }} */ (database).binding
        : undefined,
    )
    .filter((binding) => typeof binding === 'string')
}

/**
 * A script with one level of `pnpm run <other>` indirection inlined.
 *
 * Without this, composing `deploy` out of the existing `db:migrate:remote` script —
 * the form the reuse convention asks for, and the form Cloudflare's own example
 * uses — would read as a `deploy` that never migrates. Recursion is bounded and a
 * script never expands itself.
 *
 * @param {Record<string, unknown>} scripts
 * @param {string} name
 * @param {Set<string>} seen
 * @returns {string | null}
 */
function expandScript(scripts, name, seen = new Set()) {
  const body = scripts[name]
  if (typeof body !== 'string') return null
  if (seen.has(name) || seen.size > 4) return body

  const next = new Set(seen).add(name)
  return body.replace(
    /\b(?:pnpm|npm|yarn)(?:\s+run)?\s+([a-zA-Z][a-zA-Z0-9:_-]*)/g,
    (whole, referenced) => {
      const nested = expandScript(scripts, referenced, next)
      return nested === null ? whole : `( ${nested} )`
    },
  )
}

/** `wrangler d1 migrations apply <target> [flags]`, stopping at a shell operator. */
const MIGRATE_COMMAND = /wrangler\s+d1\s+migrations\s+apply\s+([^\s&|;()]+)((?:\s+[^\s&|;()]+)*)/

/** `wrangler deploy` or the preview-branch equivalent. */
const DEPLOY_COMMAND = /wrangler\s+(?:deploy|versions\s+upload)/

/**
 * Whether a failure in the earlier command stops the later one.
 *
 * `&&` is the only separator that does. `;` runs the deploy regardless, `||` runs
 * it *because* the migration failed, and a single `&` backgrounds the migration so
 * the deploy races it.
 *
 * @param {string} between
 * @returns {boolean}
 */
function stopsOnFailure(between) {
  if (!between.includes('&&')) return false
  if (between.includes(';') || between.includes('||')) return false
  return !/(^|[^&])&([^&]|$)/.test(between)
}

/**
 * @param {{ cwd?: string, formSecrets?: string[], deprecatedSecrets?: string[] }} options
 *   `formSecrets` and `deprecatedSecrets` override charcha's own lists — the synthetic
 *   repositories in test/node/deploy-config.test.ts declare different secrets and pass
 *   their own.
 * @returns {Promise<{ ok: boolean, collected: string[], violations: Array<{ status: string, message: string }> }>}
 */
export async function checkDeployConfig({
  cwd = process.cwd(),
  formSecrets = DEPLOY_FORM_SECRETS,
  deprecatedSecrets = DEPRECATED_SECRETS,
} = {}) {
  /** @type {Array<{ status: string, message: string }>} */
  const violations = []

  /** @type {Record<string, unknown>} */
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
  } catch (error) {
    violations.push({
      status: 'unreadable-package-json',
      message: `package.json could not be read, so nothing about the deploy flow can be checked: ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
    return { ok: false, collected: [], violations }
  }

  /** @type {unknown} */
  let wrangler
  try {
    wrangler = JSON.parse(stripJsonComments(await readFile(join(cwd, 'wrangler.jsonc'), 'utf8')))
  } catch (error) {
    violations.push({
      status: 'unreadable-wrangler-config',
      message: `wrangler.jsonc could not be parsed, so the D1 binding the deploy script must migrate cannot be established: ${
        error instanceof Error ? error.message : String(error)
      }`,
    })
    return { ok: false, collected: [], violations }
  }

  /** @type {Array<{ file: string, name: string, value: string }>} */
  const example = []
  let anyExampleFile = false
  for (const file of EXAMPLE_SECRETS_FILES) {
    let contents
    try {
      contents = await readFile(join(cwd, file), 'utf8')
    } catch {
      continue
    }
    anyExampleFile = true
    for (const entry of parseDotenv(contents)) example.push({ file, ...entry })
  }

  if (!anyExampleFile) {
    violations.push({
      status: 'no-example-secrets-file',
      message:
        `neither ${EXAMPLE_SECRETS_FILES.join(' nor ')} exists — a one-click deploy asks for ` +
        'nothing, so every secret has to be found and set by hand afterwards',
    })
  }

  const secrets = await declaredSecrets(cwd)
  const listed = [...new Set(example.map((entry) => entry.name))]

  // Read rather than required to exist: a repository with no README fails every
  // not-collected secret below, which is the right answer and a clearer one than a
  // separate violation about the file.
  let postDeployDocs
  try {
    postDeployDocs = await readFile(join(cwd, POST_DEPLOY_DOCS_FILE), 'utf8')
  } catch {
    postDeployDocs = ''
  }

  if (anyExampleFile) {
    // The #139 decision itself, both ways round. Without these two, the checks below
    // are one unconditional OR: any secret at all may leave the form for the cost of a
    // README line, including the one the dashboard cannot start without.
    for (const name of formSecrets) {
      if (listed.includes(name)) continue
      violations.push({
        status: 'missing-form-field',
        message:
          `${name} is one of the secrets the deploy form is supposed to collect, and no example ` +
          `file lists it — so the form does not show it. A README instruction is not a ` +
          `substitute here: this is a secret a deployment does not work without, and the ` +
          `deployer would have to already know it exists. Either put it back in ` +
          `${EXAMPLE_SECRETS_FILES[0]} or take it off DEPLOY_FORM_SECRETS deliberately.`,
      })
    }

    for (const name of listed) {
      if (formSecrets.includes(name)) continue
      // A deprecated name on the form has its own, more specific violation below; two
      // messages about one line is one message nobody reads.
      if (deprecatedSecrets.includes(name)) continue
      violations.push({
        status: 'unexpected-form-field',
        message:
          `${name} is listed in an example file and is not on DEPLOY_FORM_SECRETS, so it becomes ` +
          `a deploy-form field that the deployer **must** fill in (workers-sdk#14075). A secret ` +
          `only belongs there when a value is required and any value they invent is safe — ` +
          `TURNSTILE_SECRET_KEY is neither, and an invented one refuses every comment on their ` +
          `site (#104). Add it to DEPLOY_FORM_SECRETS if that judgement really was made.`,
      })
    }

    // The three checks that keep `DEPRECATED_SECRETS` from being an unconditional
    // exemption. See that constant.
    for (const name of deprecatedSecrets) {
      if (!secrets.some((secret) => secret.name === name)) {
        violations.push({
          status: 'deprecated-secret-not-read',
          message:
            `${name} is on DEPRECATED_SECRETS and no \`interface Env\` under ${SOURCE_DIR}/ ` +
            `declares it any more, so the fallback that list exists to describe is gone. Take ` +
            `the name off the list — with it there, this check is exempting something that ` +
            `does not exist.`,
        })
        continue
      }
      if (listed.includes(name)) {
        violations.push({
          status: 'deprecated-form-field',
          message:
            `${name} is deprecated and an example file lists it, so the deploy form asks every ` +
            `new deployer to fill in a value the code reads only until they use the dashboard ` +
            `field that replaced it. Take it out of the example file.`,
        })
      }
      if (documentsPostDeploy(postDeployDocs, name)) {
        violations.push({
          status: 'deprecated-secret-still-instructed',
          message:
            `${POST_DEPLOY_DOCS_FILE} still contains \`${postDeployInstruction(name)}\`, and ` +
            `${name} is deprecated: the setting that replaced it wins whenever it has been ` +
            `saved, so following that line configures something that works until the owner ` +
            `edits the dashboard and then silently stops. Describe the setting instead.`,
        })
      }
      if (!postDeployDocs.includes(name)) {
        violations.push({
          status: 'undocumented-deprecated-secret',
          message:
            `${name} is deprecated and ${POST_DEPLOY_DOCS_FILE} does not mention it at all. A ` +
            `deployment already running on it has no way to learn where its value moved to, ` +
            `which is the failure the deprecation is supposed to avoid rather than cause.`,
        })
      }
    }

    for (const secret of secrets) {
      if (listed.includes(secret.name)) continue
      if (deprecatedSecrets.includes(secret.name)) continue
      if (documentsPostDeploy(postDeployDocs, secret.name)) continue
      violations.push({
        status: 'unlisted-secret',
        message:
          `${secret.file} declares the secret ${secret.name}, and a deployer is told about it in ` +
          `neither place they could be: no example file lists it, so the Deploy to Cloudflare ` +
          `form (built from ${EXAMPLE_SECRETS_FILES.join(' / ')}) never asks for it, and ` +
          `${POST_DEPLOY_DOCS_FILE} does not contain \`${postDeployInstruction(secret.name)}\`, ` +
          `so there is nothing to set it with afterwards either. The code reads \`undefined\` on ` +
          `a fresh install and nobody involved knows why.`,
      })
    }

    for (const entry of example) {
      if (secrets.some((secret) => secret.name === entry.name)) continue
      violations.push({
        status: 'unread-secret',
        message:
          `${entry.file} lists ${entry.name} and no \`interface Env\` under ${SOURCE_DIR}/ ` +
          `declares it — the deploy form asks for a value nothing reads, which either misleads ` +
          `the deployer or is a secret that was removed from the code`,
      })
    }

    for (const entry of example) {
      if (entry.value === '') continue
      // The value itself is deliberately not echoed. The one thing this violation
      // means is that a credential may be sitting in a committed file, and printing
      // it copies it into a terminal and into the CI log.
      violations.push({
        status: 'example-secret-has-value',
        message:
          `${entry.file} gives ${entry.name} a value — the Deploy form pre-fills from that file, ` +
          `so a shipped value becomes the default credential on every deployment that accepts ` +
          `it. Leave the right-hand side empty.`,
      })
    }
  }

  const descriptions =
    typeof manifest.cloudflare === 'object' && manifest.cloudflare !== null
      ? /** @type {{ bindings?: unknown }} */ (manifest.cloudflare).bindings
      : undefined

  // Every name the form will show, whether or not the code still reads it: a field
  // a deployer is asked to fill in needs an explanation regardless.
  for (const name of listed) {
    const entry =
      typeof descriptions === 'object' && descriptions !== null
        ? /** @type {Record<string, unknown>} */ (descriptions)[name]
        : undefined
    const description =
      typeof entry === 'object' && entry !== null
        ? /** @type {{ description?: unknown }} */ (entry).description
        : undefined

    if (typeof description === 'string' && description.trim() !== '') continue
    violations.push({
      status: 'undescribed-secret',
      message:
        `package.json has no \`cloudflare.bindings.${name}.description\` — the deploy form shows ` +
        `${name} as a bare field, and a deployer who does not already know what it is has to ` +
        `leave this repository to find out`,
    })
  }

  // And the converse, for secrets only. `description` is help text beside a form field,
  // so a *secret* that is not a field has none and its text is unreachable — which is
  // exactly what gets left behind when a secret moves out of the form, reading like
  // guidance that was given and seen by nobody.
  //
  // **Secrets only, and that is not a shortcut.** `cloudflare.bindings` describes every
  // binding type — "If you wish to provide additional information about bindings" —
  // and the D1 database *is* on the deploy form, so a `DB` description is legitimate
  // help text that this check must not reject. Found in review, where an earlier
  // version failed `pnpm check` on exactly that.
  //
  // Skipped when there is no example file at all: `no-example-secrets-file` above has
  // already said the one thing that matters, and repeating it once per description
  // buries it — the same reason that violation is reported once rather than per secret.
  if (anyExampleFile && typeof descriptions === 'object' && descriptions !== null) {
    for (const name of Object.keys(descriptions)) {
      if (listed.includes(name)) continue
      if (!secrets.some((secret) => secret.name === name)) continue
      violations.push({
        status: 'undisplayed-description',
        message:
          `package.json describes ${name}, and no example file lists it — that description is ` +
          `help text for a deploy-form field that does not exist, so no deployer will ever see ` +
          `it. If ${name} is set after the deploy instead, its instructions belong in ` +
          `${POST_DEPLOY_DOCS_FILE} where they can be read.`,
      })
    }
  }

  const scripts =
    typeof manifest.scripts === 'object' && manifest.scripts !== null
      ? /** @type {Record<string, unknown>} */ (manifest.scripts)
      : {}
  const deploy = expandScript(scripts, 'deploy')
  const bindings = d1Bindings(wrangler)

  if (deploy === null) {
    violations.push({
      status: 'no-deploy-script',
      message:
        'package.json has no `deploy` script, so a Deploy to Cloudflare build falls back to ' +
        '`npx wrangler deploy` and never applies migrations — the Worker goes live against an ' +
        'empty database',
    })
  } else if (bindings.length === 0) {
    violations.push({
      status: 'no-d1-binding',
      message:
        'wrangler.jsonc declares no D1 database, so the migration step in the `deploy` script ' +
        'cannot be checked against a binding name',
    })
  } else {
    const migrate = MIGRATE_COMMAND.exec(deploy)
    const deployStep = DEPLOY_COMMAND.exec(deploy)

    if (deployStep === null) {
      violations.push({
        status: 'deploy-does-not-deploy',
        message:
          'the `deploy` script never runs `wrangler deploy` — Cloudflare uses this script as the ' +
          'deploy command, so nothing would be published',
      })
    }

    if (migrate === null) {
      violations.push({
        status: 'deploy-skips-migrations',
        message:
          'the `deploy` script does not run `wrangler d1 migrations apply` — Cloudflare creates ' +
          'the D1 database during a one-click deploy but does not migrate it, and the first ' +
          'request to an unmigrated database fails',
      })
    } else {
      const target = migrate[1]
      const flags = migrate[2] ?? ''

      if (!bindings.includes(target)) {
        violations.push({
          status: 'migrates-wrong-target',
          message:
            `the \`deploy\` script migrates '${target}', which is not a D1 binding in ` +
            `wrangler.jsonc (${bindings.join(', ')}). Cloudflare's own instruction is to ` +
            `reference the binding name rather than the database name, because the deploy form ` +
            `lets a deployer rename the database.`,
        })
      }

      if (!/(^|\s)--remote(\s|$)/.test(flags)) {
        violations.push({
          status: 'migrates-locally',
          message:
            'the migration step in the `deploy` script has no `--remote`, so it applies to a ' +
            'local SQLite file in the build container and throws that container away',
        })
      }

      if (deployStep !== null) {
        if (deployStep.index < migrate.index) {
          violations.push({
            status: 'migrates-after-deploy',
            message:
              'the `deploy` script deploys before it migrates — a failed migration then leaves ' +
              'a live Worker serving a database it does not match, instead of a red build',
          })
        } else if (
          !stopsOnFailure(deploy.slice(migrate.index + migrate[0].length, deployStep.index))
        ) {
          violations.push({
            status: 'migration-failure-still-deploys',
            message:
              'the migration and the deploy in the `deploy` script are not joined by `&&`, so a ' +
              'failed migration still publishes the Worker — which is the failure the ordering ' +
              'exists to turn into a red build',
          })
        }
      }
    }
  }

  return { ok: violations.length === 0, collected: listed, violations }
}

const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (isCli) {
  const { ok, collected, violations } = await checkDeployConfig()

  for (const violation of violations) {
    console.log(`[${violation.status}] ${violation.message}`)
  }

  if (!ok) {
    console.error(
      `\ndeploy-config: ${violations.length} problem(s) with the one-click deploy setup.`,
    )
    process.exit(1)
  }

  // `collected` comes back from the check rather than being re-derived here. This file's
  // whole job is that "what the form asks for" has one definition, and a second parse of
  // the same files to print it would be the exact drift it exists to prevent.
  const names = (await declaredSecrets(process.cwd())).map((secret) => secret.name)
  const asked = names.filter((name) => collected.includes(name))
  const deprecated = names.filter((name) => DEPRECATED_SECRETS.includes(name))
  const afterwards = names.filter(
    (name) => !collected.includes(name) && !DEPRECATED_SECRETS.includes(name),
  )

  // Printed as three lists rather than one count, because which side a secret is on is
  // the decision #139 was about — and since #207 there is a third side — and it is the
  // thing worth seeing change in a diff of CI logs.
  console.log(
    `[ok] every secret src/ reads reaches the deployer.\n` +
      `     asked for by the deploy form, and described in package.json: ` +
      `${asked.join(', ') || '(none)'}\n` +
      `     set after the deploy, with a \`wrangler secret put\` line in ` +
      `${POST_DEPLOY_DOCS_FILE}: ${afterwards.join(', ') || '(none)'}\n` +
      `     deprecated: read only as a fallback, named but never instructed in ` +
      `${POST_DEPLOY_DOCS_FILE}: ${deprecated.join(', ') || '(none)'}\n` +
      `     the \`deploy\` script applies migrations to the D1 binding and stops if they fail`,
  )
}
