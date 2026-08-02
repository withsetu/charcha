// The `From:` display name (#208), and the one place a `From` value is composed.
//
// **Why this is a file rather than three lines inside src/notify/resend.ts.** The name is
// owner-supplied configuration that ends up in a mail header, which makes it the highest-
// risk string this project sends. src/notify/message.ts records why classic header
// injection is structurally unavailable for the *body* — the transport is JSON over
// HTTPS, so `JSON.stringify` escapes CR and LF and no comment can write a header line —
// and that argument does not finish this field:
//
//   1. **A header is worth more than a body.** The structural argument is a property of
//      today's transport; a display name refused at the door does not depend on that
//      staying true, and this is the field where being wrong is worth the most.
//   2. **The dangerous case has no newline in it.** `Charcha <security@bank.example>` as
//      a display name renders in a mail client as a sender that is not the sender.
//      Nothing about escaping CR and LF touches that.
//
// So the guard here is a refusal rather than a filter, in both directions: the dashboard
// refuses a name it cannot use and says which character it refused (src/admin/settings.ts),
// and `formatFrom` drops a stored name that would not pass rather than emitting it. The
// second is not redundant — a row can predate the check, or be written straight into D1
// with `wrangler d1 execute`, and card rule 5 does not stop at the commenter.
//
// **It is owner-supplied, which lowers the likelihood and changes nothing else.** An
// owner who pastes something odd gets a refusal at the dashboard rather than a surprising
// email.
// Enforced by test/worker/notify/from.test.ts.

import { CONTROL_CHARACTERS } from './message'

/**
 * The longest display name this will use.
 *
 * A sender name, not a sentence: 64 characters holds "Maya's blog — new comments" several
 * times over. It is **refused** past the cap rather than truncated, which is the opposite
 * of what `oneLine` does to a commenter's name in the body, and deliberately: the body's
 * fields arrive from a stranger mid-request with nobody to tell, while this one is the
 * owner's own configuration typed into a field they are standing at. A sender name that
 * silently became half a name is exactly what nobody notices in their own inbox.
 * Enforced by test/worker/notify/from.test.ts.
 */
export const MAX_FROM_NAME_LENGTH = 64

/**
 * The characters a display name may not contain, beyond the control set.
 *
 * RFC 5322's `specials` minus `.`, which a name legitimately carries — `maya.build
 * comments`. Each of the rest means something to a parser sitting between here and the
 * owner's inbox:
 *
 *   - `<` `>` build the address itself, and are the phishing render this issue is about.
 *   - `"` `\` open, close and escape a quoted display name.
 *   - `,` `;` separate addresses, so a name containing one can read as two senders.
 *   - `:` separates a header name from its value.
 *   - `@` makes a display name read as an address.
 *   - `(` `)` `[` `]` are comment and domain-literal delimiters.
 *
 * Refusing all of them is what lets the composed value stay *unquoted*, and there is one
 * honest caveat in that: `.` is not in `atext` either, so a name containing one is a valid
 * `phrase` under RFC 5322's `obs-phrase` production rather than under the strict one. It is
 * kept because `maya.build comments` is the case this exemption was made for and every
 * parser in the path — Resend's, and the mail clients past it — accepts it. What refusing
 * the *rest* buys is that there is no quoting to get right and no escaping to get wrong,
 * which is the same shape of argument src/notify/message.ts makes for shipping no HTML
 * part. A stricter reading would mean quoting whenever a `.` appears, and a quoting
 * routine is exactly the thing that argument is trying not to own.
 * Enforced by test/worker/notify/from.test.ts.
 */
const FORBIDDEN_IN_FROM_NAME = /["\\<>,;:@()[\]]/

/**
 * CR, LF and tab, which the control set in src/notify/message.ts deliberately lets
 * through because a plain-text *body* legitimately contains them.
 *
 * A `From:` header does not. This is the difference between the two fields, written out
 * rather than left as a second copy of the whole class.
 */
const LINE_STRUCTURE = /[\r\n\t]/

/**
 * Why this display name cannot be used, or null when it can.
 *
 * A sentence naming the problem rather than a boolean, for the reason
 * `handleWriteSettings` gives about an unknown moderation policy: the caller is the owner
 * and can be told, and "invalid" on a field they typed one character wrong in is a message
 * that makes them retype the whole thing.
 *
 * A blank name is *not* a problem — it is the absence of a display name, which is what
 * every deployment has today and what clearing the field means.
 * Enforced by test/worker/notify/from.test.ts.
 */
export function fromNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return null

  if (trimmed.length > MAX_FROM_NAME_LENGTH) {
    return `That name is longer than ${String(MAX_FROM_NAME_LENGTH)} characters. It is the sender name in your inbox, not a sentence.`
  }

  const line = LINE_STRUCTURE.exec(trimmed)
  if (line !== null) {
    return 'A sender name cannot contain a line break or a tab — those are what build the headers around it.'
  }

  const special = FORBIDDEN_IN_FROM_NAME.exec(trimmed)
  if (special !== null) {
    return `A sender name cannot contain “${special[0]}”. A mail client reads it as part of the address rather than as part of the name.`
  }

  // Reused rather than restated: this is the same set src/notify/message.ts strips from
  // every untrusted line, and it is here for the case a column-0 rule does not cover —
  // a bidi override or a zero-width character reorders or hides text *within* a line,
  // which is enough to make a From: line render as something other than what is stored.
  if (trimmed.replace(CONTROL_CHARACTERS, '') !== trimmed) {
    return 'A sender name cannot contain invisible or text-reordering characters. Retype it rather than pasting it.'
  }

  return null
}

/**
 * The longest email address this will accept.
 *
 * Generous rather than derived: 254 is past any address a person types into a field, and
 * the point of the cap is that one exists before a stored value is put in a header, not
 * that it is exactly the protocol's.
 */
export const MAX_EMAIL_ADDRESS_LENGTH = 254

/**
 * Why this is not an address a notification can use, or null when it is.
 *
 * **Deliberately not an RFC 5322 parser.** The failure this has to prevent is a value that
 * would change what the `From:` header means or that the provider will simply reject, and
 * the shape that does both is the same short list `fromNameProblem` refuses in a display
 * name: whitespace, angle brackets, quotes and the separators. Beyond that, whether
 * `a.b+c@example.co.uk` is deliverable is Resend's question and not this project's, and a
 * stricter check would refuse working addresses to no benefit — the symptom of which is an
 * owner who cannot save the address that works.
 *
 * The one *positive* requirement is a single `@` with something either side, because a
 * value without one is not an address by any reading and is the typo worth catching at the
 * field rather than in a 403 from Resend three days later.
 *
 * **It lives here rather than beside the dashboard's write path, because both ends need
 * it.** src/admin/settings.ts refuses on it loudly, naming the field; `resolveSiteSettings`
 * in src/settings.ts drops a row that fails it, for the reason this whole file exists — a
 * row can predate the check or be written straight into D1 with `wrangler d1 execute`, and
 * these two values go into the Resend payload's `from` and `to`. Two copies of the rule
 * would be two rules that can disagree about what the Worker will actually send.
 *
 * Sentences with no subject, so a caller can put the field's name in front of one.
 * Enforced by test/worker/notify/from.test.ts and test/worker/admin/settings.test.ts.
 */
export function addressProblem(value: string): string | null {
  if (value.length > MAX_EMAIL_ADDRESS_LENGTH) {
    return `is longer than ${String(MAX_EMAIL_ADDRESS_LENGTH)} characters, which is not an email address.`
  }
  if (/[\s<>"\\,;:]/.test(value)) {
    return `cannot contain spaces, angle brackets, quotes or separators. Put a sender name in the name field instead — it holds up to ${String(MAX_FROM_NAME_LENGTH)} characters.`
  }
  const at = value.indexOf('@')
  if (at < 1 || at !== value.lastIndexOf('@') || at === value.length - 1) {
    return `is not an email address: “${value}” needs one @, with a name before it and a domain after it.`
  }
  return null
}

/**
 * Whether this string is a bare address rather than something already carrying a name.
 *
 * The deprecated `CHARCHA_NOTIFY_FROM` secret documented `Charcha <comments@example.com>`
 * as a legal value, so #207's fallback can hand `formatFrom` a whole `From` value rather
 * than an address. Wrapping one of those would produce `Name <Charcha <a@b>>`, which is
 * neither shape.
 */
function isBareAddress(address: string): boolean {
  return !/[<>"\s]/.test(address)
}

/**
 * The `from` value Resend takes, and the only place in this project that builds one.
 *
 * "Sender email address. To include a friendly name, pass the sender as
 * `Name <email@example.com>`" — https://resend.com/docs/api-reference/emails/send-email,
 * checked 2026-08-02. The API field is a single string with no structured alternative, so
 * "never concatenated into an address string" (#208) is satisfied by carrying the two
 * parts separately everywhere else and joining them exactly here.
 *
 * **It drops a name it would have refused rather than emitting it.** Fail closed, and the
 * second layer under the dashboard's refusal: a row can predate that check or be written
 * straight into D1.
 * Enforced by test/worker/notify/from.test.ts.
 */
export function formatFrom(address: string, name: string | null): string {
  const trimmedAddress = address.trim()
  const trimmedName = (name ?? '').trim()

  if (trimmedName === '') return trimmedAddress
  if (fromNameProblem(trimmedName) !== null) return trimmedAddress
  if (!isBareAddress(trimmedAddress)) return trimmedAddress

  return `${trimmedName} <${trimmedAddress}>`
}
