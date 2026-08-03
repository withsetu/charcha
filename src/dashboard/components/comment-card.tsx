// One row of the queue.
//
// The row is the focus target, not a link inside it, because the keyboard is the
// primary interface: `J` and `K` move focus from row to row and a screen reader reads
// the row it lands on, which is what makes navigation self-announcing. The buttons
// inside it are the mouse-and-assistive-technology fallback for the same three
// decisions the keys make, reachable with Tab from the focused row.
//
// Enforced by test/dashboard/triage.test.tsx.

import * as React from 'react'
import { CheckIcon, ExternalLinkIcon, ShieldAlertIcon, Trash2Icon, ZapIcon } from 'lucide-react'

import type { DecisionStatus, QueuedComment } from '../api'
import { formatAge, formatExact, isoInstant, pageLabel } from '../format'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Kbd } from '../ui/kbd'
import { cn } from '../ui/utils'
import { CommentBody } from './comment-body'

export interface CommentCardProps {
  comment: QueuedComment
  current: boolean
  /** The row's 1-based position and the list length, for the accessible name. */
  position: number
  total: number
  /** Seconds since the epoch, passed in so the row does not read a clock per render. */
  now: number
  busy: boolean
  onFocus: (id: number) => void
  onDecide: (id: number, status: DecisionStatus) => void
}

/** The three decisions, as buttons — the same order as the keys A, S, D. */
const DECISIONS: readonly {
  status: DecisionStatus
  label: string
  key: string
  icon: typeof CheckIcon
  variant: 'default' | 'outline' | 'destructive'
}[] = [
  { status: 'approved', label: 'Approve', key: 'A', icon: CheckIcon, variant: 'default' },
  { status: 'spam', label: 'Spam', key: 'S', icon: ShieldAlertIcon, variant: 'outline' },
  { status: 'deleted', label: 'Delete', key: 'D', icon: Trash2Icon, variant: 'outline' },
]

/**
 * Whether the moderation policy published this comment rather than a person (#173).
 *
 * **There is no column for this, and there deliberately is not one — the three fields
 * already say it.** A comment is `approved`, was not written by the owner, and has no
 * `moderated_at`: nothing else in the Worker produces that combination, because the only
 * ways into `approved` are the owner's own composer (`by_owner = 1`), a moderation
 * decision (which sets `moderated_at`), and the trust decision (which sets neither).
 * Enforced by test/worker/db/comments.test.ts, which asserts each of the three writers
 * against this shape, and test/dashboard/triage.test.tsx.
 */
function autoApproved(comment: QueuedComment): boolean {
  return comment.status === 'approved' && !comment.byOwner && comment.moderatedAt === null
}

export function CommentCard({
  comment,
  current,
  position,
  total,
  now,
  busy,
  onFocus,
  onDecide,
}: CommentCardProps) {
  const row = React.useRef<HTMLDivElement>(null)
  const page = pageLabel(comment.pageTitle, comment.pageKey)

  // Focus follows `current`, which is what makes `J`/`K` move the caret rather than
  // only a highlight — and the reason a screen reader announces the new row without
  // any live region. `preventScroll: false` is the default and is wanted: the row has
  // to be on screen for the sighted keyboard user too.
  React.useEffect(() => {
    if (current && row.current !== null && document.activeElement !== row.current) {
      row.current.focus()
    }
  }, [current])

  return (
    <li>
      <div
        ref={row}
        // A group rather than an `option`: an ARIA option may not contain interactive
        // descendants, and every row here has three buttons in it. `role="group"` with
        // an accessible name is what lets a screen reader announce the row as a unit
        // and then let the user move into its controls.
        role="group"
        aria-label={`Comment ${String(position)} of ${String(total)}, by ${comment.authorName}, on ${page}`}
        // Roving tabindex: exactly one row is in the tab order at a time, so Tab from
        // the list goes to the current row's buttons rather than through 200 rows.
        tabIndex={current ? 0 : -1}
        aria-current={current ? 'true' : undefined}
        aria-busy={busy || undefined}
        onFocus={() => {
          onFocus(comment.id)
        }}
        className={cn(
          'rounded-xl border bg-card p-4 text-card-foreground transition-colors sm:p-5',
          current ? 'charcha-current bg-accent/40' : 'hover:bg-accent/20',
          busy && 'opacity-60',
        )}
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-medium">{comment.authorName}</span>
          {comment.byOwner && (
            <Badge variant="secondary" className="translate-y-[-1px]">
              You
            </Badge>
          )}
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
          <time
            dateTime={isoInstant(comment.createdAt)}
            title={formatExact(comment.createdAt)}
            className="text-sm text-muted-foreground"
          >
            {formatAge(comment.createdAt, now)}
          </time>
          {comment.depth > 0 && (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <span className="text-sm text-muted-foreground">reply</span>
            </>
          )}
        </div>

        {/*
          The page, and a link to it when the Worker could build one honestly (#203).

          **The href is `comment.permalink` and nothing else may be joined to make one.**
          `pageKey` is a path with the origin deliberately dropped and `page_url` is
          whatever origin the comment reported, so a link assembled here would put an
          attacker's address in the owner's own queue, a click from the buttons below it.
          The Worker joins the derived key to the owner's `site_url` setting instead, and
          sends null when it cannot — a `data-thread` key, or no address saved — which is
          this branch showing exactly what the card showed before.

          A new tab, because the moderator is part-way down a queue that keyboard focus is
          holding their place in, and `noopener noreferrer` because the page it opens is
          the site's own but the queue behind it is the moderation dashboard.
          Enforced by test/dashboard/triage.test.tsx.
        */}
        <p className="mt-0.5 truncate text-sm text-muted-foreground">
          <span className="sr-only">On page: </span>
          {comment.permalink === null ? (
            page
          ) : (
            <a
              className="underline underline-offset-4 hover:text-foreground"
              href={comment.permalink}
              target="_blank"
              rel="noopener noreferrer"
              // The row is the focus target and `J`/`K` move between rows, so this is a
              // tab stop only inside the row the moderator is on — the same roving
              // tabindex the decision buttons below use, for the same reason.
              tabIndex={current ? 0 : -1}
            >
              {page}
              <ExternalLinkIcon aria-hidden="true" className="ml-1 inline size-3 align-baseline" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </p>

        {autoApproved(comment) && (
          // The accountability half of #173. Under `trust-returning` a comment can be on
          // the site before the owner has seen it, and without this the Approved tab
          // shows it indistinguishably from one they approved themselves — so the one
          // question the policy raises, *what went out without me?*, would have no answer
          // anywhere. It carries the reason with it, the same shape the Held badge uses,
          // because "auto-approved" alone does not say on what grounds.
          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <ZapIcon aria-hidden="true" />
              Auto-approved
            </Badge>
            <span className="text-xs text-muted-foreground">
              You approved this commenter before. Marking this as spam stops that.
            </span>
          </p>
        )}

        {comment.spamReason !== null && (
          // #70's reason, and the whole point of it: it turns triage from reading
          // every comment into confirming a judgement. It is a layer's internal token
          // rather than prose, so it is presented as one — a label, monospaced,
          // introduced by a word that says what it is.
          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <ShieldAlertIcon aria-hidden="true" />
              Held
            </Badge>
            <span className="sr-only">Reason: </span>
            <code className="font-mono text-xs text-muted-foreground">{comment.spamReason}</code>
          </p>
        )}

        <div className="mt-3">
          <CommentBody body={comment.body} />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {DECISIONS.map((decision) => (
            <Button
              key={decision.status}
              size="sm"
              variant={decision.variant}
              disabled={busy}
              // Tab order within the row only. A row that is not current keeps its
              // buttons out of the tab sequence, so Tab never walks the whole queue.
              tabIndex={current ? 0 : -1}
              onClick={() => {
                onDecide(comment.id, decision.status)
              }}
            >
              <decision.icon aria-hidden="true" />
              {decision.label}
              <Kbd aria-hidden="true">{decision.key}</Kbd>
            </Button>
          ))}
        </div>
      </div>
    </li>
  )
}
