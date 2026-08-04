import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { IdResolver } from '@atproto/identity'
import { openDb } from './db.js'
import { ingestRecord } from './ingest.js'
import { IngestBatcher } from './ingestBatch.js'
import { LexiconRegistry, defaultResolveLexiconDoc } from './lexiconRegistry.js'
import { backfillRepo, type BackfillDeps } from './backfill.js'

/**
 * Rebuild the index from AT Proto repos.
 *
 *   pnpm --filter @atsearch/indexer run backfill -- --dids did:plc:a,did:plc:b
 *   pnpm --filter @atsearch/indexer run backfill -- --from-relay https://bsky.network --limit 500
 *   pnpm --filter @atsearch/indexer run backfill -- --dids-file dids.txt --collections at.functions.metadata
 *
 * Resumable: completed DIDs are checkpointed, so re-running skips them.
 */

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}
const has = (flag: string) => process.argv.includes(flag)

const DB_PATH = process.env.ATSEARCH_DB_PATH ?? './data/indexer.db'
const CHECKPOINT = arg('--checkpoint') ?? './data/backfill-progress.json'
const CONCURRENCY = parseInt(arg('--concurrency') ?? '4', 10)
const MAX_PER_REPO = arg('--max-per-repo') ? parseInt(arg('--max-per-repo')!, 10) : undefined
const collections = (arg('--collections') ?? '').split(',').map((s) => s.trim()).filter(Boolean)

const idResolver = new IdResolver()
const pdsCache = new Map<string, string>()

async function pdsFor(did: string): Promise<string> {
  const cached = pdsCache.get(did)
  if (cached) return cached
  const doc = await idResolver.did.resolve(did)
  const service = doc?.service?.find(
    (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer',
  )
  const endpoint = typeof service?.serviceEndpoint === 'string' ? service.serviceEndpoint : null
  if (!endpoint) throw new Error(`no PDS in DID document for ${did}`)
  pdsCache.set(did, endpoint)
  return endpoint
}

async function xrpc(base: string, method: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${base.replace(/\/$/, '')}/xrpc/${method}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`${method} ${res.status}`)
  return res.json()
}

/** Enumerate DIDs a relay knows about (paginated). */
async function didsFromRelay(relay: string, limit: number): Promise<string[]> {
  const dids: string[] = []
  let cursor: string | undefined
  while (dids.length < limit) {
    const params: Record<string, string> = { limit: String(Math.min(1000, limit - dids.length)) }
    if (cursor) params.cursor = cursor
    const page = (await xrpc(relay, 'com.atproto.sync.listRepos', params)) as {
      repos?: Array<{ did: string }>
      cursor?: string
    }
    for (const r of page.repos ?? []) dids.push(r.did)
    cursor = page.cursor
    if (!cursor) break
  }
  return dids
}

async function main() {
  let dids: string[] = (arg('--dids') ?? '').split(',').map((s) => s.trim()).filter(Boolean)

  const didsFile = arg('--dids-file')
  if (didsFile) {
    dids.push(...readFileSync(didsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean))
  }
  const relay = arg('--from-relay')
  if (relay) {
    const limit = parseInt(arg('--limit') ?? '100', 10)
    console.log(`Enumerating up to ${limit} repos from ${relay}…`)
    dids.push(...(await didsFromRelay(relay, limit)))
  }
  if (dids.length === 0) {
    console.error('Provide --dids, --dids-file, or --from-relay. See src/backfillCli.ts for usage.')
    process.exit(1)
  }

  const done: Set<string> = existsSync(CHECKPOINT) && !has('--restart')
    ? new Set(JSON.parse(readFileSync(CHECKPOINT, 'utf8')).done ?? [])
    : new Set()
  dids = [...new Set(dids)].filter((d) => !done.has(d))
  console.log(`${dids.length} repo(s) to crawl${done.size ? ` (${done.size} already done)` : ''}`)

  const db = openDb(DB_PATH)
  const registry = new LexiconRegistry(db, { resolveLexiconDoc: defaultResolveLexiconDoc })
  const batcher = new IngestBatcher(db, { maxBatch: 500, flushMs: 2_000 })

  const deps: BackfillDeps = {
    describeRepo: async (did) => {
      const pds = await pdsFor(did)
      const desc = (await xrpc(pds, 'com.atproto.repo.describeRepo', { repo: did })) as {
        collections?: string[]
      }
      return { pds, collections: desc.collections ?? [] }
    },
    listRecords: async (pds, did, collection, cursor) => {
      const params: Record<string, string> = { repo: did, collection, limit: '100' }
      if (cursor) params.cursor = cursor
      const page = (await xrpc(pds, 'com.atproto.repo.listRecords', params)) as {
        records?: Array<{ uri: string; cid: string; value: unknown }>
        cursor?: string
      }
      return { records: page.records ?? [], cursor: page.cursor }
    },
    decide: (nsid) => registry.decide(nsid),
    ingest: (uri, cid, value, plan) => Boolean(ingestRecord(db, uri, cid, value, plan, batcher)),
  }

  let totalRecords = 0
  const queue = [...dids]
  const workers = Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
    for (let did = queue.shift(); did; did = queue.shift()) {
      const res = await backfillRepo(did, deps, {
        collections: collections.length ? collections : undefined,
        maxRecords: MAX_PER_REPO,
      })
      totalRecords += res.records
      done.add(did)
      if (res.records > 0 || res.errors.length > 0) {
        console.log(
          `${did}: ${res.records} records from ${res.collections} collection(s)` +
            (res.errors.length ? ` — ${res.errors.length} error(s): ${res.errors[0]}` : ''),
        )
      }
      writeFileSync(CHECKPOINT, JSON.stringify({ done: [...done] }, null, 2))
    }
  })

  await Promise.all(workers)
  batcher.stop()
  console.log(`\nBackfill complete: ${totalRecords} records from ${done.size} repo(s).`)
  console.log(`Checkpoint: ${CHECKPOINT} (delete it or pass --restart to re-crawl)`)
}

main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
