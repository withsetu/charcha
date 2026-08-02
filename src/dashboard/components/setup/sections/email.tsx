import * as React from 'react'
import { TriangleAlertIcon } from 'lucide-react'

import type { SetupSecret, Settings } from '../../../api'
import { servedBySecret, writeNotifySettings } from '../../../api'
import { Alert, AlertDescription, AlertTitle } from '../../../ui/alert'
import { Skeleton } from '../../../ui/skeleton'
import {
  Field,
  HowToSet,
  type Load,
  Off,
  On,
  ReadFailed,
  SaveRow,
  Section,
  SecretRow,
  useSettingsSave,
} from '../primitives'

/**
 * The one secret email notifications still need (#207).
 *
 * It used to be three. The other two were the owner's own addresses rather than
 * credentials, so they are `settings` rows now and this section *edits* them instead of
 * telling the owner to open a terminal — see `NotifyFields` below.
 *
 * Still a list rather than a bare constant: it is what the command block and the status
 * row map over, and a second provider's key (#158 says not to hard-code Resend) joins it
 * here rather than by rewriting the section. Typed against `SetupSecret`, which is what
 * makes a rename on the Worker's side a type error here instead of a section that quietly
 * reports a feature it is no longer asking about.
 */
const EMAIL_SECRETS = ['RESEND_API_KEY'] as const satisfies readonly SetupSecret[]

/**
 * Email notifications: one secret, and three settings the owner edits here (#207, #208).
 *
 * **What changed, and why it is the point of the section rather than a detail.** This used
 * to be three secrets and a `wrangler secret put` block. Two of the three were never
 * secrets — an address on a domain the owner verified, and their own inbox — so telling
 * them to open a terminal for those was asking for a checkout, wrangler and an API token
 * to change a value printed on their own site. They are rows now, and the section edits
 * them. The key is still a credential and is still read-only status plus instructions,
 * which is #158's line and it has not moved.
 *
 * The provider is named only where it is unavoidable — inside `RESEND_API_KEY`, which is
 * the string an owner has to type. The prose says "your email provider", so widening this
 * when a second provider lands is a change to the secret list rather than to the copy.
 *
 * **It is still all-or-nothing, and the badge says so from the resolved state**, not from
 * the rows: a deployment still running on the deprecated secrets is genuinely *on*, and a
 * tab that called it off would send its owner to reconfigure something that works.
 * Enforced by test/dashboard/setup.test.tsx.
 */
export function EmailSection({
  secrets,
  settings,
  onExpired,
  onSaved,
}: {
  secrets: Record<SetupSecret, boolean>
  settings: Load<Settings>
  onExpired: () => void
  onSaved: (settings: Settings) => void
}) {
  const missing = EMAIL_SECRETS.filter((name) => !secrets[name])
  const value = settings.kind === 'ready' ? settings.value : null
  const legacy = value?.fromDeprecatedSecrets ?? []
  const hasFrom = (value?.notifyFrom ?? '') !== '' || legacy.includes('notify_from')
  const hasTo = (value?.notifyTo ?? '') !== '' || legacy.includes('notify_to')
  // Unknown until the settings read lands. `null` renders no badge rather than *Off*,
  // because "off" is a claim and a pending read is not one — the same rule the two
  // `Load` states everywhere else on this tab follow.
  const on = value === null ? null : missing.length === 0 && hasFrom && hasTo

  return (
    <Section title="Email notifications" status={on === null ? null : on ? <On /> : <Off />}>
      {on === true ? (
        <p>
          A short email to your inbox as comments arrive — up to five back to back, and then a
          slower rate, so a busy morning cannot spend a day’s sending allowance in ten minutes. The
          next email that does go out says how many arrived while it was quiet. The queue is the
          record either way: the email is a prompt to come and look, and it is never the thing that
          missed one.
        </p>
      ) : (
        <p>
          {missing.length === EMAIL_SECRETS.length && !hasFrom && !hasTo
            ? 'Nothing is emailed when a comment arrives. New comments still reach the queue, which is the only place they show up.'
            : 'Partly set up, so nothing is sent. The key and both addresses are needed together — a key with no recipient has nowhere to send, and Charcha holds no owner address anywhere to guess one from.'}
        </p>
      )}

      {missing.length > 0 && (
        <>
          <ul className="space-y-1">
            {EMAIL_SECRETS.map((name) => (
              <SecretRow key={name} name={name} set={secrets[name]} />
            ))}
          </ul>
          <p>
            The key is a credential, so it is the one part of this that cannot be set from here — a
            Worker cannot write its own secrets.
          </p>
          <HowToSet names={missing} />
        </>
      )}

      <NotifyFields load={settings} onExpired={onExpired} onSaved={onSaved} />
    </Section>
  )
}

/**
 * One field of a settings body, or nothing at all when sending it would clear a row the
 * owner never filled in.
 *
 * See the call site in `NotifyFields` for why an empty box is not always an instruction.
 * Enforced by test/dashboard/setup.test.tsx.
 */
function omitUntyped(
  key: string,
  field: 'notifyFrom' | 'notifyTo',
  value: string,
  settings: Settings,
): Record<string, string> {
  if (value === '' && servedBySecret(settings, key)) return {}
  return { [field]: value }
}

/**
 * The three notification settings, as one form with one Save button.
 *
 * One request rather than three, because they are one decision: the two addresses are
 * useless apart, and a display name saved without the address it decorates would be a half
 * save the owner watched succeed. The body still carries only these three fields, so
 * saving here cannot overwrite the allowlist or the moderation policy edited in another
 * tab — the lost-update rule #173 established.
 *
 * **The sender name's rules are the server's, and this does not restate them.** A refusal
 * comes back naming the character it refused (src/admin/settings.ts), and that sentence is
 * what the owner reads. Copying the rules into the placeholder would be two lists that can
 * disagree, on the one field where being wrong writes a `From:` header.
 * Enforced by test/dashboard/setup.test.tsx.
 */
function NotifyFields({
  load,
  onExpired,
  onSaved,
}: {
  load: Load<Settings>
  onExpired: () => void
  onSaved: (settings: Settings) => void
}) {
  const [draft, setDraft] = React.useState<{ from: string; to: string; name: string } | null>(null)
  const ids = React.useId()
  const { busy, save, status, saveFailed } = useSettingsSave(onExpired, (settings) => {
    setDraft({
      from: settings.notifyFrom,
      to: settings.notifyTo,
      name: settings.notifyFromName,
    })
    onSaved(settings)
  })

  if (load.kind === 'loading') return <Skeleton className="h-3 w-3/5" />
  if (load.kind === 'failed') {
    return <ReadFailed what="Could not read the notification settings" failure={load.failure} />
  }

  // The loaded rows until the owner types, then their own edit, then whatever the server
  // answered with. Read here rather than in an effect so a settings re-read cannot
  // overwrite something half-typed.
  const fields = draft ?? {
    from: load.value.notifyFrom,
    to: load.value.notifyTo,
    name: load.value.notifyFromName,
  }
  const legacy = load.value.fromDeprecatedSecrets
  const usingSecrets = legacy.includes('notify_from') || legacy.includes('notify_to')

  function change(part: Partial<typeof fields>) {
    setDraft({ ...fields, ...part })
  }

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        // The document's CSP is `form-action 'none'`, so a real submission is refused by
        // the browser rather than merely unhandled — the same arrangement as the sign-in
        // form and the origins dialog.
        event.preventDefault()
        // **A field that is empty *and* being served by a deprecated secret is left out
        // of the body, not sent blank.** The endpoint clears a row for an empty string
        // and leaves an absent field alone, and these boxes are empty because this
        // surface refuses to render a secret's value — not because the owner emptied
        // them. Sending `''` here would write a row, kill the fallback, and stop the
        // notifications of a deployment that was working, with "Saved." on screen. Found
        // in review; it is the exact failure the fallback exists to prevent, arriving
        // through the screen that announces the fallback.
        //
        // The owner can still clear a value they *have* saved: once a row exists the key
        // is no longer in `fromDeprecatedSecrets`, so an empty field is an instruction
        // again.
        // Enforced by test/dashboard/setup.test.tsx.
        save(() =>
          writeNotifySettings({
            ...omitUntyped('notify_from', 'notifyFrom', fields.from, load.value),
            ...omitUntyped('notify_to', 'notifyTo', fields.to, load.value),
            notifyFromName: fields.name,
          }),
        )
      }}
    >
      {usingSecrets && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>These are still coming from secrets you set with wrangler</AlertTitle>
          <AlertDescription>
            <p>
              They keep working. The fields below are empty because nothing has been saved here yet
              — Charcha will not show you a value out of a secret. Type your addresses in and save,
              and you can then remove <code>CHARCHA_NOTIFY_FROM</code> and{' '}
              <code>CHARCHA_NOTIFY_TO</code> with <code>wrangler secret delete</code>.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <Field
        id={`${ids}-notify-to`}
        type="email"
        label="Send notifications to"
        placeholder="you@example.com"
        value={fields.to}
        disabled={busy}
        invalid={saveFailed}
        onChange={(next) => {
          change({ to: next })
        }}
        hint="Your own inbox. It is the only address Charcha ever mails, and clearing it is how you stop the emails — there is no unsubscribe link, because there is nobody to unsubscribe but you."
      />

      <Field
        id={`${ids}-notify-from`}
        type="email"
        label="Send them from"
        placeholder="comments@example.com"
        value={fields.from}
        disabled={busy}
        invalid={saveFailed}
        onChange={(next) => {
          change({ from: next })
        }}
        hint="Has to be on a domain verified with your email provider, under the same account as the key. Mail from an unverified domain is refused — and from your side that refusal looks exactly like the feature being switched off, so check it for typos before you save."
      />

      <Field
        id={`${ids}-notify-from-name`}
        label="Sender name (optional)"
        placeholder="Charcha"
        value={fields.name}
        disabled={busy}
        invalid={saveFailed}
        onChange={(next) => {
          change({ name: next })
        }}
        hint="What your mail client shows instead of the bare address. Leave it empty and the address is what you see. It goes in the From line, so it cannot contain angle brackets, quotes or an @ — a name that looks like an address is how a message pretends to be from somebody else."
      />

      {status}
      <SaveRow busy={busy} label="Save notification settings" />
    </form>
  )
}
