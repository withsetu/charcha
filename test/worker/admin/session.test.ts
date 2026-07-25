import { describe, expect, it } from 'vitest'
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_PATH,
  SESSION_LIFETIME_SECONDS,
  clearedSessionCookie,
  issueSession,
  readSessionCookie,
  sessionCookie,
  verifySession,
} from '../../../src/admin/session'

const secret = 'ThFn6Q7Rf2kZ8pWvB3xTqYuA'
const other = 'a-different-deployment-secret-entirely'
const t0 = 1_753_300_000

function withCookie(value: string): Request {
  return new Request('https://charcha.example/admin/api/queue', { headers: { cookie: value } })
}

describe('a session this deployment issued', () => {
  it('verifies', async () => {
    const { token } = await issueSession(secret, t0)

    expect(await verifySession(token, secret, t0)).toBe(true)
  })

  it('reports when it expires, so the client can refresh before it does', async () => {
    const { expiresAt } = await issueSession(secret, t0)

    expect(expiresAt).toBe(t0 + SESSION_LIFETIME_SECONDS)
  })

  it('is still valid one second before it expires', async () => {
    const { token, expiresAt } = await issueSession(secret, t0)

    expect(await verifySession(token, secret, expiresAt - 1)).toBe(true)
  })

  it('is refused at the moment it expires', async () => {
    const { token, expiresAt } = await issueSession(secret, t0)

    expect(await verifySession(token, secret, expiresAt)).toBe(false)
  })

  it('is refused after it expires', async () => {
    const { token } = await issueSession(secret, t0)

    expect(await verifySession(token, secret, t0 + SESSION_LIFETIME_SECONDS + 1)).toBe(false)
  })

  it('is refused once the secret is rotated, which is the whole revocation lever', async () => {
    // Sessions are signed with a key derived from CHARCHA_DASHBOARD_PASSWORD, so
    // changing the secret signs every session out. There is no session table, so
    // this is the only revocation there is — it has to work.
    const { token } = await issueSession(secret, t0)

    expect(await verifySession(token, other, t0)).toBe(false)
  })

  it('is not the same token twice, because the expiry moves', async () => {
    const first = await issueSession(secret, t0)
    const second = await issueSession(secret, t0 + 1)

    expect(second.token).not.toBe(first.token)
  })
})

describe('a session nobody issued', () => {
  it.each([
    ['an empty string', ''],
    ['no separator', '1785000000'],
    ['three parts', '1785000000.aaaa.bbbb'],
    ['an empty signature', '1785000000.'],
    ['an empty expiry', '.aaaa'],
    ['a non-numeric expiry', 'soon.aaaa'],
    ['a negative expiry', '-1785000000.aaaa'],
    ['an expiry in exponent notation', '1e12.aaaa'],
    ['an expiry in hexadecimal', '0x6a5d3000.aaaa'],
    ['an expiry past ten digits', '17850000000000000000.aaaa'],
    ['a signature that is not base64url', '1785000000.****'],
    ['a signature with base64 padding', '1785000000.YWJj=='],
    ['a signature with whitespace', '1785000000. YWJj'],
  ])('is refused: %s', async (_label, token) => {
    expect(await verifySession(token, secret, t0)).toBe(false)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 1_785_000_000],
    ['an object', { token: 'x' }],
  ])('is refused when it is not even a string: %s', async (_label, token) => {
    expect(await verifySession(token, secret, t0)).toBe(false)
  })

  it('is refused when the signature is the right shape but the wrong bytes', async () => {
    const { token } = await issueSession(secret, t0)
    const [expiry, signature] = token.split('.') as [string, string]
    // One character flipped, so the length and the alphabet are both still right.
    const flipped = signature[0] === 'A' ? `B${signature.slice(1)}` : `A${signature.slice(1)}`

    expect(await verifySession(`${expiry}.${flipped}`, secret, t0)).toBe(false)
  })

  it('is refused when the expiry is extended but the signature is kept', async () => {
    // The signature covers the expiry. Without that, a client could hold a session
    // open forever by editing the number in its own cookie.
    const { token, expiresAt } = await issueSession(secret, t0)
    const signature = token.split('.')[1] as string

    expect(await verifySession(`${expiresAt + 86_400}.${signature}`, secret, t0)).toBe(false)
  })

  it('is refused when the signature decodes to fewer than 32 bytes', async () => {
    expect(await verifySession('1785000000.YWJj', secret, t0)).toBe(false)
  })

  it('is refused when the signature decodes to more than 32 bytes', async () => {
    const { token } = await issueSession(secret, t0)
    const [expiry, signature] = token.split('.') as [string, string]

    expect(await verifySession(`${expiry}.${signature}AAAA`, secret, t0)).toBe(false)
  })

  it('is refused when it is absurdly long', async () => {
    expect(await verifySession(`1785000000.${'A'.repeat(5000)}`, secret, t0)).toBe(false)
  })
})

describe('a token that is a valid one with something added', () => {
  // Malleability. None of these is a privilege escalation on its own — the holder
  // already has a working session — but each is a *second* cookie value that names
  // the same session, and a verifier that accepts more strings than it issues is one
  // whose token can no longer be compared, logged or listed as an identity. The
  // kill-shot on `parts.length !== 2` found the first of these with nothing failing.

  it('is refused when a third dot-separated part is appended', async () => {
    const { token } = await issueSession(secret, t0)

    expect(await verifySession(`${token}.anything`, secret, t0)).toBe(false)
  })

  it('is refused when an empty third part is appended', async () => {
    const { token } = await issueSession(secret, t0)

    expect(await verifySession(`${token}.`, secret, t0)).toBe(false)
  })

  it('is refused when the signature is respelled in standard base64', async () => {
    // base64url's `-` and `_` stand for base64's `+` and `/`. Decoding both spellings
    // — which is what dropping the alphabet check does, because the replace step
    // leaves a literal `+` untouched and `atob` accepts it — would make two
    // different cookie values one session.
    const respelled = await tokenWithRespelledSignature()

    expect(await verifySession(respelled, secret, t0)).toBe(false)
  })

  /**
   * A token whose signature has `-`/`_` rewritten as `+`/`/`.
   *
   * The expiry is walked until a signature contains one of the two characters,
   * because whether it does is a property of the HMAC output rather than something
   * the test can choose. It throws rather than skipping if none is found: a test
   * that silently passes by testing nothing is the thing this whole file is about.
   */
  async function tokenWithRespelledSignature(): Promise<string> {
    for (let offset = 0; offset < 200; offset++) {
      const { token } = await issueSession(secret, t0 + offset)
      const [expiry, signature] = token.split('.') as [string, string]
      if (!/[-_]/.test(signature)) continue
      return `${expiry}.${signature.replace(/-/g, '+').replace(/_/g, '/')}`
    }
    throw new Error('no signature in 200 tries contained a base64url-specific character')
  }
})

describe('the work an unauthenticated caller can ask for', () => {
  // Two of verifySession's checks — the token length cap and the expiry pattern —
  // cannot change the *answer*: a token over the cap can never carry a 32-byte
  // signature, and an expiry `Number()` mangles can never carry a signature this
  // deployment produced. Asserting only the answer therefore tests them not at all,
  // which the kill-shot on card rule 6 proved by removing both without a single
  // test noticing.
  //
  // What they do change is the work done before the answer, so that is what is
  // asserted: how many times a caller's own bytes reach `atob` and `crypto.subtle`.
  // Each assertion is paired with a control showing the counter *can* move, or the
  // test would pass by counting nothing.

  async function counting<T>(body: () => Promise<T>): Promise<{ decodes: number; signs: number }> {
    const realAtob = globalThis.atob
    const realSign = crypto.subtle.sign.bind(crypto.subtle)
    const subtle = crypto.subtle as unknown as { sign: typeof crypto.subtle.sign }
    let decodes = 0
    let signs = 0

    globalThis.atob = (value: string) => {
      decodes += 1
      return realAtob(value)
    }
    subtle.sign = (...args: Parameters<typeof crypto.subtle.sign>) => {
      signs += 1
      return realSign(...args)
    }

    try {
      await body()
    } finally {
      globalThis.atob = realAtob
      subtle.sign = realSign
    }
    return { decodes, signs }
  }

  const validSignature = 'A'.repeat(43)

  it('does not decode a token past the length cap', async () => {
    const { decodes } = await counting(() =>
      verifySession(`1785000000.${'A'.repeat(200)}`, secret, t0),
    )

    expect(decodes).toBe(0)
  })

  it('does decode one inside the cap, so the count above is about the cap', async () => {
    const { decodes } = await counting(() =>
      verifySession(`1785000000.${validSignature}`, secret, t0),
    )

    expect(decodes).toBe(1)
  })

  it('does no HMAC work for an expiry Number() would mangle', async () => {
    const { signs } = await counting(() => verifySession(`1e12.${validSignature}`, secret, t0))

    expect(signs).toBe(0)
  })

  it('does no HMAC work for a negative expiry either', async () => {
    const { signs } = await counting(() =>
      verifySession(`-1785000000.${validSignature}`, secret, t0),
    )

    expect(signs).toBe(0)
  })

  it('does HMAC work for a well-formed expiry, so the counts above are about the pattern', async () => {
    const { signs } = await counting(() =>
      verifySession(`1785000000.${validSignature}`, secret, t0),
    )

    expect(signs).toBeGreaterThan(0)
  })
})

describe('the session cookie', () => {
  const cookie = sessionCookie('1785000000.signature')

  it('is scoped to /admin, which is what keeps card rule 8 true', () => {
    expect(cookie).toContain(`Path=${SESSION_COOKIE_PATH}`)
    expect(SESSION_COOKIE_PATH).toBe('/admin')
  })

  it('is never scoped to the whole origin, where every reader request would carry it', () => {
    expect(cookie).not.toMatch(/Path=\/(?![a-z])/)
  })

  it('cannot be read by script on the dashboard page', () => {
    expect(cookie).toContain('HttpOnly')
  })

  it('never crosses plaintext', () => {
    expect(cookie).toContain('Secure')
  })

  it('is not sent on a cross-site request at all — the first CSRF layer', () => {
    expect(cookie).toContain('SameSite=Strict')
  })

  it('expires, rather than standing until someone signs out', () => {
    expect(cookie).toContain(`Max-Age=${SESSION_LIFETIME_SECONDS}`)
  })

  it('carries the __Secure- prefix, which browsers enforce the Secure flag for', () => {
    expect(cookie.startsWith('__Secure-charcha_session=')).toBe(true)
  })

  it('is not __Host-, which would mandate Path=/ and attach it to every read', () => {
    expect(SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(false)
  })
})

describe('the cleared cookie', () => {
  const cleared = clearedSessionCookie()

  it('expires the cookie immediately', () => {
    expect(cleared).toContain('Max-Age=0')
  })

  it('names the same path, or the browser keeps the original beside it', () => {
    expect(cleared).toContain(`Path=${SESSION_COOKIE_PATH}`)
  })

  it('names the same cookie', () => {
    expect(cleared.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
  })
})

describe('reading the cookie off a request', () => {
  it('finds the session among other cookies', () => {
    const request = withCookie(`theme=dark; ${SESSION_COOKIE_NAME}=abc.def; lang=en`)

    expect(readSessionCookie(request)).toBe('abc.def')
  })

  it('finds it when it is the only one', () => {
    expect(readSessionCookie(withCookie(`${SESSION_COOKIE_NAME}=abc.def`))).toBe('abc.def')
  })

  it('is null when the request carries no cookies at all', () => {
    expect(readSessionCookie(new Request('https://charcha.example/admin/api/queue'))).toBeNull()
  })

  it('is null when another cookie merely ends with the same name', () => {
    expect(readSessionCookie(withCookie(`x__Secure-charcha_session=abc.def`))).toBeNull()
  })

  it('is null when another cookie merely starts with the same name', () => {
    expect(readSessionCookie(withCookie(`${SESSION_COOKIE_NAME}_old=abc.def`))).toBeNull()
  })

  it('is null when the value is empty', () => {
    expect(readSessionCookie(withCookie(`${SESSION_COOKIE_NAME}=`))).toBeNull()
  })

  it('is null for a Cookie header past the cap, before anything is split', () => {
    const padding = `pad=${'x'.repeat(5000)}`

    expect(readSessionCookie(withCookie(`${padding}; ${SESSION_COOKIE_NAME}=abc.def`))).toBeNull()
  })
})
