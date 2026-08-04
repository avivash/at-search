import { openDb, upsertRecord, upsertDescriptor, pruneRecordsOlderThan } from '../db'

const insert = (db: ReturnType<typeof openDb>, rkey: string, indexedAt: string) => {
  const uri = `at://did:plc:abc/app.bsky.feed.post/${rkey}`
  upsertRecord(db, {
    uri,
    cid: `cid-${rkey}`,
    did: 'did:plc:abc',
    collection: 'app.bsky.feed.post',
    rkey,
    json: '{"title":"x"}',
    indexed_at: indexedAt,
  })
  upsertDescriptor(db, `token:${rkey}`, uri, `cid-${rkey}`)
  return uri
}

const countRows = (db: ReturnType<typeof openDb>, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('pruneRecordsOlderThan', () => {
  it('removes records indexed before the cutoff and keeps newer ones', () => {
    const db = openDb(':memory:')
    insert(db, 'old', '2026-01-01T00:00:00.000Z')
    insert(db, 'new', '2026-08-01T00:00:00.000Z')

    const removed = pruneRecordsOlderThan(db, '2026-06-01T00:00:00.000Z')

    expect(removed).toBe(1)
    expect(countRows(db, 'records')).toBe(1)
    const kept = db.prepare('SELECT rkey FROM records').get() as { rkey: string }
    expect(kept.rkey).toBe('new')
  })

  it('cascades to descriptors so no orphans survive', () => {
    const db = openDb(':memory:')
    insert(db, 'old', '2026-01-01T00:00:00.000Z')
    insert(db, 'new', '2026-08-01T00:00:00.000Z')
    expect(countRows(db, 'descriptors')).toBe(2)

    pruneRecordsOlderThan(db, '2026-06-01T00:00:00.000Z')

    expect(countRows(db, 'descriptors')).toBe(1)
    const left = db.prepare('SELECT descriptor_key FROM descriptors').get() as {
      descriptor_key: string
    }
    expect(left.descriptor_key).toBe('token:new')
  })

  it('is a no-op when nothing is old enough', () => {
    const db = openDb(':memory:')
    insert(db, 'new', '2026-08-01T00:00:00.000Z')
    expect(pruneRecordsOlderThan(db, '2020-01-01T00:00:00.000Z')).toBe(0)
    expect(countRows(db, 'records')).toBe(1)
  })
})
