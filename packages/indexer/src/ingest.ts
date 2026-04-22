import type Database from 'better-sqlite3'
import {
  deriveDescriptors,
  deriveDescriptorsFromPost,
  deriveDescriptorsFromProfile,
  normalizeRecord,
} from '@atsearch/common'
import type { IndexedRecord, RawPostRecord, RawProfileRecord } from '@atsearch/common'
import { upsertRecord, upsertDescriptor } from './db.js'

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
): IngestResult | null {
  const parts = uri.replace('at://', '').split('/')
  if (parts.length !== 3) return null
  const [did, collection, rkey] = parts

  const normalized = normalizeRecord(did, collection, rkey, rawRecord)
  if (!normalized) return null

  const indexed_at = new Date().toISOString()

  upsertRecord(db, {
    uri,
    cid,
    did,
    collection,
    rkey,
    json: JSON.stringify(normalized),
    indexed_at,
  })

  const descriptors = deriveDescriptorsForRecord(did, collection, rkey, rawRecord, normalized)
  for (const key of descriptors) {
    upsertDescriptor(db, key, uri, cid)
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
