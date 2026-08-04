import { openDb, upsertLexicon, getLexicon, listLexicons, upsertRecord, upsertDescriptor, getPointersByDescriptor } from '../db'
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

describe('getPointersByDescriptor collection filter', () => {
  const add = (db: ReturnType<typeof openDb>, collection: string, rkey: string, indexedAt: string) => {
    const uri = `at://did:plc:abc/${collection}/${rkey}`
    upsertRecord(db, {
      uri, cid: `cid-${rkey}`, did: 'did:plc:abc', collection, rkey,
      json: '{}', indexed_at: indexedAt,
    })
    upsertDescriptor(db, 'token:echo', uri, `cid-${rkey}`)
  }

  it('returns only the requested collection when one is given', () => {
    const db = openDb(':memory:')
    add(db, 'app.bsky.feed.post', 'p1', '2026-08-03T00:00:00.000Z')
    add(db, 'at.functions.metadata', 'echo-v1', '2026-08-01T00:00:00.000Z')

    const all = getPointersByDescriptor(db, 'token:echo')
    expect(all).toHaveLength(2)

    const scoped = getPointersByDescriptor(db, 'token:echo', 'at.functions.metadata')
    expect(scoped).toHaveLength(1)
    expect(scoped[0].uri).toContain('/at.functions.metadata/')
  })

  it('keeps older records of a collection that a busy firehose would evict', () => {
    const db = openDb(':memory:')
    // 120 recent posts would push an older function past the 100-row cap.
    for (let i = 0; i < 120; i++) {
      add(db, 'app.bsky.feed.post', `p${i}`, `2026-08-03T00:${String(i).padStart(2, '0')}:00.000Z`)
    }
    add(db, 'at.functions.metadata', 'echo-v1', '2026-01-01T00:00:00.000Z')

    expect(getPointersByDescriptor(db, 'token:echo').some((p) => p.uri.includes('/at.functions.metadata/'))).toBe(false)
    expect(getPointersByDescriptor(db, 'token:echo', 'at.functions.metadata')).toHaveLength(1)
  })
})
