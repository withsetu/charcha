import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeSetting } from '../../../src/db'
import { renderMarkdown } from '../../../src/render/markdown'
import { SITE_URL_SETTING } from '../../../src/settings'
import { contentLayer, extractLinks } from '../../../src/spam/content'
import { ELAPSED_FIELD, HONEYPOT_FIELD } from '../../../src/spam/fields'
import { LOOKALIKE_REASON, hasMixedScriptHost, lookalikeOutcome } from '../../../src/spam/lookalike'
import { contextFor } from './context'

/** The attack, spelled out once: a Cyrillic а (U+0430) wearing Latin letters. */
const CYRILLIC_A = 'а'
const GREEK_OMICRON = 'ο'

function flags(body: string): boolean {
  return lookalikeOutcome(extractLinks(body)) !== null
}

describe('mixed-script hosts', () => {
  it('flags a Cyrillic а inside an otherwise Latin label — the attack this is for', () => {
    expect(hasMixedScriptHost(`${CYRILLIC_A}pple.example`)).toBe(true)
  })

  it('flags a Greek ο inside an otherwise Latin label', () => {
    expect(hasMixedScriptHost(`g${GREEK_OMICRON}ogle.example`)).toBe(true)
  })

  it('does not flag a wholly Latin host', () => {
    expect(hasMixedScriptHost('apple.example')).toBe(false)
  })

  it('does not flag a wholly Cyrillic domain, which is a real domain for real people', () => {
    // пример.рф — "example.rf". Rejecting or even flagging every non-Latin host
    // would push the moderation cost of the feature onto exactly the readers who
    // did nothing wrong.
    expect(hasMixedScriptHost('пример.рф')).toBe(false)
  })

  it('judges each label on its own, so a Cyrillic name under a Latin TLD is fine', () => {
    // пример.com. The host mixes scripts; no *label* does. Judging the whole host
    // would flag nearly every internationalised domain in existence, because the
    // TLD is almost always ASCII.
    expect(hasMixedScriptHost('пример.com')).toBe(false)
  })

  it('does not flag Latin mixed with a script that is not confusable with it', () => {
    // sony製品.example. UTS #39 permits Latin + Han + Hiragana + Katakana at
    // "Highly Restrictive"; it is how Japanese is written, not a disguise.
    expect(hasMixedScriptHost('sony製品.example')).toBe(false)
  })

  it('does not flag a Devanagari or Arabic label, tracked by nothing here', () => {
    // The three tracked scripts are Latin, Cyrillic and Greek. A label in a script
    // outside that set contains no tracked character at all, so it cannot resolve
    // to an empty set however it is written — which is the property that keeps this
    // check off the readers it would be least defensible to inconvenience.
    expect(hasMixedScriptHost('हिन्दी.भारत')).toBe(false)
    expect(hasMixedScriptHost('مثال.إختبار')).toBe(false)
    expect(hasMixedScriptHost('shop-हिन्दी.example')).toBe(false)
  })

  it('does not catch a whole-script confusable, and that is a known limit not a bug', () => {
    // аррӏе.example is Cyrillic end to end and reads as "apple". Nothing is mixed,
    // so no mixed-script measure can see it; UTS #39 answers this with a separate
    // confusables mapping (§4), which is thousands of entries and is still open on
    // #41. Asserted rather than left implied, so the gap is visible to whoever
    // picks that up rather than being discovered as a surprise.
    expect(hasMixedScriptHost('аррӏе.example')).toBe(false)
  })

  it('does not count digits or hyphens, which belong to no script', () => {
    expect(hasMixedScriptHost('пример-1.рф')).toBe(false)
  })

  it('reads the host after any userinfo, not the userinfo itself', () => {
    expect(hasMixedScriptHost(`user@${CYRILLIC_A}pple.example`)).toBe(true)
  })

  it('does not flag a script confined to the userinfo, which is not the domain', () => {
    // The username is not what the reader is being told the link goes to. Reading
    // it as part of the host invents a lookalike out of an ordinary URL.
    expect(hasMixedScriptHost('пример@example.com')).toBe(false)
  })

  it('splits userinfo off the decoded host, not the encoded one', () => {
    // %40 is `@`. Decoding after the split would leave `apple.example%40…` as one
    // long label and hand the check a string no browser would resolve to that host.
    // This is ordering hygiene rather than a closed evasion: a decoded `@` in a
    // host is a forbidden domain code point, so the URL is invalid anyway.
    expect(hasMixedScriptHost(`https://apple.example%40${CYRILLIC_A}pple.example/`)).toBe(true)
  })

  it('stops the host at punctuation, so a link written mid-sentence is not flagged', () => {
    // The link pattern in src/spam/content.ts stops at whitespace, so a comma
    // straight after a URL comes along with it. `рф,and` is Cyrillic beside Latin
    // and would be a flag on a comma.
    expect(hasMixedScriptHost('https://пример.рф,and')).toBe(false)
  })

  it('sees through percent-encoding, which a browser resolves and a reader cannot', () => {
    // %D0%B0 is the Cyrillic а. The URL is a working link to the same lookalike
    // host; only the detector would have been fooled.
    expect(hasMixedScriptHost('%D0%B0pple.example')).toBe(true)
  })

  it('survives a stray percent sign, which is not an escape and must not throw', () => {
    expect(hasMixedScriptHost('100%discount.example')).toBe(false)
  })
})

describe('the signal over a comment body', () => {
  it('holds a comment linking a lookalike domain for review, and names why', () => {
    const outcome = lookalikeOutcome(
      extractLinks(`Free stuff at https://${CYRILLIC_A}pple.example/deal`),
    )

    expect(outcome).toEqual({ action: 'review', reason: LOOKALIKE_REASON })
  })

  it('is never a reject, however many lookalike links a body carries', () => {
    // A lookalike domain is a judgement about *intent*, and an internationalised
    // domain is indistinguishable from a disguise without one. Rejecting would
    // discard real comments from non-Latin-script readers, silently.
    const body = Array.from(
      { length: 5 },
      (_, i) => `https://${CYRILLIC_A}pple-${i}.example/`,
    ).join(' ')

    expect(lookalikeOutcome(extractLinks(body))?.action).toBe('review')
  })

  it('leaves an ordinary comment with ordinary links alone', () => {
    // The one that matters most: a heuristic that flags everything is worse than
    // no heuristic, because it costs a moderator their attention on every comment.
    expect(
      flags(
        'The [export format](https://maya.build/spec) is the part that matters, ' +
          'and www.example.com says the same thing.',
      ),
    ).toBe(false)
  })

  it('has no opinion about a comment with no links at all', () => {
    expect(flags('I disagree, and here is why: the export is the whole product.')).toBe(false)
  })

  it('reads a www-prefixed address as well as one carrying a scheme', () => {
    expect(flags(`Look at www.${CYRILLIC_A}pple.example today`)).toBe(true)
  })

  it('does not read a bare dotted word as a link, so prose stays prose', () => {
    // No scheme, no www: src/render/markdown.ts would never make this a link, so
    // neither does the detector. Enforced together with test/worker/spam/content.test.ts.
    expect(flags(`I mean the ${CYRILLIC_A}pple.example package, not the fruit.`)).toBe(false)
  })
})

describe('layer 6 carries the signal', () => {
  it('holds a comment whose only fault is a lookalike link', async () => {
    const outcome = await contentLayer().run(
      contextFor({ body: `Worth a look: https://${CYRILLIC_A}pple.example/deal` }),
    )

    expect(outcome).toEqual({ action: 'review', reason: LOOKALIKE_REASON })
  })

  it('yields to a link in the author’s name, which is the more specific reason (#184)', async () => {
    // The precedence inside layer 6 is by how much the reason tells the moderator that
    // they could not see for themselves, and both of these are reviews — so which one
    // survives is decided here and nowhere else. Without this the ordering in
    // `contentLayer` is a comment rather than a property, which is how #184 shipped it
    // and what this test exists to fix.
    const outcome = await contentLayer().run(
      contextFor({
        authorName: 'www.cheap-pills.example',
        body: `Worth a look: https://${CYRILLIC_A}pple.example/deal`,
      }),
    )

    expect(outcome).toEqual({ action: 'review', reason: 'link-in-name' })
  })

  it('still rejects a link flood that happens to contain a lookalike', async () => {
    // `reject` outranks `review`. A comment cannot downgrade its own verdict by
    // adding a signal that is weaker than the one it already earned.
    const body = Array.from(
      { length: 12 },
      (_, i) => `https://${CYRILLIC_A}pple-${i}.example/`,
    ).join(' ')

    expect((await contentLayer().run(contextFor({ body })))?.action).toBe('reject')
  })
})

describe('driven through the deployed Worker', () => {
  // Not through the layer objects: this is the test that would catch the signal
  // being written and then never reached from src/index.ts.
  let lines: string[] = []

  beforeEach(async () => {
    await env.DB.exec('DELETE FROM comments')
    await env.DB.exec('DELETE FROM threads')
    await env.DB.exec('DELETE FROM settings')
    // Declared, so the submission reaches the layers at all (#224).
    await writeSetting(env.DB, SITE_URL_SETTING, 'https://maya.build', 1_753_300_000)
    lines = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts the comment and names the reason in the log — the only place it lands today', async () => {
    // The comment is stored, because a held comment is still a comment: every
    // public submission goes to the moderation queue as `pending` regardless.
    // What the moderator does *not* get is the reason — src/submit/pipeline.ts
    // reads the verdict's action and drops its reason, which is #70. Until that
    // is fixed, this log line is the whole of the feature's output, and asserting
    // it here is what keeps that claim honest rather than optimistic.
    const response = await exports.default.fetch('https://charcha.example/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        authorName: 'Rahul Kanwar',
        body: `Worth a look, this one: https://${CYRILLIC_A}pple.example/deal`,
        url: 'https://maya.build/notes/leaving',
        [HONEYPOT_FIELD]: '',
        [ELAPSED_FIELD]: 31_000,
      }),
    })

    expect(response.status).toBe(202)

    const record = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.event === 'spam_verdict')
    expect(record).toMatchObject({
      action: 'review',
      layer: 'content',
      reason: LOOKALIKE_REASON,
      pageKey: '/notes/leaving',
    })
  })
})

describe('what the reader sees', () => {
  it('renders a lookalike link exactly as it did before this signal existed', () => {
    // This is a moderation signal, not a rendering change. #4 decided the renderer
    // links `https://аpple.example/` because it is a genuine https URL, and that
    // decision is untouched here: the judgement moved to the human gate, the
    // markup did not move at all.
    const html = renderMarkdown(`[Apple](https://${CYRILLIC_A}pple.example/)`)

    expect(html).toBe(
      `<p><a href="https://${CYRILLIC_A}pple.example/" rel="nofollow ugc noopener noreferrer" target="_blank">Apple</a></p>`,
    )
  })
})
