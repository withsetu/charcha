import * as React from 'react'
import { TriangleAlertIcon } from 'lucide-react'

import type { Settings } from '../../../api'
import { servedBySecret, writeSiteUrl } from '../../../api'
import { Alert, AlertDescription, AlertTitle } from '../../../ui/alert'
import { Skeleton } from '../../../ui/skeleton'
import { Field, type Load, ReadFailed, SaveRow, Section, useSettingsSave } from '../primitives'

/**
 * The site's own address (#207) — the setting that used to be `CHARCHA_SITE_URL`.
 *
 * **It is here because almost nobody had it, and that was the problem.** It was optional,
 * deliberately off the deploy form (#139), and the only thing that read it was a spam
 * layer that is also off by default — so a deployer had no reason to set it and no way to
 * learn it would ever buy them anything. A field beside the allowlist is where somebody
 * finds out.
 *
 * **No On/Off badge**, for the reason `OriginsSection` has none: an empty value is a
 * working default rather than a feature that is switched off. Nothing about this
 * deployment stops working without it; what it unlocks is named in the copy instead.
 * Enforced by test/dashboard/setup.test.tsx.
 */
export function SiteAddressSection({
  load,
  onExpired,
  onSaved,
}: {
  load: Load<Settings>
  onExpired: () => void
  onSaved: (settings: Settings) => void
}) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const id = React.useId()
  const { busy, save, status, saveFailed } = useSettingsSave(onExpired, (settings) => {
    setDraft(settings.siteUrl)
    onSaved(settings)
  })

  return (
    <Section title="Your site’s address" status={null}>
      {load.kind === 'loading' && <Skeleton className="h-3 w-3/5" />}
      {load.kind === 'failed' && (
        <ReadFailed what="Could not read your site’s address" failure={load.failure} />
      )}

      {load.kind === 'ready' && (
        <>
          <p>
            The home page of the site this deployment takes comments for. Nothing can work it out:
            this Worker’s own address is a <code>workers.dev</code> URL rather than your site, and
            the address a comment reports is chosen by whoever posted it.
          </p>
          {load.value.fromDeprecatedSecrets.includes('site_url') && (
            <Alert>
              <TriangleAlertIcon />
              <AlertTitle>This is still coming from a secret you set with wrangler</AlertTitle>
              <AlertDescription>
                <p>
                  It keeps working. The field below is empty because nothing has been saved here yet
                  — Charcha will not show you a value out of a secret. Save it here, and you can
                  then remove <code>CHARCHA_SITE_URL</code> with <code>wrangler secret delete</code>
                  .
                </p>
              </AlertDescription>
            </Alert>
          )}
          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              const value = draft ?? load.value.siteUrl
              // The same rule `NotifyFields` follows: an empty box that is empty because
              // a secret is supplying the value is not an instruction to clear it. There
              // is nothing to send, so the save is a no-op rather than a row write.
              if (value === '' && servedBySecret(load.value, 'site_url')) return
              save(() => writeSiteUrl(value))
            }}
          >
            <Field
              id={`${id}-site-url`}
              type="url"
              label="Home page address"
              placeholder="https://example.com"
              value={draft ?? load.value.siteUrl}
              disabled={busy}
              invalid={saveFailed}
              onChange={setDraft}
              hint={
                <>
                  Include the scheme — <code>https://example.com</code>, or{' '}
                  <code>https://you.github.io/blog</code> if your site lives at a path. A
                  third-party spam service needs it to identify your site, and it is the base for
                  the link to a commented page.
                </>
              }
            />
            {status}
            <SaveRow busy={busy} label="Save site address" />
          </form>
        </>
      )}
    </Section>
  )
}
