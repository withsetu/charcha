# Charcha

Self-hosted comments for static sites. Deploys to your own Cloudflare account in
one click, runs inside the Cloudflare free tier, and requires no account from
readers in order to comment.

> **Status: early development.** Nothing here is usable yet. The v1 plan is
> [issue #1](https://github.com/withsetu/charcha/issues/1).

## What it is

- **Zero ops** — one click to deploy, resources auto-provisioned. No server, no
  database to administer.
- **Free to run** — a typical blog stays inside the Cloudflare free tier
  indefinitely.
- **No reader accounts** — a name and an optional email. No sign-up, no social
  login.
- **No cookies, ever** — nothing is stored in the reader's browser at all, so a site
  using Charcha has nothing new to disclose. Not a default that can be switched:
  anything that appears to need reader-side storage needs a different design. The one
  thing that can put a third party in the page is Cloudflare Turnstile, which is off
  until you configure it and is [documented plainly](docs/theming.md#turnstile) when
  you do.
- **Invisible on the page** — the widget inherits the host site's typography and
  colours, including dark mode.
- **Spam defence that runs locally** — layered heuristics and an on-device
  classifier by default. Third-party spam services are optional and off by
  default, because they mean sending reader data elsewhere.

## Deploying it

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/withsetu/charcha)

> **Nobody has run this yet.** The button, the secrets it collects and the migration
> step are all built and asserted by `pnpm check`, but a Deploy-to-Cloudflare build
> runs on Cloudflare's infrastructure against a real account, and no such build has
> happened. [#16](https://github.com/withsetu/charcha/issues/16) tracks the first
> one. Until then, treat this section as the intended path rather than a walked one.

Cloudflare clones this repository into your own GitHub or GitLab account, creates
the D1 database, asks you for the secrets below, builds, and deploys. You end up
with a Worker on `your-worker.your-subdomain.workers.dev` and a repository you can
keep developing from — later pushes to it redeploy.

### The secrets it asks for

One is required. The other two switch a defence layer off when they are absent
rather than failing, because an owner who skips a step should get a site that takes
comments, not a broken comment form.

| Secret | Required? | What it is, and what happens without it |
|---|---|---|
| `CHARCHA_DASHBOARD_PASSWORD` | **Yes** | The only credential for the moderation dashboard at `/admin`. No account, no reset, and no second user. Generate it — `openssl rand -base64 24`. Unset, the dashboard **refuses every request including its own login**: comments still arrive and nobody can moderate them. |
| `IP_HASH_SECRET` | Recommended | The key that turns a commenter's IP into the identifier the per-IP spam rate limit counts — `openssl rand -hex 32`. Unset, no IP is stored at all and the per-IP half of the rate limit stops running; the per-thread half still does. |
| `TURNSTILE_SECRET_KEY` | No | The *secret* key of a [Turnstile](https://developers.cloudflare.com/turnstile/get-started/) widget, if you want the invisible bot check. The matching sitekey is public and goes on your own page as `data-turnstile-sitekey`. Unset, Turnstile is off and nothing third-party is loaded into your readers' browsers. |

They are declared in [`.dev.vars.example`](.dev.vars.example), which is the file the
deploy form is built from, with the help text beside each field coming from
`cloudflare.bindings` in `package.json`. Both are Cloudflare's
[documented mechanism](https://developers.cloudflare.com/workers/platform/deploy-buttons/).
`pnpm check:deploy` fails if a secret the code reads is absent from that file, and if
a field the form would show has no description — a required secret the form never
asks for is exactly how a deploy produces a Worker that cannot be administered.

### Setting or changing a secret afterwards

Nothing about the deploy form is a one-time chance. From a checkout of your
deployed repository:

```sh
pnpm wrangler secret put CHARCHA_DASHBOARD_PASSWORD
```

Or in the Cloudflare dashboard, in your Worker under **Settings → Variables and
Secrets**. Changing the dashboard password also signs out every open session, because
sessions are signed with a key derived from it rather than stored.

### Deploying from a terminal instead

```sh
pnpm install
pnpm wrangler d1 create charcha    # then put the returned id in wrangler.jsonc
pnpm run deploy                    # applies migrations, then deploys
pnpm wrangler secret put CHARCHA_DASHBOARD_PASSWORD
```

`pnpm run deploy` and not `pnpm deploy` — the latter is pnpm's own built-in
workspace-deploy command, which shadows the script and does something else entirely.

That script is deliberately not just `wrangler deploy`: Cloudflare creates the D1
database but never migrates it, so the migration runs first and a failure there stops
the deploy instead of publishing a Worker that queries an empty database.

## After it deploys

Open the Worker URL Cloudflare gives you. `/` answers with a short page saying Charcha
is running. That is the whole of what it says, and it is deliberate: the address is
public and unauthenticated, so it reports no database state, no configuration, no
comment counts and not even where your dashboard is. A page that told a passing scanner
that your deployment was half-broken and where its login was would be doing the
scanner's work for it. Everything you actually need is here instead, in a README that
is not published per deployment.

Then three things, none of which take long:

1. **Sign in to the dashboard**, at `/admin` on the same address —
   `https://your-worker.example.workers.dev/admin`. The password is
   `CHARCHA_DASHBOARD_PASSWORD`.
2. **Open Allowed origins** and add your site's address — `https://example.com`, scheme
   included, no trailing path. Until you do, comments from your site are refused; a
   fresh deployment starts out allowing only its own address.
3. **Paste [the snippet](#adding-it-to-a-page) into your page**, with your Worker's
   address in place of the example one.

If you want to check the deployment from a script rather than a browser, `/health`
answers JSON, and it distinguishes the three states that matter:

| | |
|---|---|
| `200 {"status":"ok","database":"ok"}` | Running, and the migrations have been applied. |
| `503 {"status":"degraded","database":"unmigrated"}` | The database exists and Charcha's tables do not. This is what a deploy whose migration step failed looks like — see [the troubleshooting entry](#troubleshooting-a-deploy) for `no such table: comments`. |
| `503 {"status":"degraded","database":"unreachable"}` | The D1 binding itself refused the query. |

The middle row is why the endpoint changed: it used to run `select 1`, which an
unmigrated database answers perfectly, so it reported `ok` on the one failure a
one-click deploy actually produces
([#141](https://github.com/withsetu/charcha/issues/141)). `database: "error"` no longer
appears; `unreachable` replaced it.

### Allowed origins, and why a comment can be refused

Charcha only accepts comments from pages on addresses you have listed. A page anywhere
else gets:

```
HTTP 403
That origin is not allowed to comment on this site.
```

That list lives in **your Charcha dashboard**, under **Allowed origins**. It is
**not** Turnstile's *Hostname Management* screen — that one governs where the Turnstile
widget may render, and editing it does nothing here. The two are easy to confuse and
have been ([#57](https://github.com/withsetu/charcha/issues/57)).

A fresh deployment starts with an empty list and still works: **your Worker's own
address is always allowed**, without being listed and without anything being written to
the database. That is what makes a one-click deploy usable before you have touched any
setting — but your site is a different address, so it has to be added.

## Adding it to a page

```html
<div id="charcha"></div>
<script src="https://your-worker.example.workers.dev/embed.js" defer></script>
```

That is the whole integration. Replace the example address with your own Worker's — the
one Cloudflare gave you, the same one you signed in to `/admin` on. `embed.js` is under
7 KB gzipped, ships no framework and no Markdown parser, and is served as a static asset
so it costs your deployment nothing against the Cloudflare request budget.
[Theming](docs/theming.md) covers the attributes, the class names and the three styling
modes.

## Documentation

Written for the parts that exist; [docs/](docs/) says plainly what is not built yet.

- [Will this stay free?](docs/free-tier.md) — the free-tier ceilings in plain
  language, with a worked example
- [Theming](docs/theming.md) — the HTML and class names Charcha emits, and how to
  style them
- [How a URL becomes a comment thread](docs/thread-identity.md) — which parts of a
  page address decide where a comment lands

Reporting a security problem: [SECURITY.md](SECURITY.md). Please do not open a public
issue for one — this repository is public and every installation runs in someone
else's Cloudflare account.

## Status

| | |
|---|---|
| v1 plan | [#1](https://github.com/withsetu/charcha/issues/1) |
| Issues | https://github.com/withsetu/charcha/issues |
| Site | https://charcha.dev |

## Development

Requires Node 22 (see `.nvmrc`) and pnpm, which `package.json` pins with
`packageManager` — `corepack enable` is enough to get the right version.

```sh
pnpm install
pnpm dev     # wrangler dev, with a local D1
pnpm check   # types, typecheck, lint, format, tests, embed budget — what CI runs
```

**pnpm, not npm.** `npm install` here writes a `package-lock.json` that records
only the platform it ran on: resolving on macOS drops the Linux-only packages CI
needs, and CI is where that surfaces. `pnpm check` fails if a foreign lockfile
appears. Background on
[issue #52](https://github.com/withsetu/charcha/issues/52).

Tests run inside the Workers runtime via `@cloudflare/vitest-pool-workers`, against
the same bindings the deployed Worker gets.

Set your local secrets in a `.dev.vars` file — it is gitignored, and it is the only
way to give `wrangler dev` a `CHARCHA_DASHBOARD_PASSWORD` to sign in to the dashboard
with. Having one does **not** put `pnpm check` into a failing state: both `pnpm types`
and `pnpm types:check` pass `--env-file /dev/null`, so type generation reads the
Wrangler config and nothing else. Without that flag, `wrangler types` folds the keys of
your `.dev.vars` into the generated `Env`, `types:check` reports the committed types as
stale when nothing about them is, and regenerating writes your own secret names into
`src/worker-configuration.d.ts` as though they were part of the binding contract
([#132](https://github.com/withsetu/charcha/issues/132)).

## Troubleshooting a deploy

**Visiting the Worker URL used to answer `Not found`.** It does not any more — `/` says
Charcha is running, and nothing about your deployment, for the reasons
[above](#after-it-deploys). If you are on a version that predates it, the deployment was
almost certainly fine: check `/health` and `/admin`.

**Every comment is refused with `That origin is not allowed to comment on this site.`**
Your site's address is not in **Allowed origins**. Add it in the dashboard at `/admin`
— scheme included, no trailing path, one per line. See
[Allowed origins](#allowed-origins-and-why-a-comment-can-be-refused) for why this is
not Turnstile's hostname list, which is the wrong screen and the one people find first.

**The dashboard returns 401 on every page, including the login.** The deployment
has no `CHARCHA_DASHBOARD_PASSWORD`. That is the designed behaviour rather than a
bug — an unconfigured dashboard is a locked one, not an open one — but it is
indistinguishable from a wrong password by design, because a login endpoint that
tells you which of the two it was tells an attacker whether the door exists. The
Worker's logs say which: look for a line with `guard: dashboard-password`. It is
emitted **once per isolate**, not once per request, so if you started tailing logs
after the first failed request you may have to wait for a cold start or redeploy to
see it. The fix is `pnpm wrangler secret put CHARCHA_DASHBOARD_PASSWORD`, or the
same field under
**Settings → Variables and Secrets** in the dashboard. Comments arriving in the
meantime are not lost; they are held in the queue.

**Every request fails, and the log says `no such table: comments`.** The database
exists and the migrations did not run. `/health` says so without needing the logs —
`{"status":"degraded","database":"unmigrated"}`. Read the build log for the
`wrangler d1 migrations apply DB --remote` line that `pnpm run deploy` runs before
deploying, and note that this failure is quieter than it should be: `wrangler d1
migrations apply` is known to exit non-zero with no useful output when the token it
is using lacks D1 permissions
([workers-sdk#5077](https://github.com/cloudflare/workers-sdk/issues/5077),
[wrangler-action#221](https://github.com/cloudflare/wrangler-action/issues/221)).
That is a live possibility here, not a theoretical one: the API token Workers Builds
creates for itself is documented as carrying Account Settings (read), Workers Scripts
(edit), Workers KV Storage (edit) and Workers R2 Storage (edit) — **D1 is not on that
list**
([build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/),
checked 2026-07-25). If the migration step is what failed, add **D1 (edit)** to that
token under **My Profile → API Tokens**, or apply the migrations once from a
terminal with `pnpm db:migrate:remote` and redeploy. Migrations run before the
deploy specifically so this shows up as a red build rather than as a live Worker
that 500s.

**The build fails on `pnpm deploy` with pnpm's own usage text.** Cloudflare
pre-populates the deploy command from the `deploy` script in `package.json`, and
`pnpm deploy` is a built-in pnpm command — `pnpm deploy --help` prints
`Usage: pnpm --filter=<deployed project name> deploy <target directory>`, checked
against pnpm 10.34.5 — which shadows the script rather than running it. Set the
deploy command to `pnpm run deploy` (or `npm run deploy`) under **Settings → Build**.

**The deploy fails mentioning the rate limiting binding.** Charcha uses the
[Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
to bound brute-force attempts against the dashboard login. It is GA, needs no
provisioning, and **whether it is available on the Workers Free plan is documented
nowhere** — not on the binding page, not on the
[bindings index](https://developers.cloudflare.com/workers/runtime-apis/bindings/),
and not in the Free-vs-Paid table on the
[pricing page](https://developers.cloudflare.com/workers/platform/pricing/), which
covers ten other products and does not mention rate limiting at all (all checked
2026-07-25). We are recording that we do not know rather than guessing;
[#119](https://github.com/withsetu/charcha/issues/119) is the issue, and the first
real deploy settles it. **If your deploy is what settles it, please say so on that
issue** — you will have found out something Cloudflare's documentation does not say.

There is no good workaround to offer you yet, and pretending otherwise would be
worse than saying so. Deleting the `ratelimits` block from `wrangler.jsonc` makes the
deploy succeed, but the login throttle then refuses **every** login attempt rather
than allowing them unguarded, so the dashboard stays shut. Comments are still
accepted and still queued the whole time, so nothing is lost while
[#124](https://github.com/withsetu/charcha/issues/124) picks a throttle that does not
depend on the binding. The obvious candidate is closed off, and the reason is worth
knowing before anyone suggests it: the Cache API is documented as "not currently
available" for Workers behind Cloudflare Access, and its availability sentence lists
custom domains and `*.pages.dev` while omitting `*.workers.dev`
([Cache](https://developers.cloudflare.com/workers/runtime-apis/cache/), checked
2026-07-25). The second half is an inference rather than a statement, and it is the
wrong thing to bet a security guard on either way — a counter that silently counts
nothing is worse than no counter, because it looks like one.

**pnpm version mismatch.** `pnpm-lock.yaml` is written by the pnpm that
`package.json` pins with `packageManager`, but a Cloudflare deploy does not use
that pin — Workers Builds installs the pnpm its build image ships, and there is
no repo-side way to change it. Both are on pnpm 10.x writing
`lockfileVersion: '9.0'`, so this is expected to be fine. It is written down
because if it ever is not, the build does not go red. `pnpm check` asserts both
halves — that the pin stays on a major the image runs, and that the lockfile
stays in a format that major writes — so this repository cannot drift off the
image quietly. What that gate cannot see is the image moving underneath it,
which is why the rest of this section exists. pnpm **ignores** a
lockfile it considers incompatible and resolves dependencies fresh, so a green
build can have installed a tree nobody locked or tested. Read the build log for:

```
 WARN  Ignoring not compatible lockfile at /path/to/pnpm-lock.yaml
```

The variants that do fail the build, listed so they are greppable:

```
ERR_PNPM_OUTDATED_LOCKFILE
ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE
  Cannot perform a frozen installation because the lockfile needs updates
Cannot install with "frozen-lockfile" because pnpm-lock.yaml is absent
```

The fix for any of them is to set the build's pnpm version explicitly: in the
Cloudflare dashboard, **Settings → Build → Build Variables and Secrets**, add
`PNPM_VERSION` with the version from `packageManager`. That variable is the only
lever pnpm has there — there is no `.nvmrc` equivalent for it, and build
configuration in `wrangler.jsonc` is not read. Nobody has deployed Charcha yet
([#16](https://github.com/withsetu/charcha/issues/16)), so none of this has been
exercised; it is a contingency written before it is needed rather than after.

## License

MIT
