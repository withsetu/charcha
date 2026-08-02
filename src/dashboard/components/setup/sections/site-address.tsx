import * as React from 'react'

import type { Settings } from '../../../api'
import { servedBySecret, writeSiteUrl } from '../../../api'
import { Skeleton } from '../../../ui/skeleton'
import {
  DOCS,
  Field,
  type Load,
  OutboundLink,
  ReadFailed,
  SaveRow,
  Section,
  ServedBySecret,
  useSettingsSave,
} from '../primitives'

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
  const { busy, save, status, saveFailed } = useSettingsSave(
    onExpired,
    (settings) => {
      setDraft(settings.siteUrl)
      onSaved(settings)
    },
    'Site address',
  )

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
            the address a comment reports is chosen by whoever posted it.{' '}
            <OutboundLink href={DOCS.siteAddress}>What reads it</OutboundLink>.
          </p>
          {load.value.fromDeprecatedSecrets.includes('site_url') && (
            <ServedBySecret names={['CHARCHA_SITE_URL']} />
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
                  <code>https://you.github.io/blog</code> if your site lives at a path.
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
