# Charcha — operating manual for AI sessions

Charcha is self-hosted comments for static sites: a single Cloudflare Worker the
site owner deploys to their **own** Cloudflare account in one click. This file is
the contract for how you work here.

**This file is public.** Engineering only — no strategy, positioning, or
monetisation reasoning in it, or in any issue or PR.

## The card — non-negotiables

1. **Issue first.** No dev work without an issue on `withsetu/charcha`. Branch,
   commits and PR all cite it.
2. **Never commit to `main`.** Branch off fresh `origin/main`, ship by push + PR.
   The owner does final UAT before merge — never merge on green tests yourself.
3. **Green tests are never "done".** Done = driven for real + matches the agreed
   design + no skeletons.
4. **The embed budget is 10 KB gzipped, and it is a hard limit.** It ships on
   other people's sites. CI enforces it. If a feature does not fit, the feature
   changes — not the budget.
5. **Every comment is untrusted input.** This project's primary surface is a
   public, unauthenticated write endpoint. Zod at the boundary, size caps
   everywhere, sanitise before render, fail closed.
6. **Kill-shot every security-relevant test.** Disable the guard, confirm the test
   actually fails, restore. Paste the result in the PR. A security test only fires
   on the attack path, so a broken one is silent forever and reads as coverage.
7. **Verify platform facts on the web, never from memory** — Cloudflare limits,
   pricing, API shapes, npm licences. Cite what you checked.
8. **No reader-side cookies, ever.** Design goal, disclosure promise, and a
   constraint on every feature. If something seems to need one, it needs a
   different design.

## Verified platform facts

Re-verify before relying on these; they were checked on the date shown.

| Fact | Value | Checked |
|---|---|---|
| D1 free tier | 5M rows read/day, 100k rows written/day, 5 GB storage | 2026-07-23 |
| Workers AI free tier | 10,000 neurons/day (Free *and* Paid plans) | 2026-07-23 |
| Workers AI embeddings | ~1,075 neurons per 1M input tokens | 2026-07-23 |
| Akismet paid tier | $9.95/mo for **500 checks/month** | 2026-07-23 |
| CleanTalk | ~$12/year per site | 2026-07-23 |
| StopForumSpam | free, 100k queries/day, **non-commercial terms** | 2026-07-23 |
| Deploy button | repo must be **public and self-contained**; Cloudflare treats the deploy root as the new repo root | 2026-07-23 |
| Bot score (`cf.botManagement.score`) | **Enterprise only** — cannot be built on | 2026-07-23 |

## Architecture, and the decisions that are load-bearing

- **Runtime** — one Cloudflare Worker (Hono). **Storage** — D1.
- **Notifications** — Resend, optional.
- **Moderation dashboard** — React + shadcn/ui, served from the same Worker.
- **Embed** — vanilla JS, no framework.

### The Worker returns HTML, not JSON

Comment rendering is a single pure function emitting an HTML string. The embed is
`fetch` + `innerHTML`, which is most of how the 10 KB budget is met.

This exists for a v1.1 reason: server-side rendering of comments (below) calls the
*same* function from a different place. Ship JSON plus client-side DOM building and
the renderer gets written twice, turning the SEO work into a rewrite.

Enforced by: `#4`. If you are about to add a JSON comment-rendering endpoint, stop.

### Spam defence is layered, and the ordering is the design

Third-party spam services are metered — Akismet allows 500 checks/month on its paid
tier. External providers therefore run **last**, seeing only what the free local
layers could not decide. Order:

1. Honeypot field
2. Time-to-submit heuristic (under ~2s is not a human)
3. Turnstile (free, unmetered, invisible)
4. Rate limiting, per IP and per thread
5. Content heuristics — link count, duplicate body, known patterns
6. Workers AI classifier, self-trained on this site's own moderation decisions
7. Optional third-party provider behind `SpamProvider`
8. Moderation queue — the human gate

Layers 1–6 are on by default, run locally, transmit nothing. **Layer 7 is opt-in
and off by default**, because it means sending commenter IP, email and content to a
third party — which the site owner then has to disclose. Any UI enabling a provider
must state plainly what is sent and to whom, *before* the toggle.

### The moderation inbox trains the classifier

Every approve/spam decision is a labelled example. Comments are embedded via
Workers AI and stored with their label; new comments classify by similarity. Cold
start must **abstain**, not guess.

### v1.1 — server-rendered comments

Comments delivered only by client-side JS are crawled inconsistently, and most AI
crawlers do not execute JS at all. Two paths, both reusing the v1 renderer:
`HTMLRewriter` injection for Cloudflare-proxied sites, and a build-time API for
everyone else. schema.org `Comment` JSON-LD rides along.

Out of v1 — but v1 must not preclude it. See the HTML-not-JSON decision.

## Conventions

- **TDD.** Failing test first. Tests run in `workerd` via
  `@cloudflare/vitest-pool-workers`, not node — a Worker that passes under node
  proves very little.
- **Unawaited async must report its own failure.** `void asyncThing()`, `.then()`
  chains, async event handlers and async effect IIFEs all discard rejections. A
  `try`/`finally` with no `catch` is the same bug wearing a seatbelt: the spinner
  stops, the failure vanishes. Every such call site owes the user a specific
  message and, where they are waiting on state, an error state distinguishable
  from *empty*. A loading skeleton that never resolves is an unreported failure.
- **A comment stating an invariant must name the test that enforces it** — a
  literal path, `test/foo.test.ts`, not an issue number — **or be worded as intent**
  ("intended to …") rather than fact. A comment asserting a property the adjacent
  code does not enforce does not merely fail to help; it *suppresses the check*,
  because it sits exactly where a reader goes to verify that property.
- **Reuse before building.** Grep first. Never hand-roll a worse copy of something
  that exists.
- **Dashboard controls come from shadcn/ui.** A missing control is a signal to add
  it via the registry, not to invent one.
- **Deferred scope becomes a labelled issue in the same session.** Never a TODO
  comment.

## Relationship to Setu

Charcha is standalone. It knows nothing about [Setu](https://github.com/withsetu/setu)
and must never depend on it — it has to work for any static site, on any generator.
Integration runs one way only: Setu points at a Charcha deployment.

Setu's conventions are the ancestor of this file, but Charcha's constraints differ —
one Worker rather than three topologies, a hard bundle budget, and untrusted public
input as the primary surface rather than an authenticated admin. Do not import
Setu's rules wholesale; the ones that apply are written out above.

## Where things are

`npm run check` is the whole gate — types, typecheck, lint, format, tests, embed
budget — and is exactly what CI runs. Run it before you push.

| Thing | Where |
|---|---|
| Worker entry | `src/index.ts` — the Hono app |
| Wrangler config | `wrangler.jsonc` — D1 binding `DB`, database `charcha` |
| Binding types | `src/worker-configuration.d.ts`, generated by `npm run types`; CI fails if it drifts |
| Worker tests | `test/worker/**` — run in workerd, with real bindings |
| Build-tooling tests | `test/node/**` — node, for things that touch the filesystem |
| Embed budget check | `scripts/bundle-size.mjs`, `npm run check:size` |
| CI | `.github/workflows/ci.yml` |
| Design & plans | The GitHub issue. Never committed spec files. |
| v1 epic | [#1](https://github.com/withsetu/charcha/issues/1) |

The embed budget check has nothing to weigh until [#5](https://github.com/withsetu/charcha/issues/5)
writes `src/embed/`, so it says so out loud and turns itself on the moment that
directory exists — a green check that silently enforces nothing looks identical to
one that does.
