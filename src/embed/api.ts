// The embed's half of the contract with the Worker: the URL it reads from, the JSON
// it posts, and how a refusal becomes a sentence a reader can act on.
//
// Pure — no fetch here. The network call lives in mount.ts, so that everything with
// a decision in it can be tested without one.
// Enforced by test/worker/embed/api.test.ts.

/** Both halves of the public contract live at the same path (#46, #7). */
const COMMENTS_PATH = '/comments'

/**
 * How much of the server's own answer the embed will repeat to a reader.
 *
 * The Worker's error bodies are one short plain-text sentence by design
 * (src/submit/route.ts), so anything longer is not one of them — the base address
 * is owner configuration and can point anywhere, including at something that is not
 * a Charcha deployment at all. Capping is how a misconfiguration stays a message
 * rather than becoming a wall of somebody else's text on the reader's page.
 */
export const MAX_SERVER_MESSAGE_LENGTH = 200

/**
 * When the failure is not the reader's to fix.
 *
 * Deliberately not the server's words: a 500 body is for the site owner reading
 * logs, and "Internal error" on a reader's screen tells them nothing they can act
 * on while sounding like they broke something.
 */
const GENERIC_WRITE_FAILURE = 'Your comment could not be posted. Please try again.'

/**
 * The statuses whose bodies are written for the reader.
 *
 * 400 is their input, 403 is the spam refusal, 413 is the size guard — all three
 * are one concise line from src/submit/route.ts. Everything else is either a fault
 * on our side or a response from something that is not this Worker.
 */
const READER_FACING_STATUSES = new Set([400, 403, 413])

/** The comments on a page, as the HTML the Worker renders (#1 — HTML, never JSON). */
export function readUrl(api: string, pageUrl: string, thread: string | null): string {
  const url = new URL(api + COMMENTS_PATH)
  // Through URLSearchParams rather than string concatenation: the page's own query
  // string is full of `?` and `&`, and splicing it in is how one page ends up
  // reading another page's conversation.
  url.searchParams.set('url', pageUrl)
  if (thread !== null) url.searchParams.set('thread', thread)
  return url.toString()
}

export function submitUrl(api: string): string {
  return api + COMMENTS_PATH
}

export interface SubmissionInput {
  body: string
  authorName: string
  authorEmail: string
  parentId: number | null
  pageUrl: string
  thread: string | null
  title: string
  /**
   * How long the form has been open, in milliseconds, measured with
   * `performance.now()`. A duration and never a timestamp — a duration carries no
   * clock to disagree with the server's, so the whole class of clock-skew false
   * positives does not exist (#8).
   */
  elapsedMs: number
  /** Present only when the owner configured Turnstile and the widget produced one. */
  turnstileToken: string | null
}

/**
 * The JSON body of a submission.
 *
 * Three of these keys are not part of the comment and are not in
 * src/submit/schema.ts — `subject`, `t` and `cf-turnstile-response` arrive through
 * the raw form the spam seam is handed (#8). The names are frozen on both sides:
 * renaming one here disarms a layer on every deployment still serving a cached
 * embed.js, silently, and only on the attack path.
 *
 * Optional fields are omitted rather than sent empty. The schema turns `""` into
 * absent anyway, so this is not correctness — it is that a body which says only
 * what the reader actually gave is the one that is obvious to read in a log.
 */
export function submissionBody(input: SubmissionInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    body: input.body,
    authorName: input.authorName,
    url: input.pageUrl,
    // Always the honeypot, always empty. No label, out of the tab order, and never
    // a name a browser will autofill — see markup.ts.
    subject: '',
    // Rounded and floored at zero: `performance.now()` is fractional, and a
    // negative duration is not a thing the server should have to reason about.
    t: Math.max(0, Math.round(input.elapsedMs)),
  }

  if (input.authorEmail.trim() !== '') body['authorEmail'] = input.authorEmail.trim()
  if (input.parentId !== null) body['parentId'] = input.parentId
  if (input.thread !== null) body['thread'] = input.thread
  if (input.title.trim() !== '') body['title'] = input.title.trim()
  if (input.turnstileToken !== null && input.turnstileToken !== '') {
    body['cf-turnstile-response'] = input.turnstileToken
  }

  return body
}

/**
 * What the reader is told when their comment was not accepted.
 *
 * The status carries the taxonomy — src/submit/route.ts maps every outcome onto one
 * — so this never parses a body to find out what happened. It only decides whether
 * the body is a sentence written for the reader, and passes it through if so.
 *
 * Whatever comes back is normalised before it is used: control characters removed,
 * whitespace collapsed, length capped, and anything containing markup refused
 * outright. The embed writes this through `textContent` and never through
 * `innerHTML`, so this is the second lock rather than the first — but the base
 * address is owner configuration, and "the response came from our Worker" is an
 * assumption rather than a fact.
 */
export function messageForWriteFailure(status: number, text: string): string {
  if (!READER_FACING_STATUSES.has(status)) return GENERIC_WRITE_FAILURE

  const cleaned = text
    // eslint-disable-next-line no-control-regex -- matching them is the point; they are what is being removed
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (cleaned === '') return GENERIC_WRITE_FAILURE
  if (/[<>]/.test(cleaned)) return GENERIC_WRITE_FAILURE
  if (cleaned.length > MAX_SERVER_MESSAGE_LENGTH) {
    return cleaned.slice(0, MAX_SERVER_MESSAGE_LENGTH) + '…'
  }
  return cleaned
}
