import { openDb } from '../db'
import { IngestBatcher } from '../ingestBatch'

const write = (rkey: string) => ({
  record: {
    uri: `at://did:plc:abc/app.bsky.feed.post/${rkey}`,
    cid: `cid-${rkey}`,
    did: 'did:plc:abc',
    collection: 'app.bsky.feed.post',
    rkey,
    json: '{"title":"x"}',
    indexed_at: '2026-08-03T00:00:00.000Z',
  },
  descriptors: [`token:${rkey}`, `tag:${rkey}`],
})

const count = (db: ReturnType<typeof openDb>, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('IngestBatcher', () => {
  it('holds writes until the batch is full, then commits them together', () => {
    const db = openDb(':memory:')
    const batcher = new IngestBatcher(db, { maxBatch: 3, flushMs: 60_000 })

    batcher.add(write('a'))
    batcher.add(write('b'))
    expect(count(db, 'records')).toBe(0) // still buffered

    batcher.add(write('c'))
    expect(count(db, 'records')).toBe(3) // batch full -> flushed
    expect(count(db, 'descriptors')).toBe(6)

    batcher.stop()
  })

  it('flush() drains a partial batch', () => {
    const db = openDb(':memory:')
    const batcher = new IngestBatcher(db, { maxBatch: 100, flushMs: 60_000 })
    batcher.add(write('a'))
    expect(count(db, 'records')).toBe(0)

    batcher.flush()

    expect(count(db, 'records')).toBe(1)
    expect(count(db, 'descriptors')).toBe(2)
    batcher.stop()
  })

  it('stop() flushes what is buffered so shutdown does not lose records', () => {
    const db = openDb(':memory:')
    const batcher = new IngestBatcher(db, { maxBatch: 100, flushMs: 60_000 })
    batcher.add(write('a'))
    batcher.stop()
    expect(count(db, 'records')).toBe(1)
  })

  it('flushes on the timer without reaching the batch size', async () => {
    const db = openDb(':memory:')
    const batcher = new IngestBatcher(db, { maxBatch: 100, flushMs: 20 })
    batcher.add(write('a'))
    expect(count(db, 'records')).toBe(0)

    await new Promise((r) => setTimeout(r, 60))

    expect(count(db, 'records')).toBe(1)
    batcher.stop()
  })

  it('reports how many records it wrote', () => {
    const db = openDb(':memory:')
    const flushed: number[] = []
    const batcher = new IngestBatcher(db, {
      maxBatch: 2,
      flushMs: 60_000,
      onFlush: (n) => flushed.push(n),
    })
    batcher.add(write('a'))
    batcher.add(write('b'))
    expect(flushed).toEqual([2])
    batcher.stop()
  })

  it('a duplicate uri in the same batch does not abort the batch', () => {
    const db = openDb(':memory:')
    const batcher = new IngestBatcher(db, { maxBatch: 100, flushMs: 60_000 })
    batcher.add(write('a'))
    batcher.add(write('a')) // same uri — upsert, not a constraint failure
    batcher.add(write('b'))
    batcher.flush()
    expect(count(db, 'records')).toBe(2)
    batcher.stop()
  })
})
