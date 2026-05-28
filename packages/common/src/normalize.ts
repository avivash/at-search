import { buildAtUri, type IndexedRecord } from './types.js'

/* ─────────────────────────────────────────────────────────────────────────
 * Cross-lexicon normalisation
 *
 * The "cross-pollination" problem: AT Proto apps each invent their own lexicon.
 * A search engine needs to extract searchable text from records it has never
 * seen before, rank them uniformly, and let results from different apps appear
 * alongside each other in the same result set.
 *
 * Architecture:
 *  1. KNOWN ADAPTERS  — rich extraction for popular lexicons (right fields,
 *     right URL, right tags). Add one per app.
 *  2. GENERIC FALLBACK — heuristic field-name probing for any unknown lexicon.
 *     Never returns null for a record that has ANY string content.
 *
 * Adding a new lexicon: write a `normalizeXxx` function and register it in
 * the ADAPTERS map below. No other file needs to change.
 * ───────────────────────────────────────────────────────────────────────── */

type NormaliseFn = (did: string, rkey: string, r: Record<string, unknown>) => IndexedRecord | null

const ADAPTERS: Record<string, NormaliseFn> = {
  'app.bsky.feed.post':         normalizePost,
  'app.bsky.actor.profile':     normalizeProfile,
  'app.bsky.feed.generator':    normalizeFeedGenerator,
  'app.bsky.graph.list':        normalizeList,
  'app.bsky.graph.starterpack': normalizeStarterPack,
  'com.whtwnd.blog.entry':      normalizeWhiteWind,
  'fyi.unravel.frontpage.post': normalizeFrontpage,
  'blue.linkat.board':          normalizeLinkat,
  'at.functions.metadata':      normalizeFunctionsMetadata,
  'com.example.thing':          normalizeThing,
}

/**
 * Normalise a raw AT Proto record into the IndexedRecord shape.
 * Tries a known adapter first; falls back to heuristic extraction.
 * Returns null only if the record has no extractable text at all.
 */
export function normalizeRecord(
  did: string,
  collection: string,
  rkey: string,
  raw: unknown,
): IndexedRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  const adapter = ADAPTERS[collection]
  if (adapter) return adapter(did, rkey, r)

  return normalizeGeneric(did, collection, rkey, r)
}

/* ── Lexicon metadata (for UI display) ──────────────────────────────────── */

export interface LexiconMeta {
  /** Short human label: "post", "blog", "feed", etc. */
  label: string
  /** CSS modifier appended to .type-chip--{variant} */
  variant: 'post' | 'profile' | 'feed' | 'list' | 'blog' | 'link' | 'function' | 'thing' | 'generic'
}

const LEXICON_META: Record<string, LexiconMeta> = {
  'app.bsky.feed.post':         { label: 'post',     variant: 'post' },
  'app.bsky.actor.profile':     { label: 'profile',  variant: 'profile' },
  'app.bsky.feed.generator':    { label: 'feed',     variant: 'feed' },
  'app.bsky.graph.list':        { label: 'list',     variant: 'list' },
  'app.bsky.graph.starterpack': { label: 'starter',  variant: 'list' },
  'com.whtwnd.blog.entry':      { label: 'blog',     variant: 'blog' },
  'fyi.unravel.frontpage.post': { label: 'link',     variant: 'link' },
  'blue.linkat.board':          { label: 'linkat',   variant: 'link' },
  'at.functions.metadata':      { label: 'function', variant: 'function' },
  'com.example.thing':          { label: 'thing',    variant: 'thing' },
}

/**
 * Return display metadata for a lexicon $type string.
 * Falls back gracefully for unknown types using the last segment of the
 * reverse-DNS identifier (e.g. "app.bsky.feed.like" → "like").
 */
export function lexiconMeta($type: string): LexiconMeta {
  const known = LEXICON_META[$type]
  if (known) return known
  const segments = $type.split('.')
  const label = segments[segments.length - 1] ?? $type
  return { label, variant: 'generic' }
}

/* ── Known adapters ─────────────────────────────────────────────────────── */

function normalizePost(did: string, rkey: string, r: Record<string, unknown>): IndexedRecord | null {
  const text = typeof r.text === 'string' ? r.text : null
  if (!text) return null

  const createdAt = str(r.createdAt) ?? new Date().toISOString()

  const tags: string[] = []
  if (Array.isArray(r.tags)) {
    for (const t of r.tags) if (typeof t === 'string') tags.push(t.toLowerCase())
  }
  if (Array.isArray(r.facets)) {
    for (const facet of r.facets as Array<Record<string, unknown>>) {
      for (const feature of (facet.features as Array<Record<string, unknown>>) ?? []) {
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
    tags: tags.length ? tags : undefined,
    author: { did },
    createdAt,
    url: `https://bsky.app/profile/${did}/post/${rkey}`,
  }
}

function normalizeProfile(did: string, _rkey: string, r: Record<string, unknown>): IndexedRecord | null {
  const displayName = str(r.displayName)?.trim() ?? ''
  const description = str(r.description)
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

function normalizeFeedGenerator(did: string, rkey: string, r: Record<string, unknown>): IndexedRecord | null {
  const displayName = str(r.displayName)?.trim() ?? ''
  const description = str(r.description)
  if (!displayName && !description) return null

  return {
    $type: 'app.bsky.feed.generator',
    title: displayName || `feed/${rkey}`,
    description,
    author: { did },
    createdAt: str(r.createdAt) ?? new Date().toISOString(),
    // Feed URIs on bsky.app: /profile/{did}/feed/{rkey}
    url: `https://bsky.app/profile/${did}/feed/${rkey}`,
  }
}

function normalizeList(did: string, rkey: string, r: Record<string, unknown>): IndexedRecord | null {
  const name = str(r.name)?.trim() ?? ''
  const description = str(r.description)
  if (!name && !description) return null

  return {
    $type: 'app.bsky.graph.list',
    title: name || `list/${rkey}`,
    description,
    author: { did },
    createdAt: str(r.createdAt) ?? new Date().toISOString(),
    url: `https://bsky.app/profile/${did}/lists/${rkey}`,
  }
}

function normalizeStarterPack(did: string, rkey: string, r: Record<string, unknown>): IndexedRecord | null {
  const rec = r.record as Record<string, unknown> | undefined
  const name = str(rec?.name ?? r.name)?.trim() ?? ''
  const description = str(rec?.description ?? r.description)
  if (!name && !description) return null

  return {
    $type: 'app.bsky.graph.starterpack',
    title: name || `starter/${rkey}`,
    description,
    author: { did },
    createdAt: str(r.createdAt) ?? new Date().toISOString(),
    url: `https://bsky.app/start/${did}/${rkey}`,
  }
}

/**
 * WhiteWind — AT Proto blogging app (https://whtwnd.com)
 * Lexicon: com.whtwnd.blog.entry
 * Fields: title (string), content (string, markdown), createdAt, ogp?
 */
function normalizeWhiteWind(did: string, rkey: string, r: Record<string, unknown>): IndexedRecord | null {
  const title = str(r.title)?.trim() ?? ''
  // Content is markdown — strip common formatting for better tokenisation
  const rawContent = str(r.content) ?? str(r.text)
  const content = rawContent ? stripMarkdown(rawContent) : undefined
  const visibility = str(r.visibility)

  // Skip non-public entries (private/unlisted) if the field exists
  if (visibility && visibility !== 'public' && visibility !== 'author') {
    // 'author' is WhiteWind's "only me" — still skip from public search
    if (visibility !== 'public') return null
  }

  if (!title && !content) return null

  return {
    $type: 'com.whtwnd.blog.entry',
    title: title || content?.slice(0, 80) || '(untitled)',
    description: content,
    author: { did },
    createdAt: str(r.createdAt) ?? new Date().toISOString(),
    // WhiteWind URLs require the handle — use the AT Proto browser as fallback
    url: `https://whtwnd.com/${did}/entries/${rkey}`,
  }
}

/**
 * Frontpage — AT Proto link aggregator (https://frontpage.fyi)
 * Lexicon: fyi.unravel.frontpage.post
 * Fields: title (string), url (string), createdAt
 */
function normalizeFrontpage(did: string, rkey: string, r: Record<string, unknown>): IndexedRecord | null {
  const title = str(r.title)?.trim() ?? ''
  const linkUrl = str(r.url)
  if (!title && !linkUrl) return null

  return {
    $type: 'fyi.unravel.frontpage.post',
    title: title || linkUrl || '(untitled)',
    description: linkUrl ? `→ ${linkUrl}` : undefined,
    author: { did },
    createdAt: str(r.createdAt) ?? new Date().toISOString(),
    url: `https://frontpage.fyi/post/${rkey}`,
  }
}

/**
 * Linkat — AT Proto link-in-bio app (https://linkat.blue)
 * Lexicon: blue.linkat.board
 * Fields: name (string), links [{uri, title}]
 */
function normalizeLinkat(did: string, _rkey: string, r: Record<string, unknown>): IndexedRecord | null {
  const name = str(r.name)?.trim() ?? ''
  const links = Array.isArray(r.links) ? r.links as Array<Record<string, unknown>> : []
  const linkTitles = links
    .map(l => str(l.title) ?? str(l.uri) ?? '')
    .filter(Boolean)
    .join(', ')

  if (!name && !linkTitles) return null

  return {
    $type: 'blue.linkat.board',
    title: name || `${did} links`,
    description: linkTitles || undefined,
    author: { did },
    createdAt: new Date().toISOString(),
    url: `https://linkat.blue/${did}`,
  }
}

/**
 * AT Functions — WASM function registry (at.functions.metadata)
 */
function normalizeFunctionsMetadata(did: string, rkey: string, r: Record<string, unknown>): IndexedRecord | null {
  const name = str(r.name)?.trim() ?? ''
  if (!name) return null

  const version = str(r.version)?.trim() ?? ''
  const title = version ? `${name} v${version}` : name
  const baseDesc = str(r.description)?.trim()

  const bits: string[] = []
  const mode = str(r.mode)?.trim()
  if (mode) bits.push(`Mode: ${mode}.`)
  if (typeof r.maxMemoryMb === 'number') bits.push(`Max memory: ${r.maxMemoryMb} MB.`)
  if (typeof r.maxDurationMs === 'number') bits.push(`Max duration: ${r.maxDurationMs} ms.`)
  if (typeof r.public === 'boolean') bits.push(r.public ? 'Public.' : 'Private.')

  const tail = bits.length ? `\n\n${bits.join(' ')}` : ''
  const description = baseDesc !== undefined ? baseDesc + tail : bits.join(' ').trim() || undefined

  const tags: string[] = ['at-functions', 'wasm']
  if (mode) tags.push(mode.toLowerCase())

  const atUri = buildAtUri(did, 'at.functions.metadata', rkey)
  return {
    $type: 'at.functions.metadata',
    title,
    description: description ? description + `\n\nAT URI: ${atUri}` : `AT URI: ${atUri}`,
    tags,
    author: { did },
    createdAt: str(r.createdAt) ?? new Date().toISOString(),
  }
}

/**
 * com.example.thing — prototype lexicon used by the seed script
 */
function normalizeThing(did: string, _rkey: string, r: Record<string, unknown>): IndexedRecord | null {
  if (typeof r.title !== 'string') return null

  const location = (() => {
    const loc = r.location as Record<string, unknown> | undefined
    if (!loc) return undefined
    if (typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return undefined
    return { lat: loc.lat, lon: loc.lon, geohash: String(loc.geohash ?? '') }
  })()

  return {
    $type: 'com.example.thing',
    title: r.title,
    description: str(r.description),
    tags: Array.isArray(r.tags) ? (r.tags as string[]) : undefined,
    location,
    createdAt: str(r.createdAt) ?? new Date().toISOString(),
    author: { did },
  }
}

/* ── Universal fallback ─────────────────────────────────────────────────── */

/**
 * Heuristic normaliser for any lexicon not in the ADAPTERS map.
 *
 * Probes common field name patterns used across the AT Proto ecosystem.
 * Returns null only if the record contains no extractable string content.
 *
 * Field probing priority:
 *   title   → title > name > displayName > subject > heading
 *   body    → text > content > body > description > summary > value > message
 *   tags    → tags > labels > categories > keywords
 *   date    → createdAt > created_at > publishedAt > indexedAt > timestamp
 *   url     → url > uri > link > href (also builds AT Proto browser link as fallback)
 */
function normalizeGeneric(
  did: string,
  collection: string,
  rkey: string,
  r: Record<string, unknown>,
): IndexedRecord | null {
  const title =
    str(r.title)?.trim() ||
    str(r.name)?.trim() ||
    str(r.displayName)?.trim() ||
    str(r.subject)?.trim() ||
    str(r.heading)?.trim() ||
    ''

  const bodyRaw =
    str(r.text) ||
    str(r.content) ||
    str(r.body) ||
    str(r.description) ||
    str(r.summary) ||
    str(r.value) ||
    str(r.message) ||
    ''
  const body = bodyRaw ? stripMarkdown(bodyRaw) : ''

  if (!title && !body) return null

  const tags: string[] = []
  for (const field of ['tags', 'labels', 'categories', 'keywords']) {
    if (Array.isArray(r[field])) {
      for (const t of r[field] as unknown[]) {
        if (typeof t === 'string' && t.trim()) tags.push(t.trim().toLowerCase())
      }
      break
    }
  }

  const createdAt =
    str(r.createdAt) ??
    str(r.created_at) ??
    str(r.publishedAt) ??
    str(r.indexedAt) ??
    str(r.timestamp) ??
    new Date().toISOString()

  // For unknown lexicons, link to the AT Proto browser (atproto.com)
  const rawUrl =
    str(r.url) || str(r.uri) || str(r.link) || str(r.href) || ''
  const canonicalUrl =
    rawUrl.startsWith('http')
      ? rawUrl
      : `https://atproto.com/at/${encodeURIComponent(`at://${did}/${collection}/${rkey}`)}`

  const derivedTitle = title || body.slice(0, 80) || collection

  return {
    $type: collection,
    title: derivedTitle,
    description: body || undefined,
    tags: tags.length ? tags : undefined,
    author: { did },
    createdAt,
    url: canonicalUrl,
  }
}

/* ── Utilities ──────────────────────────────────────────────────────────── */

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Strip the most common Markdown syntax so tokenisation works on prose,
 * not on `##`, `**`, `[]()`, etc.
 */
function stripMarkdown(md: string): string {
  return md
    .replace(/!\[.*?\]\(.*?\)/g, '')        // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → label only
    .replace(/^#{1,6}\s+/gm, '')             // headings
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1') // bold/italic
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')   // underscores
    .replace(/`{1,3}[^`]*`{1,3}/g, '')       // inline code / code blocks
    .replace(/^[-*+]\s+/gm, '')              // list bullets
    .replace(/^\d+\.\s+/gm, '')              // numbered list
    .replace(/^>\s+/gm, '')                  // blockquotes
    .replace(/\n{3,}/g, '\n\n')              // collapse extra blank lines
    .trim()
}
