# Security policy

Charcha accepts comments from the public internet without authentication, and every
installation runs in someone else's Cloudflare account. Those two facts shape this
whole document.

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting.** Go to the
[Security tab](https://github.com/withsetu/charcha/security/advisories/new) and choose
**Report a vulnerability**. It is enabled on this repository, and the report is visible
only to the maintainer until an advisory is published.

**Please do not open a public issue for a security problem.** This repository is public
and has to stay public — the Cloudflare Deploy button requires it — so a public report
is a working exploit handed to everyone, aimed at every live deployment, before there
is a fix for any of them. Ordinary bugs are welcome as public issues; this is the one
category that is not.

If private reporting is unavailable to you for any reason, say so in a public issue
**without the details** — "I have a security report and cannot use private reporting" —
and a private channel will be arranged.

## What to expect

Charcha is maintained by one person. These are honest numbers, not a service-level
agreement:

| | |
|---|---|
| First response | within 7 days |
| Assessment and severity | within 14 days of the first response |
| Fix for a confirmed high-severity issue | as fast as it can be done properly |
| If you have heard nothing in 14 days | assume it did not reach me, and chase it |

You will be credited in the advisory unless you ask not to be. If a report turns out
to be a non-issue, you will get an explanation rather than silence.

Please give a fix a reasonable window before publishing. There is no bounty programme.

## Scope

**In scope** — anything that ships from this repository and runs in a deployment:

- The Worker: request handling, the comment submission endpoint, validation
- The comment renderer and its HTML escaping and Markdown subset — this is the code
  that turns untrusted comment text into HTML on somebody's page
- Thread-key derivation from a reported URL
- Database schema and migrations, including the constraints and triggers
- The embed, once it exists, and anything it does in a reader's browser
- The moderation dashboard and its authentication, once they exist
- Supply-chain configuration in this repository: CI workflow permissions, action
  pinning, dependency and licence policy

Findings that are especially welcome, because they are what this project is most
likely to get wrong:

- Cross-site scripting through comment content, author names, or the Markdown subset
- Any input that reaches the database without passing validation
- A way to publish a comment without moderation, or to read comments that are not
  approved
- A way to make one page's comments appear on another page
- Anything that lets a commenter's IP, email address, or IP hash reach a reader

**Out of scope:**

- A deployment's own Cloudflare account configuration, secrets, DNS, or access control
- Third-party services an owner has opted into (spam providers, email delivery) — report
  those to the service
- Vulnerabilities in dependencies that are already public advisories: those are handled
  by dependency updates, not by a report here. A dependency issue **not** yet public is
  in scope
- Volumetric denial of service. Charcha's ceilings are Cloudflare's free-tier limits and
  are documented in [docs/free-tier.md](docs/free-tier.md); exhausting them with traffic
  is a known property, not a vulnerability. A way to exhaust them *cheaply and
  asymmetrically* — one small request costing a disproportionate amount of the daily
  budget — **is** in scope
- Self-XSS, missing hardening headers with no demonstrated impact, and reports produced
  by a scanner with no working proof

## The part that makes this project different: a fix here does not fix your site

Charcha is self-hosted. Every installation is a separate Cloudflare Worker in a separate
account, put there by the owner. **Patching this repository changes nothing about any
running deployment.** There is no central service to update, and no automatic update
mechanism.

So an advisory here is only half of a fix. The other half is every owner redeploying.

**If you run Charcha and an advisory is published, you have to redeploy to get the fix.**
Until you do, your deployment still has the vulnerability, no matter what the repository
says.

Today, nothing tells you an advisory exists — you have to be watching this repository.
That is a real gap, and it is tracked in
[issue #43](https://github.com/withsetu/charcha/issues/43), which proposes surfacing new
releases in the moderation dashboard. Until it ships, the only reliable route is to
**watch this repository** (Watch → Custom → Security alerts) so GitHub emails you when an
advisory is published.

## How advisories are published

Confirmed vulnerabilities are published as
[GitHub Security Advisories](https://github.com/withsetu/charcha/security/advisories).
Each advisory states the affected versions, the severity, what an attacker could do, and
— because of the above — **what a self-hoster must do to get the fix**, in plain terms.

## Security practices in this repository

Stated so a reporter knows what is already covered:

- Every comment is treated as untrusted input; validation happens at the request
  boundary with size caps, and the schema enforces its own caps independently
- Comment HTML is built by escaping first and composing escaped fragments, rather than
  by sanitising generated HTML
- Security-relevant tests are verified by disabling the guard and confirming the test
  actually fails, because a security test that cannot fail is indistinguishable from no
  test at all
- CI blocks on dependency advisories, enforces a licence policy, and pins GitHub Actions
  to full commit SHAs
- Secret scanning and push protection are enabled on the repository
