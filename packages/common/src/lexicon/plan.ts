/* ─────────────────────────────────────────────────────────────────────────
 * Schema-driven extraction plans (tier 2 of the normalization ladder).
 *
 * A lexicon document (resolved at runtime from the network) is compiled
 * into an ExtractionPlan: which record fields hold searchable text, tags,
 * dates, languages, urls, geo. Classification is deterministic:
 * schema structure first (formats, const/enum, blob/ref), field names
 * second (title/name/…), size limits third (short string ≈ title).
 * ───────────────────────────────────────────────────────────────────────── */

import type { IndexedRecord } from '../types.js'
import { stripMarkdown } from '../text.js'

/** Path segments into a record object; '*' maps over an array. */
export type FieldPath = string[]

export interface ExtractionPlan {
  nsid: string
  /** false → the collection carries no human text; triage drops it */
  indexable: boolean
  title: FieldPath[]
  body: FieldPath[]
  tags: FieldPath[]
  createdAt: FieldPath[]
  langs: FieldPath[]
  url: FieldPath[]
  geo?: { lat: FieldPath; lon: FieldPath; geohash?: FieldPath }
}

const TITLE_NAMES = ['title', 'name', 'displayName', 'subject', 'heading', 'label']
const BODY_NAMES = ['text', 'content', 'body', 'description', 'summary', 'message', 'bio', 'note']
const TAG_NAMES = ['tags', 'labels', 'keywords', 'categories', 'topics']
const DATE_NAMES = ['createdAt', 'updatedAt', 'publishedAt', 'indexedAt', 'timestamp']
const NEVER_TEXT_NAMES = new Set(['geohash', 'password', 'secret', 'token'])
const MACHINE_FORMATS = new Set([
  'at-uri', 'did', 'cid', 'at-identifier', 'nsid', 'tid', 'record-key', 'handle',
])
const TITLE_MAX_LENGTH = 256

interface Candidate { path: FieldPath; rank: number }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Props = Record<string, any>

export function compileExtractionPlan(doc: unknown): ExtractionPlan | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = doc as { id?: unknown; defs?: Record<string, any> } | null
  if (!d || typeof d !== 'object') return null
  const nsid = typeof d.id === 'string' ? d.id : null
  const main = d.defs?.main
  if (!nsid || !main || main.type !== 'record') return null
  const props: Props | undefined = main.record?.properties
  if (!props || typeof props !== 'object') return null

  const title: Candidate[] = []
  const body: Candidate[] = []
  const tags: Candidate[] = []
  const createdAt: Candidate[] = []
  const langs: Candidate[] = []
  const url: Candidate[] = []
  let geo: ExtractionPlan['geo']

  let order = 0
  const walk = (prefix: FieldPath, properties: Props, depth: number): void => {
    // Geo pair detection at this object level
    const numeric = (n: string) =>
      properties[n] && ['integer', 'number', 'float'].includes(properties[n].type)
    const latName = ['lat', 'latitude'].find(numeric)
    const lonName = ['lon', 'lng', 'longitude'].find(numeric)
    if (!geo && latName && lonName) {
      geo = {
        lat: [...prefix, latName],
        lon: [...prefix, lonName],
        ...(properties.geohash?.type === 'string'
          ? { geohash: [...prefix, 'geohash'] }
          : {}),
      }
    }

    for (const [name, schema] of Object.entries(properties)) {
      if (!schema || typeof schema !== 'object') continue
      const path = [...prefix, name]
      const ord = order++

      if (schema.type === 'string') {
        if (NEVER_TEXT_NAMES.has(name)) continue
        // const / closed enum → machine config values, never text
        if (schema.const !== undefined || Array.isArray(schema.enum)) continue
        if (schema.format === 'datetime') { createdAt.push({ path, rank: ord }); continue }
        if (schema.format === 'language') { langs.push({ path, rank: ord }); continue }
        if (schema.format === 'uri') { url.push({ path, rank: ord }); continue }
        if (schema.format && MACHINE_FORMATS.has(schema.format)) continue
        if (DATE_NAMES.includes(name)) { createdAt.push({ path, rank: 50 + ord }); continue }
        // knownValues is an *open* set (e.g. mode: pure-v1) → useful as a tag
        if (Array.isArray(schema.knownValues)) { tags.push({ path, rank: ord }); continue }
        const titleIdx = TITLE_NAMES.indexOf(name)
        if (titleIdx >= 0) { title.push({ path, rank: titleIdx }); continue }
        const bodyIdx = BODY_NAMES.indexOf(name)
        if (bodyIdx >= 0) { body.push({ path, rank: bodyIdx }); continue }
        const limit = schema.maxLength ?? schema.maxGraphemes
        if (typeof limit === 'number' && limit <= TITLE_MAX_LENGTH) {
          title.push({ path, rank: 100 + ord })
        } else {
          body.push({ path, rank: 100 + ord })
        }
        continue
      }

      if (schema.type === 'array') {
        const items = schema.items
        if (items?.type === 'string' && !items.format && !Array.isArray(items.enum)) {
          if (TAG_NAMES.includes(name)) tags.push({ path, rank: ord })
          else body.push({ path: [...path, '*'], rank: 100 + ord })
          continue
        }
        if (items?.type === 'object' && items.properties && depth < 1) {
          walk([...path, '*'], items.properties, depth + 1)
        }
        continue
      }

      if (schema.type === 'object' && schema.properties && depth < 1) {
        walk(path, schema.properties, depth + 1)
        continue
      }
      // ref, union, blob, bytes, cid-link, boolean, integer, unknown → skipped
    }
  }

  walk([], props, 0)

  const byRank = (c: Candidate[]): FieldPath[] =>
    [...c].sort((a, b) => a.rank - b.rank).map((x) => x.path)

  return {
    nsid,
    indexable: title.length + body.length + tags.length > 0,
    title: byRank(title),
    body: byRank(body),
    tags: byRank(tags),
    createdAt: byRank(createdAt),
    langs: byRank(langs),
    url: byRank(url),
    ...(geo ? { geo } : {}),
  }
}

/* ── Plan execution ─────────────────────────────────────────────────────── */

function resolveValues(record: Record<string, unknown>, path: FieldPath): unknown[] {
  let current: unknown[] = [record]
  for (const seg of path) {
    const next: unknown[] = []
    for (const v of current) {
      if (v === null || typeof v !== 'object') continue
      if (seg === '*') {
        if (Array.isArray(v)) next.push(...v)
      } else {
        next.push((v as Record<string, unknown>)[seg])
      }
    }
    current = next
  }
  return current.filter((v) => v !== undefined && v !== null)
}

function firstString(record: Record<string, unknown>, paths: FieldPath[]): string | undefined {
  for (const p of paths) {
    for (const v of resolveValues(record, p)) {
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return undefined
}

/**
 * Apply a compiled plan to one raw record. Same output contract as the
 * hand-written adapters. Returns null when no text resolves (plan paths
 * are candidates, not guarantees — fields may be optional or empty).
 */
export function executeExtractionPlan(
  plan: ExtractionPlan,
  did: string,
  rkey: string,
  record: Record<string, unknown>,
): IndexedRecord | null {
  const title = firstString(record, plan.title)

  const bodyParts: string[] = []
  for (const p of plan.body) {
    for (const v of resolveValues(record, p)) {
      if (typeof v === 'string' && v.trim() && v.trim() !== title) {
        bodyParts.push(stripMarkdown(v.trim()))
      }
    }
  }
  const body = bodyParts.length ? bodyParts.join('\n\n') : undefined

  if (!title && !body) return null

  const tags: string[] = []
  for (const p of plan.tags) {
    for (const v of resolveValues(record, p)) {
      for (const t of Array.isArray(v) ? v : [v]) {
        if (typeof t === 'string' && t.trim()) {
          const norm = t.trim().toLowerCase()
          if (!tags.includes(norm)) tags.push(norm)
        }
      }
    }
  }

  const createdAtRaw = firstString(record, plan.createdAt)
  const createdAt =
    createdAtRaw && Number.isFinite(Date.parse(createdAtRaw))
      ? createdAtRaw
      : new Date().toISOString()

  const langs: string[] = []
  for (const p of plan.langs) {
    for (const v of resolveValues(record, p)) {
      if (typeof v === 'string' && v.trim()) {
        const code = v.trim().toLowerCase().slice(0, 2)
        if (!langs.includes(code)) langs.push(code)
      }
    }
  }

  let urlValue: string | undefined
  for (const p of plan.url) {
    for (const v of resolveValues(record, p)) {
      if (typeof v === 'string' && /^https?:\/\//i.test(v)) { urlValue = v; break }
    }
    if (urlValue) break
  }
  const canonicalUrl =
    urlValue ?? `https://atproto.com/at/${encodeURIComponent(`at://${did}/${plan.nsid}/${rkey}`)}`

  let location: IndexedRecord['location']
  if (plan.geo) {
    const lat = resolveValues(record, plan.geo.lat)[0]
    const lon = resolveValues(record, plan.geo.lon)[0]
    const gh = plan.geo.geohash ? resolveValues(record, plan.geo.geohash)[0] : undefined
    if (typeof lat === 'number' && typeof lon === 'number') {
      location = { lat, lon, geohash: typeof gh === 'string' ? gh : '' }
    }
  }

  return {
    $type: plan.nsid,
    title: title ?? (body as string).slice(0, 80),
    description: body,
    tags: tags.length ? tags : undefined,
    langs: langs.length ? langs : undefined,
    author: { did },
    createdAt,
    url: canonicalUrl,
    ...(location ? { location } : {}),
  }
}
