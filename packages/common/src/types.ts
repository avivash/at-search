export interface StrongRef {
  uri: string
  cid: string
}

export interface Location {
  lat: number
  lon: number
  geohash: string
}

/**
 * Normalized record shape stored by the indexer and returned in search results.
 * All AT Proto record types (posts, profiles, com.example.thing) are mapped
 * into this shape on ingest. The original `$type` is preserved so the UI can
 * render type-specific layouts.
 */
export interface IndexedRecord {
  $type: string           // original AT Proto lexicon identifier
  title: string           // derived: displayName, first line of post, record title
  description?: string    // derived: full post text, bio, record description
  tags?: string[]         // hashtags, direct tags
  langs?: string[]        // ISO 639-1 codes when the lexicon declares a language field
  author?: {
    did: string
    handle?: string       // resolved lazily; may be absent
  }
  location?: Location
  createdAt: string
  url?: string            // canonical web URL (e.g. https://bsky.app/profile/…/post/…)
}

/** Legacy alias — seed data uses com.example.thing which maps cleanly to IndexedRecord */
export type ThingRecord = IndexedRecord

export type DescriptorKey = string

export interface PointerRecord {
  version: 1
  descriptorKey: DescriptorKey
  ref: StrongRef
  providerPeerId: string
  providerDid?: string
  indexedAt: string
  expiresAt: string
  signature?: string
}

export interface PointerRecordSigned extends PointerRecord {
  signature: string
}

/**
 * One reason a result scored the way it did. The `points` of a result's
 * components always sum to its `score`, so the UI can explain the ranking
 * instead of showing a bare number.
 */
export interface ScoreComponent {
  reason:
    | 'all-terms'
    | 'token'
    | 'tag'
    | 'geo'
    | 'verified'
    | 'pointer-expired'
    | 'fetch-error'
    | 'cid-mismatch'
    | 'unavailable'
    | 'identity-match'
  /** Human-readable explanation, e.g. `tagged "hamburger"` */
  label: string
  points: number
}

export interface SearchResult {
  ref: StrongRef
  record: IndexedRecord
  matchedDescriptors: DescriptorKey[]
  score: number
  /** Per-signal explanation of `score` */
  scoreBreakdown?: ScoreComponent[]
  verified: boolean
  verificationError?: string
  fetchError?: string
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
  took: number
}

export interface ResolveResponse {
  ref: StrongRef
  record: IndexedRecord
  verified: boolean
  verificationError?: string
}

export interface ParsedAtUri {
  did: string
  collection: string
  rkey: string
}

export function parseAtUri(uri: string): ParsedAtUri {
  const match = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/)
  if (!match) throw new Error(`Invalid AT URI: ${uri}`)
  return { did: match[1], collection: match[2], rkey: match[3] }
}

export function buildAtUri(did: string, collection: string, rkey: string): string {
  return `at://${did}/${collection}/${rkey}`
}

/* ── Raw AT Proto record shapes (for normalisation on ingest) ─────────── */

export interface RawFacetFeatureTag {
  $type: 'app.bsky.richtext.facet#tag'
  tag: string
}

export interface RawFacet {
  $type: 'app.bsky.richtext.facet'
  features: Array<{ $type: string; [k: string]: unknown }>
}

export interface RawPostRecord {
  $type: 'app.bsky.feed.post'
  text: string
  facets?: RawFacet[]
  tags?: string[]
  langs?: string[]
  createdAt: string
  reply?: unknown
}

export interface RawProfileRecord {
  $type: 'app.bsky.actor.profile'
  displayName?: string
  description?: string
}
