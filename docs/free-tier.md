# Will this stay free?

For a normal blog: yes, and not narrowly. This page shows the actual numbers so you can
check that against your own traffic rather than take a promise for it.

Charcha runs on Cloudflare's free tier — a Worker (the code) and D1 (the database).
Neither has a bill attached until you choose to add one. What they have instead are
daily ceilings.

## The four numbers

They are not the same kind of number, and that turns out to matter more than their size.

| Limit | Applies to | Resets | What stops working |
|---|---|---|---|
| **100,000 Worker requests/day** | your whole site | daily, midnight UTC | comments stop loading, everywhere |
| **5,000,000 database rows read/day** | your whole Cloudflare account | daily | comments stop loading, everywhere |
| **100,000 database rows written/day** | your whole account | daily | reading comments is fine; **posting** stops |
| **~50 database queries per page load** | one single page load | the next request | that one page, and only on the most-commented posts |

Two things to notice.

**The first three are daily and site-wide; the last one is per-page-load.** Hitting the
daily ones means a bad day. Hitting the per-page-load one means one page is broken while
every other page is fine.

**Reading and writing have very different budgets.** You get 50 times more reads than
writes. That sounds abstract until you realise what it means: if loading a page also
wrote to the database, ordinary traffic would burn through the writing budget, and then
nobody could comment for the rest of the day. Traffic would quietly switch commenting
off. Charcha is built so that **reading comments performs no writes at all** — that is
a deliberate design property, not an accident, and it is the single most important thing
keeping a busy day from breaking the comment box.

## A worked example

A blog with 1,000 posts. 5,000 visitors a day, reading about 3 posts each — so roughly
**15,000 page views a day**. A well-commented post has 20 comments.

| Budget | Used | Of the allowance |
|---|---|---|
| Worker requests | 15,000 | **15%** |
| Database rows read | ~300,000 | **6%** |
| Database rows written | 0 | **0%** — writes happen only when somebody comments |
| Storage | ~20 MB | ~4% of the 500 MB per-database limit |

That blog is not close to any limit. It could grow around 6× before anything needed
thinking about.

## Where the ceiling actually is

**Worker requests, at roughly 100,000 comment-thread loads a day.**

That is the number to watch. Database reads only become the binding limit first if your
pages average more than about 50 comments each — because 5,000,000 reads ÷ 100,000
requests = 50 rows per request. Below that average, you run out of requests first.

So: **the free tier carries about 100,000 comment-thread loads a day**, and the thing to
watch is your visitor count, not your database.

Two details that push the ceiling further out than you might expect:

- **A page nobody has commented on costs almost nothing.** Charcha creates no database
  row for a page until someone actually comments on it, so an uncommented page reads as
  empty without touching stored data. On a 1,000-post blog where 50 posts have
  conversations, the other 950 are nearly free.
- **The embed script itself is not a Worker request.** It is served as a static asset,
  and static assets are free and unlimited on Cloudflare. Only fetching the comments
  costs a request.

## What actually happens if you hit a limit

Different limits fail in different ways, and knowing which is which tells you how urgent
your day is.

**Worker requests exhausted** — the widget stops being able to fetch comments. Your blog
posts still load normally; the comment section is what fails, because that is the only
part of your page that talks to Charcha. Resets at midnight UTC.

**Database rows read exhausted** — the same symptom, for the same reason. Note this
limit is **per Cloudflare account**, so it is shared with anything else you run on that
account.

**Database rows written exhausted** — reading works fine, and **posting a comment
fails**. This is the asymmetric one: your site looks completely healthy to a visitor
right up until they try to say something. Because reading performs no writes, this is
also the one you are least likely to reach by traffic alone; getting here usually means
a genuine flood of comments, or an import.

**Too many queries in a single page load** — only that page fails, and only the
most-commented ones. Charcha uses a fixed, small number of queries to render a page no
matter how many comments are on it, specifically so that this limit does not creep up on
the busiest threads. The next request is unaffected.

## The one number we are not certain about

Cloudflare's own documentation disagrees with itself about queries per page load. The
[D1 limits page](https://developers.cloudflare.com/d1/platform/limits/) says 50 on the
free plan, while the
[Workers limits page](https://developers.cloudflare.com/workers/platform/limits/) and a
[February 2026 changelog](https://developers.cloudflare.com/changelog/2026-02-11-subrequests-limit)
say free-plan Workers get 1,000 requests to Cloudflare services, which is what a database
query is. The D1 figure may simply predate the change.

Rather than pick the flattering number, Charcha is **built for 50** — the lower one, and
the cheaper mistake. In practice it does not matter much: rendering a page uses a small
fixed number of queries regardless of comment count, which is safe under either figure.
It is written down here because a documentation page should not present a disputed
number as a settled fact.

Everything else on this page was verified against Cloudflare's documentation on
**2026-07-23**. Cloudflare changes its limits from time to time; treat these as accurate
as of that date and check the source if a number matters to a decision you are making.

## If you outgrow it

The free tier is a starting point, not a cage. The Workers paid plan starts at a
**minimum of $5/month** and raises every ceiling on this page by a large multiple. It is
a minimum rather than a flat fee: the $5 includes generous allowances, and usage beyond
them is charged per unit. For the database, the paid plan includes 25 billion rows read
and 50 million rows written per month before any per-row charge — figures a blog is not
going to trouble.

You do not migrate anything, change any code, or move any data. It is a billing setting
on the Cloudflare account that already runs your site.

Which is the honest summary of this whole page: for a typical blog this is free
indefinitely, and if you become popular enough for that to change, the first step costs
about as much as a coffee and requires no work.
