# Third-party spam checking, and what it sends

Charcha's spam defence is eight layers deep. **Seven of them run inside your Worker and
transmit nothing about your readers to anyone.** The eighth sends a comment to a
company that is not you, and it is off until you switch it on.

This page is about the eighth. It states what leaves your Worker before it states how to
turn it on, which is the order that matters
([#11](https://github.com/withsetu/charcha/issues/11)).

## The short version

| | |
|---|---|
| Who | [Akismet](https://akismet.com), run by Automattic |
| Default | **Off.** Nothing is asked for at deploy time and nothing is sent until you set two values |
| What it can do | Hold a comment for review. It can never refuse one — see [below](#it-can-only-hold-a-comment-never-refuse-one) |
| What it costs | Akismet's Pro plan is "$9.95 per month, billed yearly" for "500 spam calls/mo, up to 1 site"; Business is "$49.95 per month, billed yearly" for "5000 monthly spam checks". The Personal plan is pay-what-you-can and requires that your site has no ads, sells nothing and promotes no business ([pricing](https://akismet.com/pricing/), [personal](https://akismet.com/pricing/personal/), checked 2026-07-29) |
| Where it runs | Last. It only ever sees comments the seven free layers could not decide |

## What is sent to Akismet

Every comment that reaches layer 8 is posted to Akismet's `comment-check` endpoint with:

| Field | What it is |
|---|---|
| `user_ip` | **The commenter's IP address**, in full. Not the hash Charcha stores — the address itself. This is one of Akismet's three required parameters, so it cannot be left out |
| `comment_author` | The name they typed |
| `comment_author_email` | Their email address, **only if they gave one**. The field is optional in Charcha and omitted entirely when it is blank |
| `comment_content` | The full text of the comment |
| `user_agent` | Their browser's user-agent string |
| `referrer` | The page their browser said they came from |
| `permalink` | The page they commented on, built from your site's address setting |
| `comment_type` | `comment` or `reply` |
| `comment_date_gmt` | When it was submitted |
| `blog` | Your site's home page URL |
| `api_key` | Yours, not theirs |

**Nothing else.** Akismet documents a dozen further parameters — `comment_author_url`,
`user_role`, `blog_lang`, `honeypot_field_name`, `comment_context`, and the whole of a
PHP request's `$_SERVER` — and Charcha sends none of them. The list above is built as a
literal in `src/spam/akismet.ts` rather than assembled from whatever happens to be
available, so a field cannot arrive there by accident, and
`test/worker/spam/akismet.test.ts` fails if the list changes.

Akismet says it keeps spam-related data for "between two weeks and ninety days for the
vast majority", and that it does not sell it
([privacy policy](https://akismet.com/privacy/), checked 2026-07-29). That is their
statement, not ours, and it is theirs to change.

### The sentence for your privacy notice

If your site has one, this is the paragraph this feature obliges you to add:

> Comments submitted on this site are checked for spam by Akismet, a service run by
> Automattic. Akismet receives the commenter's IP address, name, email address if one was
> given, the text of the comment, their browser's user-agent string and the page they
> were referred from. See [Akismet's privacy policy](https://akismet.com/privacy/).

**It also applies to the reader who never gets a comment published**, which is easy to
miss: the check happens before the comment is stored, so a comment you later delete has
already been sent.

## Turning it on

Two values, both together or the feature stays off. One is a credential:

```sh
pnpm wrangler secret put AKISMET_API_KEY
```

`AKISMET_API_KEY` comes from your account at [akismet.com](https://akismet.com/account/).

**Your site's address is the other half, and it is not a secret** — fill in *Your site's
address* under **Setup** in your Charcha dashboard. (`CHARCHA_SITE_URL` is still read on a
deployment that set it before that field existed, and only until the field is saved.) It
is your home page — `https://example.com`, or
`https://you.github.io/blog` if your site lives at a path. It is not optional and it is
not guessable: Akismet requires it, matches it against the sites authorised on your key,
and Charcha has nowhere else to get it from. Your Worker's own address is a
`workers.dev` URL rather than your site, and the URL the embed reports is chosen by
whoever posted the comment, so neither can stand in for it.

Setting one without the other does **not** half-enable anything. The layer stays off, and
your Worker's log carries one line saying which half is missing — the same shape of
mistake as [#104](https://github.com/withsetu/charcha/issues/104), which is why it is
announced rather than ignored.

## Turning it off

Unset `AKISMET_API_KEY`. Nothing else changes: the other seven layers do not know layer 8
exists, comments carry on arriving, and your moderation queue is unaffected.

```sh
pnpm wrangler secret delete AKISMET_API_KEY
```

## It can only hold a comment, never refuse one

Whatever Akismet answers, the worst that happens to a comment is that it is **held for
review** with `provider: akismet` as its reason in your moderation queue. Charcha never
refuses a comment on a third party's say-so, for three reasons:

- It is a probability, not a rule. A comment Charcha's honeypot catches is caught by
  something you can read and check. A comment Akismet flags is flagged by a model neither
  of us can inspect, about a site it does not know.
- A refused comment is never stored, so nobody ever finds out it was wrong. A held one is
  sitting in your queue, where you can disagree with it in one click.
- The same rule already applies to Charcha's own classifier
  ([#10](https://github.com/withsetu/charcha/issues/10)), which is trained on *your*
  moderation decisions. It would be strange to trust a stranger's judgement more than
  your own.

Akismet can additionally answer `X-akismet-pro-tip: discard`, meaning "blatant spam, safe
to throw away". Charcha still only holds those — the reason token reads
`provider: akismet-discard` so you can triage them first, and that is all the difference
it makes. Acting on it would mean layer 8 could refuse comments, which would in turn mean
it could no longer be skipped for a comment some earlier layer already held — and that
skip is what stops an anonymous visitor spending your monthly allowance on answers nobody
reads.

## What happens when Akismet is down

Nothing, from your reader's point of view. Layer 8 fails **open**: a timeout, a network
failure, a 5xx, an expired subscription, a suspended key, or a site Akismet does not
recognise all produce *no opinion*, exactly as if the layer were switched off. No comment
is ever lost because a third party had a bad day, and no comment is ever held with
Akismet's name on it for a check Akismet never performed.

The trade is that those failures are silent by design, so Charcha writes one log line per
distinct problem to your Worker's log — the debug help Akismet returned, and any account
alert it sent (an expired subscription is code `10402`, overuse is `10009`). If a layer
you are paying for stops working, that line is how you find out; a quiet week and a dead
key look identical otherwise.

## Why only Akismet

[#11](https://github.com/withsetu/charcha/issues/11) also named CleanTalk and
StopForumSpam. Neither is built. One adapter behind a seam is what proves the seam works;
a third is speculative until somebody asks for it, and every provider added is another
company a site owner has to explain to their readers. The interface they would implement
is `SpamProvider` in `src/spam/provider.ts`.
