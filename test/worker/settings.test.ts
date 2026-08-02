// The settings rows #207 moves off `env`, and the fallback that keeps an existing
// deployment's notifications working the day it updates.
//
// The load-bearing case is the last one in each pair: a row the owner **emptied** is not
// the same as a row that was never written. Only the second falls back to the deprecated
// secret. A resolver that could not tell them apart would make clearing a setting in the
// dashboard silently restore the value it replaced — which is worse than not offering the
// field, because the owner would have watched it save.

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeSetting } from '../../src/db'
import {
  MAX_EMAIL_ADDRESS_LENGTH,
  MAX_SITE_URL_LENGTH,
  NOTIFY_FROM_NAME_SETTING,
  NOTIFY_FROM_SETTING,
  NOTIFY_TO_SETTING,
  SITE_URL_SETTING,
  SUBMISSION_SETTINGS,
  readSiteSettings,
} from '../../src/settings'

const db = env.DB

const NOTHING = {} as const

beforeEach(async () => {
  await db.exec('DELETE FROM settings')
})

describe('readSiteSettings', () => {
  it('reads every row it needs in one statement', async () => {
    // The #207 requirement, and the reason the batched read exists: six settings must not
    // cost six seeks on the public write path.
    const sent: string[] = []
    const prepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      sent.push(sql)
      return prepare(sql)
    })
    await readSiteSettings(db, NOTHING)
    spy.mockRestore()

    expect(sent).toHaveLength(1)
  })

  it('is all-absent on a deployment that has configured nothing', async () => {
    const settings = await readSiteSettings(db, NOTHING)

    expect(settings).toEqual({
      moderationPolicy: 'hold-all',
      siteUrl: null,
      notifyFrom: null,
      notifyTo: null,
      notifyFromName: null,
    })
  })

  it('reads the rows the owner set', async () => {
    await writeSetting(db, SITE_URL_SETTING, 'https://maya.build', 1)
    await writeSetting(db, NOTIFY_FROM_SETTING, 'comments@maya.build', 1)
    await writeSetting(db, NOTIFY_TO_SETTING, 'maya@maya.build', 1)
    await writeSetting(db, NOTIFY_FROM_NAME_SETTING, 'maya.build comments', 1)

    const settings = await readSiteSettings(db, NOTHING)

    expect(settings.siteUrl).toBe('https://maya.build')
    expect(settings.notifyFrom).toBe('comments@maya.build')
    expect(settings.notifyTo).toBe('maya@maya.build')
    expect(settings.notifyFromName).toBe('maya.build comments')
  })

  it('falls back to the deprecated secrets when no row has ever been written', async () => {
    const settings = await readSiteSettings(db, {
      CHARCHA_SITE_URL: 'https://old.example',
      CHARCHA_NOTIFY_FROM: 'Charcha <comments@old.example>',
      CHARCHA_NOTIFY_TO: 'maya@old.example',
    })

    expect(settings.siteUrl).toBe('https://old.example')
    expect(settings.notifyFrom).toBe('Charcha <comments@old.example>')
    expect(settings.notifyTo).toBe('maya@old.example')
  })

  it('lets a row override the secret it replaced', async () => {
    await writeSetting(db, NOTIFY_TO_SETTING, 'maya@new.example', 1)

    const settings = await readSiteSettings(db, { CHARCHA_NOTIFY_TO: 'maya@old.example' })

    expect(settings.notifyTo).toBe('maya@new.example')
  })

  it('does not restore the secret when the owner clears the row', async () => {
    // The case the Map's `has` exists for. An owner who empties this field in the
    // dashboard has asked for no notifications; falling back would keep sending them.
    await writeSetting(db, NOTIFY_TO_SETTING, '', 1)

    const settings = await readSiteSettings(db, { CHARCHA_NOTIFY_TO: 'maya@old.example' })

    expect(settings.notifyTo).toBeNull()
  })

  it('treats a blank secret as unset, the way every other reader of one does', async () => {
    // `usableIpSecret`, `usableDashboardPassword` and `configured` all agree that a value
    // one stray newline from `wrangler secret put` is not a value.
    const settings = await readSiteSettings(db, { CHARCHA_NOTIFY_TO: '   ' })

    expect(settings.notifyTo).toBeNull()
  })

  it('trims a stored value, so a pasted trailing newline is not part of the address', async () => {
    await writeSetting(db, NOTIFY_TO_SETTING, ' maya@maya.build\n', 1)

    expect((await readSiteSettings(db, NOTHING)).notifyTo).toBe('maya@maya.build')
  })

  it('ignores a stored value past its cap rather than using it', async () => {
    // Untrusted input regardless of who wrote it (card rule 5). Nothing bounds what a
    // `wrangler d1 execute` can put in this column, and these values reach an outbound
    // request.
    await writeSetting(db, NOTIFY_TO_SETTING, `${'a'.repeat(MAX_EMAIL_ADDRESS_LENGTH)}@x`, 1)
    await writeSetting(db, SITE_URL_SETTING, `https://x.example/${'a'.repeat(MAX_SITE_URL_LENGTH)}`, 1)

    const settings = await readSiteSettings(db, NOTHING)

    expect(settings.notifyTo).toBeNull()
    expect(settings.siteUrl).toBeNull()
  })

  it('ignores a stored display name that would not pass the dashboard’s check', async () => {
    // Fail closed on the read as well as the write (#208): a row can predate the check or
    // be written straight into D1.
    await writeSetting(db, NOTIFY_FROM_NAME_SETTING, 'Charcha <security@bank.example>', 1)

    expect((await readSiteSettings(db, NOTHING)).notifyFromName).toBeNull()
  })

  it('reads the moderation policy through the same statement', async () => {
    // Folded in so the submission path spends one settings read rather than one for the
    // policy and another for everything else.
    await writeSetting(db, 'moderation_policy', 'trust-returning', 1)

    expect((await readSiteSettings(db, NOTHING)).moderationPolicy).toBe('trust-returning')
  })

  it('reports an unrecognised policy as the one that will actually be applied', async () => {
    await writeSetting(db, 'moderation_policy', 'publish-everything', 1)

    expect((await readSiteSettings(db, NOTHING)).moderationPolicy).toBe('hold-all')
  })

  it('asks for no more keys than the batched read will take', () => {
    // A list this project can add to without noticing it has passed the cap.
    expect(SUBMISSION_SETTINGS.length).toBeLessThanOrEqual(16)
  })
})
