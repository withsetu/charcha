// The `From:` display name (#208) — the highest-risk string this project puts in an
// email, and the reason it has a file of its own.
//
// src/notify/message.ts already argues that classic header injection is structurally
// unavailable here: the transport is JSON over HTTPS, so `JSON.stringify` escapes CR and
// LF and no comment body can write a header line. That argument is about the *body*, and
// it is not the whole of what this field needs:
//
//   - The name reaches a `From:` header rather than a body, which is the one place an
//     injected `\r\n` has always been worth the most. Structural unavailability is a
//     property of today's transport, and a display name refused at the door does not
//     depend on it staying true.
//   - `Charcha <security@bank.example>` as a *display name* is a phishing render with no
//     newline in it at all. Nothing about escaping CR and LF touches that case.
//
// So the tests here are written for the `From:` line specifically rather than inherited
// from the body's.

import { describe, expect, it } from 'vitest'
import { MAX_FROM_NAME_LENGTH, formatFrom, fromNameProblem } from '../../../src/notify/from'

describe('fromNameProblem', () => {
  it('accepts an ordinary display name', () => {
    expect(fromNameProblem('Charcha')).toBeNull()
    expect(fromNameProblem('maya.build comments')).toBeNull()
    expect(fromNameProblem('Maya’s blog')).toBeNull()
  })

  it('refuses a name carrying CR or LF, which is what a From: header is worth most', () => {
    expect(fromNameProblem('Charcha\r\nBcc: victim@example.com')).not.toBeNull()
    expect(fromNameProblem('Charcha\nX-Anything: yes')).not.toBeNull()
  })

  it('trims a trailing line break rather than refusing it', () => {
    // The `wrangler secret put` case, and the paste-with-a-newline case. It cannot forge
    // anything — there is nothing after it — and refusing it would reject a value that
    // works, which is the direction this project does not fail in for the owner's own
    // configuration. What it must not survive is being *inside* the name, above.
    expect(fromNameProblem('Charcha\r\n')).toBeNull()
    expect(formatFrom('comments@maya.build', 'Charcha\r\n')).toBe('Charcha <comments@maya.build>')
  })

  it('refuses a name carrying a tab', () => {
    expect(fromNameProblem('Charcha\tcomments')).not.toBeNull()
  })

  it('refuses angle brackets, which is the phishing render without a newline', () => {
    // `Charcha <security@bank.example> <comments@maya.build>` renders in a mail client as
    // a sender that is not the sender, and no line was forged to do it.
    expect(fromNameProblem('Charcha <security@bank.example>')).not.toBeNull()
    expect(fromNameProblem('a > b')).not.toBeNull()
  })

  it('refuses quotes and a backslash, which end or escape a quoted display name', () => {
    expect(fromNameProblem('Charcha " comments')).not.toBeNull()
    expect(fromNameProblem('Charcha \\ comments')).not.toBeNull()
  })

  it('refuses the remaining RFC 5322 specials, which all mean something in a header', () => {
    // `,` and `;` separate addresses, `:` separates a header from its value, `@` makes a
    // display name read as an address, and `()[]` are comment and domain-literal
    // delimiters. None of them is worth a display name, and each of them is worth a
    // misreading.
    for (const name of ['a,b', 'a;b', 'a:b', 'a@b', 'a(b', 'a)b', 'a[b', 'a]b']) {
      expect(fromNameProblem(name), name).not.toBeNull()
    }
  })

  it('refuses a bidi override or a zero-width character', () => {
    // These create no line, so the structural argument does not touch them: they reorder
    // or hide text *within* a line, which is enough to make a From: line render as
    // something other than what is stored. Same set src/notify/message.ts filters.
    expect(fromNameProblem('Charcha‮comments')).not.toBeNull()
    expect(fromNameProblem('Char​cha')).not.toBeNull()
  })

  it('refuses a name past the cap rather than truncating it', () => {
    // Truncating a body is right — the comment is the reader's and a cut excerpt still
    // reads. Truncating a sender name is wrong: it is the owner's own configuration, they
    // are standing at the field, and a name that silently became half a name is the kind
    // of thing nobody notices in their own inbox.
    expect(fromNameProblem('a'.repeat(MAX_FROM_NAME_LENGTH))).toBeNull()
    expect(fromNameProblem('a'.repeat(MAX_FROM_NAME_LENGTH + 1))).not.toBeNull()
  })

  it('accepts a blank name, which means no display name at all', () => {
    expect(fromNameProblem('')).toBeNull()
    expect(fromNameProblem('   ')).toBeNull()
  })

  it('says what it refused, the way an unknown moderation policy does', () => {
    // The caller is the owner and can be told. "Invalid" on a field they typed one
    // character wrong in is a message that makes them retype the whole thing.
    expect(fromNameProblem('Charcha <a@b>')).toContain('<')
  })
})

describe('formatFrom', () => {
  it('is a bare address when there is no name — today’s behaviour, unchanged', () => {
    expect(formatFrom('comments@maya.build', null)).toBe('comments@maya.build')
    expect(formatFrom('comments@maya.build', '  ')).toBe('comments@maya.build')
  })

  it('composes the one shape Resend documents', () => {
    // "To include a friendly name, pass the sender as `Name <email@example.com>`" —
    // https://resend.com/docs/api-reference/emails/send-email, checked 2026-08-02. The
    // API takes a single string, so this is the one place in the project that builds it.
    expect(formatFrom('comments@maya.build', 'Charcha')).toBe('Charcha <comments@maya.build>')
  })

  it('drops a name it would have refused, rather than emitting it', () => {
    // Fail closed. The dashboard refuses this loudly on the way in; a row that predates
    // that check, or one written by `wrangler d1 execute`, must not reach a header.
    expect(formatFrom('comments@maya.build', 'Charcha\r\nBcc: victim@example.com')).toBe(
      'comments@maya.build',
    )
    expect(formatFrom('comments@maya.build', 'Charcha <security@bank.example>')).toBe(
      'comments@maya.build',
    )
  })

  it('leaves an address that already carries a display name alone', () => {
    // The deprecated `CHARCHA_NOTIFY_FROM` secret documented `Charcha <comments@…>` as a
    // legal value, so the fallback (#207) can hand this function a whole From value.
    // Wrapping it would produce `Name <Charcha <a@b>>`, which is neither.
    expect(formatFrom('Charcha <comments@maya.build>', 'Something Else')).toBe(
      'Charcha <comments@maya.build>',
    )
  })

  it('never lets a name change what the From: line means', () => {
    // The property, stated once over the two attack shapes: whatever the name is, the
    // address between the angle brackets is the address that was configured — or there
    // are no angle brackets at all.
    for (const name of [
      'Charcha\r\nBcc: victim@example.com',
      'Charcha <security@bank.example>',
      'a"b',
      'a,b',
      '‮eurahc',
    ]) {
      const line = formatFrom('comments@maya.build', name)
      expect(line, name).toBe('comments@maya.build')
    }
  })
})
