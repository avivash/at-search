import type { ExtractionPlan } from '@atsearch/common'
import type { TriageDecision } from './lexiconRegistry.js'

/**
 * Backfill: rebuild the index from AT Proto repos rather than the live stream.
 *
 * Jetstream and the firehose carry live commits only — a record written before
 * an index existed is invisible to it forever. That makes a derived index
 * one-way: lose it and the history is gone. Backfill closes that by reading
 * repos directly (describeRepo → listRecords), so the index is reproducible
 * from the network at any time.
 *
 * Records are normalised through the same triage and extraction plans as live
 * ingestion, so a backfilled record is indistinguishable from a streamed one.
 */

export interface RepoRecord {
  uri: string
  cid: string
  value: unknown
}

export interface BackfillDeps {
  /** DID → its PDS host and the collections that repo actually contains. */
  describeRepo: (did: string) => Promise<{ pds: string; collections: string[] }>
  listRecords: (
    pds: string,
    did: string,
    collection: string,
    cursor?: string,
  ) => Promise<{ records: RepoRecord[]; cursor?: string }>
  /** Same triage the live consumers use, so backfill honours denylists and no-text drops. */
  decide: (nsid: string) => TriageDecision
  /** Returns true when the record was indexed (false = no extractable text). */
  ingest: (uri: string, cid: string, value: unknown, plan?: ExtractionPlan) => boolean
}

export interface BackfillResult {
  did: string
  collections: number
  records: number
  skipped: string[]
  errors: string[]
}

export interface BackfillOptions {
  /** Restrict to these collections (exact NSIDs). Default: everything the repo has. */
  collections?: string[]
  /** Stop after this many records for one repo. */
  maxRecords?: number
  onProgress?: (collection: string, records: number) => void
}

export async function backfillRepo(
  did: string,
  deps: BackfillDeps,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const result: BackfillResult = { did, collections: 0, records: 0, skipped: [], errors: [] }

  let repo: { pds: string; collections: string[] }
  try {
    repo = await deps.describeRepo(did)
  } catch (err) {
    result.errors.push(`${did}: ${(err as Error).message}`)
    return result
  }

  const wanted = opts.collections?.length
    ? repo.collections.filter((c) => opts.collections!.includes(c))
    : repo.collections

  for (const collection of wanted) {
    const decision = deps.decide(collection)
    if (decision.action !== 'ingest') {
      result.skipped.push(collection)
      continue
    }
    result.collections++

    try {
      let cursor: string | undefined
      let inCollection = 0
      do {
        const page = await deps.listRecords(repo.pds, did, collection, cursor)
        for (const rec of page.records ?? []) {
          if (deps.ingest(rec.uri, rec.cid, rec.value, decision.plan)) {
            result.records++
            inCollection++
          }
          if (opts.maxRecords && result.records >= opts.maxRecords) return result
        }
        cursor = page.cursor
      } while (cursor)
      opts.onProgress?.(collection, inCollection)
    } catch (err) {
      result.errors.push(`${did}/${collection}: ${(err as Error).message}`)
    }
  }

  return result
}
