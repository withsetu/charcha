# How a URL becomes a comment thread

Every comment belongs to a **thread**, and a thread is identified by a **page key** that
Charcha works out from the address of the page. Two visitors have to land on the same
key or they will not see each other's comments.

Most of the time this is invisible and correct. This page exists for the cases where it
is not — because the defaults are opinionated, and one of them will surprise you.

## The short version

| Part of the URL | Affects which thread? |
|---|---|
| Path (`/notes/hello`) | **Yes** — this is the identity |
| Uppercase vs lowercase in the path | **Yes** — `/Post` and `/post` are different threads |
| `https://` vs `http://` | No |
| Domain, subdomain, port | No |
| Trailing slash | No — `/post` and `/post/` are the same thread |
| `?anything=here` | No, by default |
| `#section` | No |

## Why the domain is ignored

One Charcha deployment serves one site, so the domain carries no information worth
keeping. Dropping it means `example.com`, `www.example.com`, the `http://` version, and
`localhost:4321` while you are writing a post are all **one conversation**, with nothing
to configure. It also means moving your blog to a new domain does not orphan every
comment you have.

## Why the query string is dropped

If `?utm_source=newsletter` counted, one post shared through three channels would become
four separate conversations, and readers would not see each other. Tracking parameters
are unbounded and keep being invented, so the default is to ignore all of them.

**The cost:** if your site uses the query string for real page identity — `/blog?page=2`,
`/item?id=42` — those pages currently collapse into one shared thread. If that is your
site, use an explicit thread id (below) until per-site configuration ships
([#38](https://github.com/withsetu/charcha/issues/38)).

Anything that *is* kept gets sorted, so `?a=1&b=2` and `?b=2&a=1` are the same thread.

## The one that will surprise you: case matters

`/my-post` and `/My-Post` are **two different threads**.

This is deliberate. Web standards make only the domain case-insensitive, and static hosts
genuinely do serve `/My-Post` and `/my-post` as different pages — so folding them
together would merge two real pages into one comment thread.

The rule behind that choice, and behind several others here:

> Splitting one page into two threads is recoverable. Merging two pages into one thread
> is not.

If a comment lands on the wrong key you can move it. If two pages' comments are already
mixed together, nothing can tell you which was which. So when the choice is ambiguous,
Charcha splits.

In practice this only bites if your links are inconsistently cased. If your host is
case-insensitive and you want them folded together, that is
[#39](https://github.com/withsetu/charcha/issues/39).

## Naming a thread yourself

When the URL is the wrong identity — a page that moved, a paginated route, a post
reachable at two paths — name the thread explicitly and the URL stops mattering:

```html
<div id="charcha" data-thread="leaving-the-comment-industry"></div>
```

That value must be ASCII, start with a letter or digit, and be at most 200 characters.

Explicit ids live in their own namespace and **cannot collide with URL-derived keys**:
URL keys always begin with `/`, explicit ids are stored as `id:<your-value>`. This
matters because `data-thread` arrives from the page like everything else, so without the
separation a crafted value could be aimed at another page's thread.

Once you set `data-thread` on a page, **keep it**. Removing it moves the page back to
its URL-derived key, and the existing comments stay behind on the old one.

## Where this is decided

The key is always derived **inside the Worker**, from the page address the embed
reports. The embed cannot send a key directly, and nothing a browser submits can choose
one that Charcha would not have produced itself.

That matters for two reasons. Anything arriving from a page is attacker-controlled, and
`page_key` is a unique database key — so accepting one over the wire would let anyone
graft comments onto any thread. And because derivation lives in one place, a cached copy
of an old embed still gets today's rules rather than last year's.

Some limits, since they are enforced rather than advisory: the reported URL is capped at
2,048 characters, an explicit thread id at 200, and the resulting key at 512. URLs
containing control characters are rejected outright rather than cleaned up, and text is
Unicode-normalised so two identical-looking addresses cannot become two threads.
