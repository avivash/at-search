import { buildAtUri, type IndexedRecord } from './types.js'

/**
 * Normalise a raw AT Proto record into the IndexedRecord shape.
 * Returns null if the record type is not supported or malformed.
 */
export function normalizeRecord(
  did: string,
  collection: string,
  rkey: string,
  raw: unknown,
): IndexedRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  if (collection === 'app.bsky.feed.post') {
    return normalizePost(did, rkey, r)
  }

  if (collection === 'app.bsky.actor.profile') {
    return normalizeProfile(did, r)
  }

  if (collection === 'com.example.thing') {
    return normalizeThing(did, r)
  }

  if (collection === 'at.functions.metadata') {
    return normalizeFunctionsMetadata(did, rkey, r)
  }

  // Best-effort fallback for other lexicons (e.g. custom app records).
  return normalizeGeneric(did, collection, r)
}

function normalizeFunctionsMetadata(
  did: string,
  rkey: string,
  r: Record<string, unknown>,
): IndexedRecord | null {
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!name) return null

  const version = typeof r.version === 'string' ? r.version.trim() : ''
  const title = version ? `${name} v${version}` : name

  const baseDesc =
    typeof r.description === 'string' && r.description.trim() ? r.description.trim() : undefined

  const mode = typeof r.mode === 'string' ? r.mode.trim() : ''
  const bits: string[] = []
  if (mode) bits.push(`Mode: ${mode}.`)
  if (typeof r.maxMemoryMb === 'number') bits.push(`Max memory: ${r.maxMemoryMb} MB.`)
  if (typeof r.maxDurationMs === 'number') bits.push(`Max duration: ${r.maxDurationMs} ms.`)
  if (typeof r.public === 'boolean') bits.push(r.public ? 'Public.' : 'Private.')

  const allowedHosts = r.allowedHosts
  if (Array.isArray(allowedHosts) && allowedHosts.length > 0) {
    const hosts = allowedHosts
      .filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
      .slice(0, 8)
    if (hosts.length > 0) {
      const more = allowedHosts.length > 8 ? ' …' : ''
      bits.push(`Allowed hosts: ${hosts.join(', ')}${more}.`)
    }
  }

  const atUri = buildAtUri(did, 'at.functions.metadata', rkey)
  bits.push(`AT URI: ${atUri}.`)

  const tail = bits.length > 0 ? `\n\n${bits.join(' ')}` : ''
  const description =
    baseDesc !== undefined ? baseDesc + tail : bits.length > 0 ? bits.join(' ').trim() : undefined

  const tags: string[] = ['at-functions', 'wasm']
  if (mode) tags.push(mode.toLowerCase())

  return {
    $type: 'at.functions.metadata',
    title,
    description,
    tags,
    author: { did },
    createdAt:
      typeof r.createdAt === 'string' && r.createdAt.trim()
        ? r.createdAt
        : new Date().toISOString(),
  }
}

function normalizeGeneric(did: string, collection: string, r: Record<string, unknown>): IndexedRecord | null {
  const $type = typeof r.$type === 'string' ? r.$type : collection

  const title =
    (typeof r.name === 'string' && r.name.trim()) ||
    (typeof r.title === 'string' && r.title.trim()) ||
    (typeof r.displayName === 'string' && r.displayName.trim()) ||
    ''

  const description =
    (typeof r.description === 'string' && r.description.trim()) ||
    (typeof r.summary === 'string' && r.summary.trim()) ||
    (typeof r.text === 'string' && r.text.trim()) ||
    undefined

  // If there is no meaningful text, skip indexing.
  if (!title && !description) return null

  const tags: string[] = []
  if (Array.isArray(r.tags)) {
    for (const t of r.tags) {
      if (typeof t === 'string' && t.trim()) tags.push(t.trim().toLowerCase())
    }
  }

  return {
    $type,
    title: title || did,
    description: description || undefined,
    tags: tags.length ? tags : undefined,
    author: { did },
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
    url: typeof r.url === 'string' ? r.url : undefined,
  }
}

function normalizePost(did: string, rkey: string, r: Record<string, unknown>): IndexedRecord | null {
  const text = typeof r.text === 'string' ? r.text : null
  if (!text) return null

  const createdAt = typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString()

  const tags: string[] = []
  if (Array.isArray(r.tags)) {
    for (const t of r.tags) {
      if (typeof t === 'string') tags.push(t.toLowerCase())
    }
  }
  if (Array.isArray(r.facets)) {
    for (const facet of r.facets as Array<Record<string, unknown>>) {
      const features = facet.features as Array<Record<string, unknown>> | undefined
      if (!features) continue
      for (const feature of features) {
        if (feature.$type === 'app.bsky.richtext.facet#tag' && typeof feature.tag === 'string') {
          const tag = feature.tag.toLowerCase()
          if (!tags.includes(tag)) tags.push(tag)
        }
      }
    }
  }

  const firstLine = text.split('\n')[0].slice(0, 120)
  const title = firstLine.length < text.length ? firstLine + '…' : firstLine

  return {
    $type: 'app.bsky.feed.post',
    title,
    description: text,
    tags: tags.length > 0 ? tags : undefined,
    author: { did },
    createdAt,
    url: `https://bsky.app/profile/${did}/post/${rkey}`,
  }
}

function normalizeProfile(did: string, r: Record<string, unknown>): IndexedRecord | null {
  const displayName = typeof r.displayName === 'string' ? r.displayName.trim() : ''
  const description = typeof r.description === 'string' ? r.description : undefined

  if (!displayName && !description) return null

  return {
    $type: 'app.bsky.actor.profile',
    title: displayName || did,
    description,
    author: { did },
    createdAt: new Date().toISOString(),
    url: `https://bsky.app/profile/${did}`,
  }
}

function normalizeThing(did: string, r: Record<string, unknown>): IndexedRecord | null {
  if (typeof r.title !== 'string') return null

  const location = (() => {
    const loc = r.location as Record<string, unknown> | undefined
    if (!loc) return undefined
    if (typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return undefined
    return { lat: loc.lat, lon: loc.lon, geohash: String(loc.geohash ?? '') }
  })()

  return {
    $type: 'com.example.thing',
    title: r.title as string,
    description: typeof r.description === 'string' ? r.description : undefined,
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : undefined,
    location,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
    author: { did },
  }
}
