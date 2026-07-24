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
  anything that appears to need reader-side storage needs a different design.
- **Invisible on the page** — the widget inherits the host site's typography and
  colours, including dark mode.
- **Spam defence that runs locally** — layered heuristics and an on-device
  classifier by default. Third-party spam services are optional and off by
  default, because they mean sending reader data elsewhere.

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

## Troubleshooting a deploy

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
