import type Database from 'better-sqlite3'
import {
  deriveDescriptors,
  deriveDescriptorsFromPost,
  deriveDescriptorsFromProfile,
  normalizeRecord,
} from '@atsearch/common'
import type { ExtractionPlan, IndexedRecord, RawPostRecord, RawProfileRecord } from '@atsearch/common'
import { upsertRecord, upsertDescriptor } from './db.js'
import type { IngestBatcher } from './ingestBatch.js'

export interface IngestResult {
  uri: string
  cid: string
  descriptors: string[]
}

/**
 * Ingest a record from any supported AT Proto collection.
 * Normalises the raw record into IndexedRecord, stores it, and derives descriptors.
 */
export function ingestRecord(
  db: Database.Database,
  uri: string,
  cid: string,
  rawRecord: unknown,
  plan?: ExtractionPlan,
  batcher?: IngestBatcher,
): IngestResult | null {
  const parts = uri.replace('at://', '').split('/')
  if (parts.length !== 3) return null
  const [did, collection, rkey] = parts

  const normalized = normalizeRecord(did, collection, rkey, rawRecord, plan)
  if (!normalized) return null

  const indexed_at = new Date().toISOString()
  const record = {
    uri,
    cid,
    did,
    collection,
    rkey,
    json: JSON.stringify(normalized),
    indexed_at,
  }
  const descriptors = deriveDescriptorsForRecord(did, collection, rkey, rawRecord, normalized)

  // On the firehose path the batcher commits many records per transaction;
  // without one (seed, poll) write straight through.
  if (batcher) {
    batcher.add({ record, descriptors })
  } else {
    upsertRecord(db, record)
    for (const key of descriptors) {
      upsertDescriptor(db, key, uri, cid)
    }
  }

  return { uri, cid, descriptors }
}

/**
 * Derive descriptors using the type-specific function for richer extraction
 * (e.g. pulling hashtags from facets on posts), then fall back to the
 * generic path for anything else.
 */
function deriveDescriptorsForRecord(
  did: string,
  collection: string,
  rkey: string,
  raw: unknown,
  normalized: IndexedRecord,
): string[] {
  if (collection === 'app.bsky.feed.post') {
    return deriveDescriptorsFromPost(did, rkey, raw as RawPostRecord)
  }
  if (collection === 'app.bsky.actor.profile') {
    return deriveDescriptorsFromProfile(did, raw as RawProfileRecord)
  }
  return deriveDescriptors(normalized)
}
