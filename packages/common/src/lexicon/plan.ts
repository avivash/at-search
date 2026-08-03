/* ─────────────────────────────────────────────────────────────────────────
 * Schema-driven extraction plans (tier 2 of the normalization ladder).
 *
 * A lexicon document (resolved at runtime from the network) is compiled
 * into an ExtractionPlan: which record fields hold searchable text, tags,
 * dates, languages, urls, geo. Classification is deterministic:
 * schema structure first (formats, const/enum, blob/ref), field names
 * second (title/name/…), size limits third (short string ≈ title).
 * ───────────────────────────────────────────────────────────────────────── */

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
