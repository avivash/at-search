import { AtpAgent } from '@atproto/api'
import type Database from 'better-sqlite3'
import { ingestRecord } from './ingest.js'
import { advertiseDescriptor } from './dht.js'
import type { DhtNode } from './dht.js'

const COLLECTION = 'com.example.thing'
const POLL_INTERVAL_MS = 30_000

export async function pollPds(
  db: Database.Database,
  dhtNode: DhtNode,
  opts: {
    pdsUrl: string
    dids: string[]
    onIngested?: (uri: string, cid: string) => void
  },
): Promise<void> {
  const agent = new AtpAgent({ service: opts.pdsUrl })

  for (const did of opts.dids) {
    try {
      const res = await agent.com.atproto.repo.listRecords({
        repo: did,
        collection: COLLECTION,
        limit: 100,
      })

      for (const record of res.data.records) {
        const result = ingestRecord(db, record.uri, record.cid, record.value)
        if (result) {
          for (const key of result.descriptors) {
            await advertiseDescriptor(dhtNode, key)
          }
          opts.onIngested?.(result.uri, result.cid)
        }
      }
    } catch (err) {
      console.error(`Poll failed for ${did}:`, err)
    }
  }
}

export function startPolling(
  db: Database.Database,
  dhtNode: DhtNode,
  opts: {
    pdsUrl: string
    dids: string[]
    onIngested?: (uri: string, cid: string) => void
  },
): () => void {
  let stopped = false

  const run = async () => {
    while (!stopped) {
      await pollPds(db, dhtNode, opts)
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  }

  run().catch(console.error)
  return () => { stopped = true }
}
