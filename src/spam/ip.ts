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
 * IPv4 is the address itself. **IPv6 is truncated to its /64 prefix**, and that is
 * a correctness fix rather than a nicety: a residential IPv6 customer is handed a
 * /64, so one machine can source 2^64 distinct addresses at no cost. Rate limiting
 * per full IPv6 address is therefore not rate limiting at all — it is a counter an
 * attacker resets by incrementing. The /64 is the smallest block that is reliably
 * one subscriber.
 *
 * It cuts the other way too, and in the direction this project prefers: the stored
 * identifier is now deliberately coarser than an address, so a hash that leaked
 * would locate a household rather than a machine.
 *
 * An address that does not parse is passed through unchanged. That fails towards
 * treating it as its own key, which is exactly today's behaviour and never merges
 * two commenters into one bucket.
 * Enforced by test/worker/spam/ip.test.ts.
 */
export function normaliseIp(ip: string): string {
  const address = ip.trim().toLowerCase()
  if (!address.includes(':')) return address

  const groups = expandIpv6(address)
  if (groups === null) return address

  // Leading zeros are stripped per group, because `2001:0db8:0000:0000::1` and
  // `2001:db8::1` are the same address written twice. Without this they would
  // hash differently and the limit would count one commenter as two.
  const prefix = groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, ''))
  return `${prefix.join(':')}::/64`
}

/** The eight 16-bit groups of an IPv6 address, or null if it is not one. */
function expandIpv6(address: string): string[] | null {
  const halves = address.split('::')
  if (halves.length > 2) return null

  const parse = (part: string) => (part === '' ? [] : part.split(':'))
  const head = parse(halves[0] ?? '')
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : []

  // A trailing dotted quad (::ffff:203.0.113.9) is one IPv4 address, not two
  // groups, and truncating it to a /64 would put the whole of IPv4 in one bucket.
  if ([...head, ...tail].some((group) => group.includes('.'))) return null
  if (![...head, ...tail].every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null

  if (halves.length === 1) return head.length === 8 ? head : null

  const missing = 8 - head.length - tail.length
  if (missing < 1) return null
  return [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
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
