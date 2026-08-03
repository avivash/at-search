import { createHash } from 'crypto'
import type { IndexedRecord, RawPostRecord, RawProfileRecord, DescriptorKey } from './types.js'
import { STOPWORDS } from './stopwords.js'

const HASH_PREFIX = 'atsearch:v1:'

export function hashDescriptorKey(key: string): string {
  return createHash('sha256').update(HASH_PREFIX + key).digest('hex')
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
}

/**
 * Derive descriptor keys from a normalised IndexedRecord.
 * Works for any $type — uses title, description, and tags.
 */
export function deriveDescriptors(record: IndexedRecord): DescriptorKey[] {
  const keys = new Set<DescriptorKey>()

  keys.add(`type:${record.$type}`)

  if (record.tags) {
    for (const tag of record.tags) {
      const normalized = tag.toLowerCase().trim().replace(/\s+/g, '-')
      if (normalized) keys.add(`tag:${normalized}`)
    }
  }

  const textSources = [record.title, record.description].filter(Boolean).join(' ')
  for (const token of tokenize(textSources)) {
    keys.add(`token:${token}`)
  }

  if (record.location?.geohash) {
    const gh = record.location.geohash.toLowerCase()
    if (gh.length >= 2) keys.add(`geo:${gh.slice(0, 2)}`)
    if (gh.length >= 4) keys.add(`geo:${gh.slice(0, 4)}`)
    if (gh.length > 4) keys.add(`geo:${gh}`)
  }

  if (record.langs) {
    for (const lang of record.langs) {
      const code = lang.toLowerCase().slice(0, 2)
      if (code) keys.add(`lang:${code}`)
    }
  }

  return Array.from(keys)
}

/**
 * Derive descriptor keys from a raw app.bsky.feed.post record.
 * Extracts hashtags from both the `tags` field and richtext facets.
 */
export function deriveDescriptorsFromPost(
  did: string,
  rkey: string,
  raw: RawPostRecord,
): DescriptorKey[] {
  const keys = new Set<DescriptorKey>()

  keys.add('type:app.bsky.feed.post')

  // Hashtags: from direct tags field
  if (raw.tags) {
    for (const tag of raw.tags) {
      const n = tag.toLowerCase().trim().replace(/\s+/g, '-')
      if (n) keys.add(`tag:${n}`)
    }
  }

  // Hashtags: from richtext facets (#tag features)
  if (raw.facets) {
    for (const facet of raw.facets) {
      for (const feature of facet.features) {
        if (feature.$type === 'app.bsky.richtext.facet#tag' && typeof feature.tag === 'string') {
          const n = (feature.tag as string).toLowerCase().trim().replace(/\s+/g, '-')
          if (n) keys.add(`tag:${n}`)
        }
      }
    }
  }

  // Tokens from post text (strip @mentions and URLs to reduce noise)
  const cleanText = raw.text
    .replace(/@[\w.:-]+/g, ' ')          // remove @mentions
    .replace(/https?:\/\/\S+/g, ' ')     // remove URLs
  for (const token of tokenize(cleanText)) {
    keys.add(`token:${token}`)
  }

  // Language tags
  if (raw.langs) {
    for (const lang of raw.langs) {
      keys.add(`lang:${lang.toLowerCase().slice(0, 2)}`)
    }
  }

  return Array.from(keys)
}

/**
 * Derive descriptor keys from a raw app.bsky.actor.profile record.
 */
export function deriveDescriptorsFromProfile(
  did: string,
  raw: RawProfileRecord,
): DescriptorKey[] {
  const keys = new Set<DescriptorKey>()

  keys.add('type:app.bsky.actor.profile')

  const textSources = [raw.displayName, raw.description].filter(Boolean).join(' ')
  for (const token of tokenize(textSources)) {
    keys.add(`token:${token}`)
  }

  return Array.from(keys)
}

export interface ParsedQuery {
  /** Lexicon NSID filter from an inline `type:` / `collection:` term */
  typeFilter?: string
  /** The query with any filter term removed */
  text: string
}

const TYPE_FILTER_RE = /(?:^|\s)(?:type|collection):([a-zA-Z0-9._-]+)/

/**
 * Split a free-text query into an optional lexicon filter and the remaining
 * text. `type:nsid` / `collection:nsid` may appear anywhere in the query.
 */
export function parseQuery(query: string): ParsedQuery {
  const m = query.match(TYPE_FILTER_RE)
  if (!m) return { text: query.trim() }
  return {
    typeFilter: m[1]!.toLowerCase(),
    text: query.replace(TYPE_FILTER_RE, ' ').replace(/\s+/g, ' ').trim(),
  }
}

/**
 * Translate a free-text query into descriptor keys to look up in the index.
 *
 * Free-text tokens map to `token:` / `tag:` keys. An inline `type:<nsid>`
 * (or `collection:<nsid>`) adds a `type:` key; combined with free text it
 * acts as a candidate source AND a filter (the query node restricts results
 * to that collection).
 */
export function descriptorToQueryKeys(query: string): DescriptorKey[] {
  const { typeFilter, text } = parseQuery(query)
  const keys = new Set<DescriptorKey>()
  if (typeFilter) keys.add(`type:${typeFilter}`)
  for (const token of tokenize(text)) {
    keys.add(`token:${token}`)
    keys.add(`tag:${token}`)
  }
  return Array.from(keys)
}
