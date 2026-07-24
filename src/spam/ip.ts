// Turning a connection into the identifier layer 4 counts, and nothing else.
//
// The raw address never leaves this module: it is read from the header, hashed,
// and the hash is what every other file sees. `comments.ip_hash` stores that hash,
// #19's Cron Trigger deletes it on a retention window, and no log line anywhere
// carries either form.
// Enforced by test/worker/spam/ip.test.ts, and the "no IP in the record" half by
// test/worker/spam/log.test.ts.

/**
 * The client address Cloudflare put on the request.
 *
 * `CF-Connecting-IP` and nothing else — deliberately not `X-Forwarded-For`, which
 * a client sets freely and which would make the per-IP rate limit bypassable by
 * anyone who read this file. Cloudflare overwrites `CF-Connecting-IP` on every
 * request that reaches a Worker, so it is the one header here that a caller
 * cannot choose.
 * https://developers.cloudflare.com/fundamentals/reference/http-headers/
 */
export function clientIp(request: Request): string | null {
  const value = request.headers.get('CF-Connecting-IP')?.trim()
  return value === undefined || value === '' ? null : value
}

/**
 * What "the same commenter" means, before anything is hashed.
 *
 * IPv4 is the address itself. **IPv6 is folded to its /64 prefix**, and that is a
 * correctness fix rather than a nicety: a residential IPv6 customer is handed a
 * /64, so one machine can source 2^64 distinct addresses at no cost. Rate limiting
 * per full IPv6 address is therefore not rate limiting at all — it is a counter an
 * attacker resets by incrementing. The /64 is the smallest block that is reliably
 * one subscriber.
 *
 * It cuts the other way too, and in the direction this project prefers: the folded
 * identifier is deliberately coarser than an address, so a hash that leaked would
 * locate a household rather than a machine.
 *
 * **An address carrying an IPv4 address in its low 32 bits is never folded.**
 * `::ffff:0:0/96` (IPv4-mapped) and `64:ff9b::/96` (the well-known NAT64 prefix,
 * which is live on real mobile carriers) both put the whole IPv4 internet inside
 * one /64. Folding those would count every IPv4 commenter as one person, so one
 * flooder would take a site's comments down for a whole carrier's subscribers.
 * They keep their full address as the key.
 *
 * Every form is decided on the *numbers*, never the spelling: `::ffff:203.0.113.9`
 * and `::ffff:cb00:7109` are one address written twice and must produce one key,
 * or the counter resets whenever the writing changes.
 *
 * Output is namespaced (`v6:` / `v6-64:`) so a folded prefix can never collide
 * with a literal address spelled the same way.
 *
 * An address that does not parse keeps itself as its key. That never merges two
 * commenters into one bucket, which is the direction to fail in.
 * Enforced by test/worker/spam/ip.test.ts.
 */
export function normaliseIp(ip: string): string {
  const address = ip.trim().toLowerCase()
  if (!address.includes(':')) return address

  const groups = expandIpv6(address)
  if (groups === null) return `v6:${address}`
  if (embedsIpv4(groups)) return `v6:${groups.join(':')}`

  return `v6-64:${groups.slice(0, 4).join(':')}`
}

/**
 * Whether this address's low 32 bits are an IPv4 address, so folding it to a /64
 * would collapse the whole of IPv4 into one key. See normaliseIp.
 *
 * The all-zero prefix covers `::ffff:0:0/96`, the deprecated IPv4-compatible
 * `::a.b.c.d`, and `::1` — none of which name one subscriber.
 */
function embedsIpv4(groups: readonly string[]): boolean {
  const zeroPrefix = groups.slice(0, 4).every((group) => group === '0')
  const nat64 = groups[0] === '64' && groups[1] === 'ff9b' && groups[2] === '0' && groups[3] === '0'
  return zeroPrefix || nat64
}

/**
 * The eight 16-bit groups of an IPv6 address, canonicalised, or null if it is not
 * one.
 *
 * Leading zeros are stripped per group, because `2001:0db8:0000:0000::1` and
 * `2001:db8::1` are the same address written twice — without this they would hash
 * differently and one commenter would count as two. A trailing dotted quad becomes
 * the two groups it stands for, for exactly the same reason.
 */
function expandIpv6(address: string): string[] | null {
  const halves = address.split('::')
  if (halves.length > 2) return null

  const split = (part: string) => (part === '' ? [] : part.split(':'))
  const head = canonicalise(split(halves[0] ?? ''))
  const tail = canonicalise(split(halves[1] ?? ''))
  if (head === null || tail === null) return null

  if (halves.length === 1) return head.length === 8 ? head : null

  const missing = 8 - head.length - tail.length
  if (missing < 1) return null
  return [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
}

/** One side of an address, as canonical groups, or null if any part is not one. */
function canonicalise(parts: readonly string[]): string[] | null {
  const groups: string[] = []
  for (const [index, part] of parts.entries()) {
    if (part.includes('.')) {
      // A dotted quad is only ever the last part, and stands for two groups.
      if (index !== parts.length - 1) return null
      const quad = dottedQuadToGroups(part)
      if (quad === null) return null
      groups.push(...quad)
      continue
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    groups.push(part.replace(/^0+(?=.)/, ''))
  }
  return groups
}

/** `203.0.113.9` becomes `['cb00', '7109']`, or null if it is not a dotted quad. */
function dottedQuadToGroups(part: string): string[] | null {
  const octets = part.split('.')
  if (octets.length !== 4) return null

  const values: number[] = []
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null
    const value = Number(octet)
    if (value > 255) return null
    values.push(value)
  }

  const high = ((values[0] as number) << 8) | (values[1] as number)
  const low = ((values[2] as number) << 8) | (values[3] as number)
  return [high.toString(16), low.toString(16)]
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'))

/**
 * HMAC-SHA-256 of an address under the deployment's own secret, as hex.
 *
 * Keyed rather than a plain digest, and that is not decoration: the whole IPv4
 * space is four billion values, so an unkeyed SHA-256 of an address is reversible
 * by anyone with a laptop and an afternoon. The key is what makes the stored
 * column an identifier rather than the address itself, which is the claim
 * `migrations/0001_initial.sql` and #17's disclosure text both make.
 *
 * The address is normalised first — see normaliseIp — so this is a hash of "the
 * commenter", not of a string the commenter chose how to write.
 */
export async function hashIp(ip: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(normaliseIp(ip)))
  const view = new Uint8Array(signature)

  let hex = ''
  for (let index = 0; index < view.length; index++) hex += HEX[view[index] as number]
  return hex
}

/**
 * The one reading of `IP_HASH_SECRET` that both sides of the guard use.
 *
 * The value is written by the submission pipeline and read by the rate limit, and
 * they must derive the *same* key or the limit counts hashes nobody is writing —
 * which is #65 all over again, silently. A secret pasted into a dashboard with a
 * trailing newline is the likely way that happens, so it is trimmed here once
 * rather than trimmed on one side and not the other.
 *
 * Blank is `null`, not a key: an unkeyed HMAC of an address is reversible by
 * anyone willing to walk the address space, so storing nothing is strictly better
 * than storing that.
 * Enforced by test/worker/submit/ip-hash.test.ts.
 */
export function usableIpSecret(secret: string | undefined): string | null {
  const trimmed = secret?.trim()
  return trimmed === undefined || trimmed === '' ? null : trimmed
}
