// Lookalike link domains (#41) — a *moderation* signal, deferred out of #4.
//
// The renderer's URL allowlist is an injection defence, and it deliberately links
// `https://аpple.example/` with a Cyrillic а, because that is a genuine https URL
// with nothing executable in it. Whether the domain is a disguise is a different
// question, and not one a renderer can answer. So the judgement belongs to the
// human gate, and this file is how the human hears about it.
// Enforced by test/worker/spam/lookalike.test.ts, which asserts that the rendered
// markup for such a link is unchanged.
//
// ## Why this can only ever be `review`
//
// An internationalised domain name is a real domain for real people. `пример.рф`
// is a Russian domain the same way `example.uk` is a British one, and there is no
// property of the string that separates "IDN belonging to a person who does not
// write in Latin" from "IDN chosen to impersonate a Latin brand" — only intent
// separates them, and intent is what a moderator has and a regular expression does
// not. A `reject` here would therefore fall entirely on non-Latin-script readers,
// silently, in the name of protecting them. That is a discrimination bug wearing a
// spam control's clothes, and it is why this layer's answer is a held comment and a
// reason string rather than a 403.
// Enforced by test/worker/spam/lookalike.test.ts.
//
// ## What this does not catch, and why that is the deal
//
// **Whole-script confusables.** `аррӏе.example` is Cyrillic end to end — а, р, р,
// palochka ӏ, е — and reads as "apple" in most fonts. No mixed-script measure can
// see it, because nothing is mixed. UTS #39 treats this as a separate problem with
// a separate mechanism (§4, Confusable Detection), and solving it needs the
// confusables mapping — a table of thousands of entries — plus a list of the names
// worth impersonating, because the alternative rule, "flag every wholly non-Latin
// label", is the discrimination bug above with extra steps. Neither fits in this
// change; both stay open on #41.
//
// **Punycode.** A label already in its `xn--` form is ASCII, so it is never mixed
// here. Deciding it needs a decoder, and it must be a decoder rather than a
// prefix match: `xn--` is exactly how a legitimate Cyrillic domain looks when
// someone copies it out of the address bar. Also open on #41.
//
// **A link whose text disagrees with its href.** `[apple.com](https://evil.example)`
// is a different attack with a different answer, and not this issue.

import type { LayerOutcome } from './layer'

/** The reason token the verdict carries. Short, stable, and safe to log. */
export const LOOKALIKE_REASON = 'lookalike-domain'

/**
 * The scripts whose letters are confusable with Latin ones, and the reason the set
 * is exactly these three rather than "every non-Latin script".
 *
 * Unicode UTS #39 §5.2 (Restriction Levels) grades identifiers, and the grade
 * below "Highly Restrictive" is "Moderately Restrictive": a string "covered by
 * Latin and any one other Recommended script, **except Cyrillic, Greek**"
 * (https://www.unicode.org/reports/tr39/#Restriction_Level_Detection). Those two
 * are carved out by name because their letters have Latin twins — а/a, о/o, е/e,
 * ο/o, ρ/p — while Latin alongside Devanagari, Arabic or Han is ordinary writing
 * rather than disguise. Latin + Han + Hiragana + Katakana is explicitly permitted
 * one level up, at Highly Restrictive, because that is simply Japanese.
 *
 * Tracking only these three is what keeps the false-positive rate near zero for
 * the readers most likely to be hurt by a false positive: a Devanagari, Arabic or
 * Han label contains no tracked character at all and is therefore never mixed by
 * this measure, whatever it sits beside.
 * Enforced by test/worker/spam/lookalike.test.ts.
 */
const LATIN = 0b001
const CYRILLIC = 0b010
const GREEK = 0b100
const ALL_TRACKED = LATIN | CYRILLIC | GREEK

/**
 * Script_Extensions rather than Script, per UTS #39's use of augmented script sets
 * — a character usable in several scripts must not be read as evidence of one.
 *
 * The data is the JavaScript engine's own Unicode tables, reached through property
 * escapes (`\p{Script_Extensions=…}`, ES2018), so there is no table in this repo to
 * go stale and no dependency to ship. `workerd` is V8, and the tests that exercise
 * these patterns run in `workerd`, so support is asserted rather than assumed.
 */
const SCRIPT_PATTERNS: readonly (readonly [number, RegExp])[] = [
  [LATIN, /\p{Script_Extensions=Latin}/u],
  [CYRILLIC, /\p{Script_Extensions=Cyrillic}/u],
  [GREEK, /\p{Script_Extensions=Greek}/u],
]

function trackedScriptsOf(character: string): number {
  let scripts = 0
  for (const [script, pattern] of SCRIPT_PATTERNS) {
    if (pattern.test(character)) scripts |= script
  }
  return scripts
}

/**
 * UTS #39 §5.1: a string is mixed-script when the intersection of its characters'
 * script sets — the "resolved script set" — is empty
 * (https://www.unicode.org/reports/tr39/#Mixed_Script_Detection).
 *
 * Restricted here to the three tracked scripts, which changes the meaning in one
 * useful direction only: a character belonging to none of them contributes
 * nothing, so digits, hyphens and every untracked script leave the resolution
 * alone instead of emptying it.
 */
function isMixedScript(label: string): boolean {
  let resolved = ALL_TRACKED

  for (const character of label) {
    const scripts = trackedScriptsOf(character)
    if (scripts === 0) continue
    resolved &= scripts
    if (resolved === 0) return true
  }

  return false
}

/**
 * Percent-decoded, because a browser decodes before it resolves and a reader
 * cannot decode at all. `https://%D0%B0pple.example/` is a working link to the
 * Cyrillic-а host; left encoded it is pure ASCII and would sail past the check.
 *
 * A stray `%` that is not an escape — `100%discount.example` — makes
 * decodeURIComponent throw, and the raw text is then exactly what was meant.
 * The decoded value is used only to count scripts; nothing here is ever navigated
 * to or rendered.
 * Enforced by test/worker/spam/lookalike.test.ts.
 */
function percentDecoded(text: string): string {
  if (!text.includes('%')) return text
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * Where a host stops: the first character that cannot be part of a domain name.
 *
 * This is what keeps the check off ordinary prose, and it earns its place on the
 * false-positive side rather than the detection side. The link pattern in
 * ./content.ts stops at whitespace and brackets, so a link written mid-sentence
 * carries its punctuation with it — and `https://пример.рф,and` split on dots
 * would hand `рф,and` to the script test, which is Cyrillic beside Latin and would
 * be flagged. A comma has done nothing wrong.
 *
 * A port is cut by the same rule, but only for tidiness: a colon and digits belong
 * to no script, so `рф:8443` resolves to Cyrillic with or without the cut. It is
 * punctuation followed by *letters* that matters, and that is the case under test.
 * There is deliberately no port case in test/worker/spam/lookalike.test.ts: it
 * would pass with this rule removed, and a test that cannot fail reads exactly
 * like one that does.
 * Enforced by test/worker/spam/lookalike.test.ts.
 */
const NOT_A_HOST_CHARACTER = /[^\p{L}\p{N}\p{M}._-]/u

/**
 * The host of a matched link, as text — never as a `URL`.
 *
 * `new URL(…).hostname` would be the obvious way and is the wrong one: the WHATWG
 * URL parser runs the host through IDNA ToASCII, so `аpple.example` comes back as
 * `xn--pple-43d.example` and the Unicode form — the entire subject of this check —
 * is not preserved (https://url.spec.whatwg.org/#concept-domain-to-ascii).
 */
function hostOf(link: string): string {
  const afterScheme = link.replace(/^https?:\/\//i, '')
  const authority = percentDecoded(afterScheme.split(/[/?#]/, 1)[0] ?? '')
  // `https://apple.example@аpple.example/` is hosted by whatever follows the last
  // `@`; the part before it is attacker-chosen decoration.
  //
  // Decoding runs first only so that this split sees what a URL parser would, and
  // it is belt and braces rather than a live evasion: a percent-encoded `@` is a
  // forbidden domain code point once the host is decoded, so
  // `https://apple.example%40аpple.example/` is not a URL a browser will navigate
  // at all (https://url.spec.whatwg.org/#forbidden-domain-code-point — and
  // `new URL()` on that string throws, checked 2026-07-25).
  const host = authority.slice(authority.lastIndexOf('@') + 1)
  const end = host.search(NOT_A_HOST_CHARACTER)
  return end === -1 ? host : host.slice(0, end)
}

/**
 * Whether any single label of `link`'s host mixes Latin with Cyrillic or Greek.
 * Takes a whole link, or a bare host: hostOf tolerates both.
 *
 * Per label, not per host, and that is the whole difference between a signal and a
 * tax on non-Latin readers: nearly every internationalised domain sits under an
 * ASCII top-level domain, so `пример.com` mixes scripts as a *host* while no label
 * of it mixes anything. Judging the host would flag the entire IDN namespace.
 * Enforced by test/worker/spam/lookalike.test.ts.
 */
export function hasMixedScriptHost(link: string): boolean {
  return hostOf(link).split('.').some(isMixedScript)
}

/**
 * The layer's answer for one comment's links.
 *
 * Takes the links rather than the body so that the one definition of what a link
 * is — the `LINK` pattern in ./content.ts — stays in one place, and so that a body
 * is scanned for links once per submission rather than once per heuristic.
 */
export function lookalikeOutcome(links: readonly string[]): LayerOutcome {
  return links.some(hasMixedScriptHost) ? { action: 'review', reason: LOOKALIKE_REASON } : null
}
