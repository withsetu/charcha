import { GlobeIcon } from 'lucide-react'

import type { Settings } from '../../../api'
import { Button } from '../../../ui/button'
import { Skeleton } from '../../../ui/skeleton'
import { DOCS, type Load, OutboundLink, ReadFailed, Section } from '../primitives'

/**
 * The allowlist — the one item here that lives in the database rather than on `env`, and
 * so the one that is editable.
 *
 * It reads `GET /admin/api/settings` and hands editing to the dialog the header already
 * opens, rather than growing a second write path beside src/admin/settings.ts. No On/Off
 * badge: an empty list is a working default, not a feature that is switched off — a fresh
 * deployment accepts comments from its own address without anything being stored (#57).
 *
 * One paragraph now (#216), whatever is stored: the rule, this deployment's answer, and
 * the button. What a browser origin rule does and does not stop is on charcha.dev.
 */
export function OriginsSection({ load, onEdit }: { load: Load<Settings>; onEdit: () => void }) {
  return (
    <Section title="Allowed origins" status={null}>
      {load.kind === 'loading' && <Skeleton className="h-3 w-3/5" />}

      {load.kind === 'failed' && (
        <ReadFailed what="Could not read the allowed origins" failure={load.failure} />
      )}

      {load.kind === 'ready' && (
        <>
          {/*
            One paragraph in every state, so the empty case does not grow a second. The
            clauses are guarded individually rather than the paragraph: `selfOrigin` is
            `''` when the request URL will not normalise (src/admin/settings.ts), and the
            opening sentence is true either way.
          */}
          <p>
            A page on any of these addresses may post comments here; a page anywhere else is
            refused. {load.value.allowedOrigins.length === 0 && <b>No addresses listed yet.</b>}{' '}
            {load.value.selfOrigin !== '' && (
              <>
                This deployment’s own address, <code>{load.value.selfOrigin}</code>, is always
                allowed without being listed
                {load.value.allowedOrigins.length === 0 &&
                  ', but your site is a different address and has to be added before a page there can comment'}
                .{' '}
              </>
            )}
            <OutboundLink href={DOCS.origins}>Adding your site</OutboundLink>.
          </p>
          {load.value.allowedOrigins.length > 0 && (
            <ul className="space-y-1">
              {load.value.allowedOrigins.map((origin) => (
                <li key={origin}>
                  <code className="text-foreground">{origin}</code>
                </li>
              ))}
            </ul>
          )}
          <Button variant="outline" size="sm" onClick={onEdit}>
            <GlobeIcon aria-hidden="true" />
            Edit allowed origins
          </Button>
        </>
      )}
    </Section>
  )
}
