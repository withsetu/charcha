// The batched settings read (#207).
//
// **The property under test is the statement count, not the values.** #207 moves three
// values off `env` and into `settings`, and #208 adds a fourth — so the submission path
// would go from two potential `readSetting` seeks to six, one per row. CLAUDE.md's rule
// is that the query count stays *constant* rather than merely low, because the 50-query
// invocation budget throws rather than slows down. One statement for every key is what
// makes adding the seventh setting cost nothing.

import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_SETTINGS_BATCH, readSettings, settingsBatchSql, writeSetting } from '../../../src/db'

const db = env.DB

/** Every statement the callback sent, in order. */
async function statementsDuring(work: () => Promise<unknown>): Promise<string[]> {
  const sent: string[] = []
  const prepare = db.prepare.bind(db)
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    sent.push(sql)
    return prepare(sql)
  })
  try {
    await work()
  } finally {
    spy.mockRestore()
  }
  return sent
}

beforeEach(async () => {
  await db.exec('DELETE FROM settings')
})

describe('readSettings', () => {
  it('reads every key in one statement', async () => {
    await writeSetting(db, 'a', 'one', 1)
    await writeSetting(db, 'b', 'two', 1)
    await writeSetting(db, 'c', 'three', 1)

    let values = new Map<string, string>()
    const sent = await statementsDuring(async () => {
      values = await readSettings(db, ['a', 'b', 'c'])
    })

    expect(sent).toHaveLength(1)
    expect(values.get('a')).toBe('one')
    expect(values.get('b')).toBe('two')
    expect(values.get('c')).toBe('three')
  })

  it('tells a row that is absent from a row that is empty', async () => {
    // The distinction the `env` fallback rests on (#207): a row that has never been
    // written falls back to the deprecated secret, and a row the owner deliberately
    // emptied does not. A Map that answered `undefined` for both would make clearing a
    // setting silently restore the secret it replaced.
    await writeSetting(db, 'present-but-empty', '', 1)

    const values = await readSettings(db, ['present-but-empty', 'never-written'])

    expect(values.has('present-but-empty')).toBe(true)
    expect(values.get('present-but-empty')).toBe('')
    expect(values.has('never-written')).toBe(false)
  })

  it('costs one statement whether one key is asked for or many', async () => {
    const one = await statementsDuring(() => readSettings(db, ['a']))
    const many = await statementsDuring(() => readSettings(db, ['a', 'b', 'c', 'd', 'e', 'f']))

    expect(one).toHaveLength(1)
    expect(many).toHaveLength(1)
  })

  it('asks the database nothing at all for an empty key list', async () => {
    const sent = await statementsDuring(async () => {
      expect(await readSettings(db, [])).toEqual(new Map())
    })

    expect(sent).toHaveLength(0)
  })

  it('refuses more keys than the cap rather than building an unbounded statement', async () => {
    const keys = Array.from({ length: MAX_SETTINGS_BATCH + 1 }, (_, index) => `k${String(index)}`)

    await expect(readSettings(db, keys)).rejects.toThrow(/settings/i)
  })

  it('de-duplicates keys, so a repeated key does not widen the statement', () => {
    // The placeholder count has to match the bound values, and a caller composing key
    // lists from two modules is exactly how a duplicate arrives.
    expect(settingsBatchSql(2)).toContain('?1, ?2')
    expect(settingsBatchSql(2)).not.toContain('?3')
  })

  it('reads only the keys it was asked for', async () => {
    await writeSetting(db, 'wanted', 'yes', 1)
    await writeSetting(db, 'unwanted', 'no', 1)

    const values = await readSettings(db, ['wanted'])

    expect([...values.keys()]).toEqual(['wanted'])
  })
})
