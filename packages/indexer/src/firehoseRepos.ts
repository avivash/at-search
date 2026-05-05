import type Database from 'better-sqlite3'
import { IdResolver } from '@atproto/identity'
import { MemoryBlockstore, Repo } from '@atproto/repo'
import { Firehose } from '@atproto/sync'
import type { CommitEvt, Event } from '@atproto/sync'
import { ingestRecord } from './ingest.js'
import { advertiseDescriptor } from './dht.js'
import type { DhtNode } from './dht.js'

/** Mirrors @atproto/sync Firehose collection filter (exact NSIDs or `prefix.*`). */
function collectionMatches(patterns: string[] | undefined, collection: string): boolean {
  if (!patterns?.length) return true
  for (const pattern of patterns) {
    if (pattern.endsWith('.*')) {
      if (collection.startsWith(pattern.slice(0, -2))) return true
    } else if (pattern === collection) {
      return true
    }
  }
  return false
}

export interface RepoFirehoseOptions {
  /** Relay base URL (no path). Example: wss://bsky.network */
  relayUrl: string
  /** Collections to ingest. If omitted, ingests all collections observed on the firehose. */
  collections?: string[]
  /** Called after each successful record ingest */
  onIngested?: (uri: string, cid: string) => void
  /** Called on connection events for logging */
  onStatus?: (msg: string) => void
}

/**
 * Full atproto firehose consumer (com.atproto.sync.subscribeRepos).
 *
 * Unlike Jetstream, this includes *all* collections (including custom lexicons)
 * because it is the raw repository event stream.
 */
export function startRepoFirehose(
  db: Database.Database,
  dhtNode: DhtNode,
  opts: RepoFirehoseOptions,
): () => void {
  const idResolver = new IdResolver()

  const ingestOne = async (did: string, collection: string, rkey: string, cidStr: string, record: unknown) => {
    const uri = `at://${did}/${collection}/${rkey}`
    const result = ingestRecord(db, uri, cidStr, record)
    if (result) {
      await Promise.all(result.descriptors.map((key) => advertiseDescriptor(dhtNode, key)))
      opts.onIngested?.(uri, cidStr)
    }
  }

  const firehose = new Firehose({
    idResolver,
    service: opts.relayUrl,
    // Important: allow custom lexicons without signature validation / DID doc lookups.
    unauthenticatedCommits: true,
    unauthenticatedHandles: true,
    filterCollections: opts.collections?.length ? opts.collections : undefined,
    handleEvent: async (evt: Event) => {
      // Network relays often emit `#sync` (full repo CAR). Those never reach this handler as create/update.
      if (evt.event === 'sync') {
        try {
          const storage = new MemoryBlockstore(evt.blocks)
          const repo = await Repo.load(storage, evt.cid)
          if (repo.did !== evt.did) {
            opts.onStatus?.(`Firehose sync: DID mismatch (evt ${evt.did}, repo ${repo.did}); skipping`)
            return
          }
          for await (const rec of repo.walkRecords()) {
            if (!collectionMatches(opts.collections, rec.collection)) continue
            await ingestOne(repo.did, rec.collection, rec.rkey, rec.cid.toString(), rec.record)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          opts.onStatus?.(`Firehose sync parse skipped for ${evt.did}: ${msg}`)
          if (process.env.DEBUG_FIREHOSE) {
            console.debug('firehose sync error', evt.did, err)
          }
        }
        return
      }

      if (evt.event !== 'create' && evt.event !== 'update') return
      const c = evt as Extract<CommitEvt, { event: 'create' | 'update' }>
      await ingestOne(c.did, c.collection, c.rkey, c.cid.toString(), c.record)
    },
    onError: (err) => {
      const anyErr = err as any
      const causeMsg =
        anyErr?.cause instanceof Error
          ? anyErr.cause.message
          : typeof anyErr?.cause === 'string'
            ? anyErr.cause
            : undefined
      const detail = causeMsg ? ` (cause: ${causeMsg})` : ''
      opts.onStatus?.(`Firehose error: ${err.name}: ${err.message}${detail}`)
      if (process.env.DEBUG_FIREHOSE) {
        console.debug('firehose error', err)
      }
    },
  })

  opts.onStatus?.(`Connecting: ${opts.relayUrl} com.atproto.sync.subscribeRepos`)
  firehose.start()

  return () => {
    void firehose.destroy()
    opts.onStatus?.('Firehose consumer stopped')
  }
}

