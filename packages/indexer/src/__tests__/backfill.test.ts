import { backfillRepo } from '../backfill'
import type { BackfillDeps } from '../backfill'

const PLAN = { nsid: 'com.example.recipe', indexable: true, title: [['title']], body: [], tags: [], createdAt: [], langs: [], url: [] }

const deps = (over: Partial<BackfillDeps> = {}): BackfillDeps => ({
  describeRepo: async () => ({ pds: 'https://pds.example', collections: ['com.example.recipe'] }),
  listRecords: async () => ({ records: [{ uri: 'at://did:plc:a/com.example.recipe/1', cid: 'c1', value: {} }] }),
  decide: () => ({ action: 'ingest' }),
  ingest: () => true,
  ...over,
})

describe('backfillRepo', () => {
  it('walks every collection the repo declares and ingests their records', async () => {
    const ingested: string[] = []
    const res = await backfillRepo('did:plc:a', deps({
      describeRepo: async () => ({ pds: 'https://pds.example', collections: ['com.example.recipe', 'com.example.note'] }),
      ingest: (uri) => { ingested.push(uri); return true },
    }))
    expect(res.collections).toBe(2)
    expect(res.records).toBe(2)
    expect(ingested).toHaveLength(2)
  })

  it('paginates listRecords until the cursor runs out', async () => {
    const pages = [
      { records: [{ uri: 'at://did:plc:a/com.example.recipe/1', cid: 'c1', value: {} }], cursor: 'p2' },
      { records: [{ uri: 'at://did:plc:a/com.example.recipe/2', cid: 'c2', value: {} }], cursor: 'p3' },
      { records: [{ uri: 'at://did:plc:a/com.example.recipe/3', cid: 'c3', value: {} }] },
    ]
    let call = 0
    const res = await backfillRepo('did:plc:a', deps({
      listRecords: async () => pages[call++],
    }))
    expect(call).toBe(3)
    expect(res.records).toBe(3)
  })

  it('skips collections triage drops, without fetching them', async () => {
    const fetched: string[] = []
    const res = await backfillRepo('did:plc:a', deps({
      describeRepo: async () => ({ pds: 'https://pds.example', collections: ['app.bsky.feed.like', 'com.example.recipe'] }),
      decide: (nsid) => (nsid === 'app.bsky.feed.like' ? { action: 'drop', reason: 'no-text' } : { action: 'ingest' }),
      listRecords: async (_pds, _did, collection) => {
        fetched.push(collection)
        return { records: [{ uri: `at://did:plc:a/${collection}/1`, cid: 'c1', value: {} }] }
      },
    }))
    expect(fetched).toEqual(['com.example.recipe'])
    expect(res.skipped).toEqual(['app.bsky.feed.like'])
    expect(res.records).toBe(1)
  })

  it('hands the triage plan to ingest so backfilled records normalise like live ones', async () => {
    const plans: unknown[] = []
    await backfillRepo('did:plc:a', deps({
      decide: () => ({ action: 'ingest', plan: PLAN as never }),
      ingest: (_uri, _cid, _value, plan) => { plans.push(plan); return true },
    }))
    expect(plans).toEqual([PLAN])
  })

  it('keeps going when one collection fails', async () => {
    const res = await backfillRepo('did:plc:a', deps({
      describeRepo: async () => ({ pds: 'https://pds.example', collections: ['com.example.broken', 'com.example.recipe'] }),
      listRecords: async (_pds, _did, collection) => {
        if (collection === 'com.example.broken') throw new Error('502 from PDS')
        return { records: [{ uri: 'at://did:plc:a/com.example.recipe/1', cid: 'c1', value: {} }] }
      },
    }))
    expect(res.records).toBe(1)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]).toContain('com.example.broken')
  })

  it('reports an unreachable repo instead of throwing', async () => {
    const res = await backfillRepo('did:plc:gone', deps({
      describeRepo: async () => { throw new Error('could not resolve DID') },
    }))
    expect(res.records).toBe(0)
    expect(res.errors[0]).toContain('could not resolve DID')
  })
})
