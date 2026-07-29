# Charcha documentation

> **Charcha is not usable yet.** These pages document the parts that are built and the
> contracts that are settled. Where something is decided but not yet implemented, it says
> so. Nothing here describes a feature that does not exist as though you could use it.
>
> The v1 plan is [issue #1](https://github.com/withsetu/charcha/issues/1).

## Available now

| Page | What it covers |
|---|---|
| [Will this stay free?](free-tier.md) | The Cloudflare free-tier ceilings in plain language, a worked example, and what breaks if you reach one |
| [Theming](theming.md) | The HTML and class names Charcha emits, how to style them, and the styling modes that are agreed but not yet built |
| [How a URL becomes a comment thread](thread-identity.md) | Which parts of a page address decide which thread a comment lands in, and how to name a thread yourself |

For reporting a security problem, see [SECURITY.md](../SECURITY.md). For running the
project locally, see the [README](../README.md).

## Not written yet, and why

These are the remaining parts of
[issue #17](https://github.com/withsetu/charcha/issues/17). Each is missing because the
feature it would document does not exist — writing instructions for them now would mean
describing software nobody can run.

| Topic | Waiting on |
|---|---|
| Installing via the Deploy button, in more depth than the [README](../README.md#deploying-it) covers | [#16](https://github.com/withsetu/charcha/issues/16) — the deploy flow. The button, the secrets it collects and the migration step are built; nobody has run a real deploy yet, so a page written now could not describe what a deployer actually sees |
| Adding the embed to Astro, Hugo, Eleventy, Jekyll and plain HTML | [#5](https://github.com/withsetu/charcha/issues/5) — the embed script |
| Configuring spam defence, and what each optional provider transmits | [#8](https://github.com/withsetu/charcha/issues/8), [#11](https://github.com/withsetu/charcha/issues/11) |
| Migrating from Disqus | [#15](https://github.com/withsetu/charcha/issues/15) — the importer |
| Moderating comments | [#13](https://github.com/withsetu/charcha/issues/13) — the dashboard |

## What already works, if you are reading the code

Two things are built and reachable, which is why the pages above can be written honestly:

- **`POST /comments`** accepts a comment. It validates and size-caps every field, derives
  the thread key itself rather than trusting the request, and returns the rendered
  comment as HTML. The status code carries the outcome so a client never has to parse a
  message to tell success from failure: `201` published, `202` accepted and awaiting
  review, `400` rejected by validation, `403` rejected as spam, `413` body too large.
- **`GET /health`** answers `200 {"status":"ok","database":"ok"}` only if the Worker is
  running *and* its database has the `comments` table in it. The two failures are
  separated because their fixes are: `503 {"status":"degraded","database":"unmigrated"}`
  means the database is there and the migrations are not, and
  `503 {"status":"degraded","database":"unreachable"}` means the binding itself refused.
  Asking whether a table exists rather than whether a query runs is the whole point — a
  one-click deploy can leave a database that answers `select 1` and nothing else
  ([#141](https://github.com/withsetu/charcha/issues/141)). It looks for the table the
  first migration creates, so it does not prove that a later one ran
  ([#149](https://github.com/withsetu/charcha/issues/149)).

New comments are held for review by default. The queue they land in is real; the
interface for working through it is [#13](https://github.com/withsetu/charcha/issues/13).

## A note on the spam defence, since it shapes the docs above

Charcha's spam layers run locally and transmit nothing by default: a honeypot field, a
time-to-submit check, Turnstile, rate limits, content heuristics, and a classifier
trained on the site's own moderation decisions. Optional third-party providers are
**off by default**, because enabling one means sending commenter data — IP address,
email, comment text — to a company that is not you, which the site owner then has to
disclose.

One of those layers is worth singling out. Every layer but Turnstile measures the
*absence* of something wrong — an untouched honeypot, more than two seconds spent typing,
not too many links — and a script written against the form passes all of them. Turnstile
is the only one that asks for evidence: a token a browser has to earn by solving a real
challenge. It is off until the site owner configures it, and the
[README](../README.md#turning-on-the-optional-features) recommends configuring it, in the
two places it has to be set.

When that configuration ships, its documentation will state exactly what each provider
receives, before the switch that turns it on. That ordering is a commitment, not a
formatting preference.
