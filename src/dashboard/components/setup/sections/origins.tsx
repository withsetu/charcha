import { GlobeIcon } from 'lucide-react'

import type { Settings } from '../../../api'
import { Button } from '../../../ui/button'
import { Skeleton } from '../../../ui/skeleton'
import { type Load, ReadFailed, Section } from '../primitives'

/**
 * The allowlist — the one item here that lives in the database rather than on `env`, and
 * so the one that is editable.
 *
 * It reads `GET /admin/api/settings` and hands editing to the dialog the header already
 * opens, rather than growing a second write path beside src/admin/settings.ts. No On/Off
 * badge: an empty list is a working default, not a feature that is switched off — a
 * fresh deployment accepts comments from its own address without anything being stored
 * (#57).
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
          <p>
            A page on any of these addresses may post comments to this deployment; a page anywhere
            else is refused. That is a browser rule, so what it stops is another site’s page posting
            from a reader’s browser. It is not what stops a script — that is the spam layers and
            this queue.
          </p>
          {load.value.allowedOrigins.length === 0 ? (
            <p>
              No addresses listed yet.{' '}
              {load.value.selfOrigin !== '' && (
                <>
                  This deployment’s own address, <code>{load.value.selfOrigin}</code>, is always
                  allowed without being listed — but your site is a different address, so it has to
                  be added before a page there can comment.
                </>
              )}
            </p>
          ) : (
            <>
              <ul className="space-y-1">
                {load.value.allowedOrigins.map((origin) => (
                  <li key={origin}>
                    <code className="text-foreground">{origin}</code>
                  </li>
                ))}
              </ul>
              {load.value.selfOrigin !== '' && (
                <p>
                  This deployment’s own address, <code>{load.value.selfOrigin}</code>, is allowed as
                  well, without being listed.
                </p>
              )}
            </>
          )}
          <p>
            This is a Charcha setting. It is not Turnstile’s hostname list, which governs where the
            widget may render and does nothing here.
          </p>
          <Button variant="outline" size="sm" onClick={onEdit}>
            <GlobeIcon aria-hidden="true" />
            Edit allowed origins
          </Button>
        </>
      )}
    </Section>
  )
}
