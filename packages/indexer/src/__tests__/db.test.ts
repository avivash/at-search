import { openDb, upsertLexicon, getLexicon, listLexicons } from '../db'
import type { LexiconRow } from '../db'

const row = (overrides: Partial<LexiconRow> = {}): LexiconRow => ({
  nsid: 'com.example.foo',
  status: 'plan',
  doc_json: '{"lexicon":1}',
  plan_json: '{"nsid":"com.example.foo","indexable":true}',
  description: 'A foo record',
  resolved_at: '2026-08-03T00:00:00.000Z',
  next_retry_at: null,
  attempts: 0,
  ...overrides,
})

describe('lexicons table', () => {
  it('round-trips a row', () => {
    const db = openDb(':memory:')
    upsertLexicon(db, row())
    const got = getLexicon(db, 'com.example.foo')
    expect(got).toEqual(row())
  })

  it('upsert replaces on conflict', () => {
    const db = openDb(':memory:')
    upsertLexicon(db, row({ status: 'unresolvable', attempts: 2 }))
    upsertLexicon(db, row({ status: 'plan', attempts: 0 }))
    expect(getLexicon(db, 'com.example.foo')!.status).toBe('plan')
    expect(getLexicon(db, 'com.example.foo')!.attempts).toBe(0)
  })

  it('missing nsid returns undefined; listLexicons lists all', () => {
    const db = openDb(':memory:')
    expect(getLexicon(db, 'nope')).toBeUndefined()
    upsertLexicon(db, row())
    upsertLexicon(db, row({ nsid: 'com.example.bar', status: 'no-text' }))
    expect(listLexicons(db).map((r: LexiconRow) => r.nsid).sort()).toEqual([
      'com.example.bar',
      'com.example.foo',
    ])
  })
})
