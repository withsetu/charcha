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
- **No cookies** — nothing is stored in the reader's browser by default, so a site
  using Charcha has nothing new to disclose.
- **Invisible on the page** — the widget inherits the host site's typography and
  colours, including dark mode.
- **Spam defence that runs locally** — layered heuristics and an on-device
  classifier by default. Third-party spam services are optional and off by
  default, because they mean sending reader data elsewhere.

## Status

| | |
|---|---|
| v1 plan | [#1](https://github.com/withsetu/charcha/issues/1) |
| Issues | https://github.com/withsetu/charcha/issues |
| Site | https://charcha.dev |

## License

MIT
