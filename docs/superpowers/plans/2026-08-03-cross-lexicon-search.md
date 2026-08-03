# Cross-Lexicon Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Schema-driven cross-lexicon indexing: resolve any collection's published lexicon at runtime, compile it into an extraction plan, and use a three-tier normalization ladder (adapter → plan → heuristic) with collection triage, so AT Search indexes the whole ATmosphere without per-app code.

**Architecture:** Pure plan compiler/executor in `@atsearch/common`; SQLite-backed `LexiconRegistry` + triage in the indexer wired into both firehose consumers; `type:` filter composition in the query node; metadata endpoints and UI chip fallback. Spec: `docs/superpowers/specs/2026-08-03-cross-lexicon-search-design.md`.

**Tech Stack:** TypeScript 5.3 ESM monorepo (pnpm workspaces), Jest (ts-jest ESM preset), better-sqlite3, Fastify 4, `@atproto/lexicon-resolver`, SvelteKit demo client.

## Global Constraints

- All packages are ESM (`"type": "module"`); **source imports use `.js` suffixes** (`./db.js`), test files import without suffix (matches existing style).
- Build `@atsearch/common` before building/testing dependents: `pnpm --filter @atsearch/common run build`.
- Run all commands from the repo root unless stated otherwise.
- Common test command: `pnpm --filter @atsearch/common run test`. It expands to `NODE_OPTIONS=--experimental-vm-modules jest --testPathPattern=src/__tests__`.
- Feature flag `ATSEARCH_LEXICON_MODE` defaults to `curated` (current behavior) until Task 10 flips it to `auto`.
- Never break existing exports of `@atsearch/common` — indexer and query-node consume them via `workspace:*`.
- Commit after every task with the message given in its final step.

---

### Task 1: Shared text util + `compileExtractionPlan`

**Files:**
- Create: `packages/common/src/text.ts`
- Create: `packages/common/src/lexicon/plan.ts`
- Create: `packages/common/src/__tests__/fixtures/lexicons.ts`
- Create: `packages/common/src/__tests__/plan.test.ts`
- Modify: `packages/common/src/normalize.ts` (move `stripMarkdown` out; import from `./text.js`)
- Modify: `packages/common/src/index.ts` (add exports)

**Interfaces:**
- Consumes: `IndexedRecord` from `packages/common/src/types.ts` (unchanged here).
- Produces: `stripMarkdown(md: string): string` (from `./text.js`); `type FieldPath = string[]`; `interface ExtractionPlan { nsid: string; indexable: boolean; title: FieldPath[]; body: FieldPath[]; tags: FieldPath[]; createdAt: FieldPath[]; langs: FieldPath[]; url: FieldPath[]; geo?: { lat: FieldPath; lon: FieldPath; geohash?: FieldPath } }`; `compileExtractionPlan(doc: unknown): ExtractionPlan | null`. Task 2 adds `executeExtractionPlan` to the same file; Tasks 3, 5 import both from `@atsearch/common`.

- [ ] **Step 1: Create the fixtures file**

`packages/common/src/__tests__/fixtures/lexicons.ts` — trimmed but structurally real lexicon documents:

```ts
/** Real-world lexicon documents (trimmed to the fields that matter structurally). */

export const LIKE_LEXICON = {
  lexicon: 1,
  id: 'app.bsky.feed.like',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['subject', 'createdAt'],
        properties: {
          subject: { type: 'ref', ref: 'com.atproto.repo.strongRef' },
          createdAt: { type: 'string', format: 'datetime' },
        },
      },
    },
  },
}

export const WHTWND_LEXICON = {
  lexicon: 1,
  id: 'com.whtwnd.blog.entry',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      description: 'A blog entry on WhiteWind',
      record: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', maxLength: 100000 },
          title: { type: 'string', maxLength: 1000 },
          subtitle: { type: 'string', maxLength: 1000 },
          createdAt: { type: 'string', format: 'datetime' },
          ogp: { type: 'ref', ref: 'com.whtwnd.blog.defs#ogp' },
          theme: { type: 'string', enum: ['github-light'] },
          isDraft: { type: 'boolean' },
          visibility: { type: 'string', enum: ['public', 'url', 'author'], default: 'public' },
        },
      },
    },
  },
}

export const FUNCTIONS_LEXICON = {
  lexicon: 1,
  id: 'at.functions.metadata',
  defs: {
    main: {
      type: 'record',
      key: 'any',
      description: 'A WebAssembly function registered on AT Protocol',
      record: {
        type: 'object',
        required: ['name', 'version', 'mode', 'code', 'entrypoint'],
        properties: {
          name: { type: 'string', maxLength: 128 },
          version: { type: 'string', maxLength: 32 },
          updatedAt: { type: 'string', maxLength: 64 },
          description: { type: 'string', maxLength: 2048 },
          mode: { type: 'string', knownValues: ['pure-v1', 'host-v1', 'component-v1'] },
          code: { type: 'blob', accept: ['application/wasm'] },
          entrypoint: { type: 'string', const: 'run' },
          maxMemoryMb: { type: 'integer', minimum: 1, maximum: 256 },
          public: { type: 'boolean' },
        },
      },
    },
  },
}

export const FRONTPAGE_LEXICON = {
  lexicon: 1,
  id: 'fyi.unravel.frontpage.post',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['title', 'url', 'createdAt'],
        properties: {
          title: { type: 'string', maxGraphemes: 300 },
          url: { type: 'string', format: 'uri' },
          createdAt: { type: 'string', format: 'datetime' },
        },
      },
    },
  },
}

export const LINKBOARD_LEXICON = {
  lexicon: 1,
  id: 'blue.linkat.board',
  defs: {
    main: {
      type: 'record',
      key: 'literal:self',
      record: {
        type: 'object',
        required: ['links'],
        properties: {
          name: { type: 'string', maxLength: 500 },
          links: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string', format: 'uri' },
                text: { type: 'string', maxLength: 5000 },
              },
            },
          },
        },
      },
    },
  },
}

export const PLACE_LEXICON = {
  lexicon: 1,
  id: 'com.example.place',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', maxLength: 200 },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          langs: { type: 'string', format: 'language' },
          author: { type: 'string', format: 'did' },
          location: {
            type: 'object',
            properties: {
              lat: { type: 'number' },
              lon: { type: 'number' },
              geohash: { type: 'string', maxLength: 12 },
            },
          },
          createdAt: { type: 'string', format: 'datetime' },
        },
      },
    },
  },
}

/** Not a record lexicon — XRPC query. compileExtractionPlan must return null. */
export const QUERY_LEXICON = {
  lexicon: 1,
  id: 'app.bsky.feed.getTimeline',
  defs: {
    main: {
      type: 'query',
      parameters: { type: 'params', properties: { limit: { type: 'integer' } } },
    },
  },
}
```

- [ ] **Step 2: Write the failing tests**

`packages/common/src/__tests__/plan.test.ts`:

```ts
import { compileExtractionPlan } from '../lexicon/plan'
import {
  LIKE_LEXICON,
  WHTWND_LEXICON,
  FUNCTIONS_LEXICON,
  FRONTPAGE_LEXICON,
  LINKBOARD_LEXICON,
  PLACE_LEXICON,
  QUERY_LEXICON,
} from './fixtures/lexicons'

describe('compileExtractionPlan', () => {
  it('returns null for non-record lexicons', () => {
    expect(compileExtractionPlan(QUERY_LEXICON)).toBeNull()
    expect(compileExtractionPlan(null)).toBeNull()
    expect(compileExtractionPlan({ lexicon: 1 })).toBeNull()
  })

  it('marks text-free collections as not indexable (triage)', () => {
    const plan = compileExtractionPlan(LIKE_LEXICON)!
    expect(plan.nsid).toBe('app.bsky.feed.like')
    expect(plan.indexable).toBe(false)
    expect(plan.title).toEqual([])
    expect(plan.body).toEqual([])
    // datetime is still recognized, but dates alone are not searchable text
    expect(plan.createdAt).toEqual([['createdAt']])
  })

  it('classifies whtwnd blog: named title/body win, enums and refs skipped', () => {
    const plan = compileExtractionPlan(WHTWND_LEXICON)!
    expect(plan.indexable).toBe(true)
    expect(plan.title[0]).toEqual(['title'])
    expect(plan.body[0]).toEqual(['content'])
    // subtitle: unnamed-match, maxLength 1000 > 256 → body candidate after named ones
    expect(plan.body).toContainEqual(['subtitle'])
    // enum strings (theme, visibility) are closed config sets → skipped entirely
    expect(plan.tags).toEqual([])
    const all = [...plan.title, ...plan.body, ...plan.tags]
    expect(all).not.toContainEqual(['theme'])
    expect(all).not.toContainEqual(['visibility'])
  })

  it('classifies at.functions.metadata: knownValues→tags, const skipped, updatedAt→date', () => {
    const plan = compileExtractionPlan(FUNCTIONS_LEXICON)!
    expect(plan.indexable).toBe(true)
    expect(plan.title[0]).toEqual(['name'])
    expect(plan.body).toContainEqual(['description'])
    expect(plan.tags).toContainEqual(['mode'])
    expect(plan.createdAt).toContainEqual(['updatedAt'])
    const all = [...plan.title, ...plan.body, ...plan.tags]
    expect(all).not.toContainEqual(['entrypoint']) // const
    expect(all).not.toContainEqual(['code'])       // blob
  })

  it('classifies frontpage: format uri → url, not text', () => {
    const plan = compileExtractionPlan(FRONTPAGE_LEXICON)!
    expect(plan.title[0]).toEqual(['title'])
    expect(plan.url).toEqual([['url']])
    expect(plan.body).toEqual([])
  })

  it('descends into arrays of objects with a * segment', () => {
    const plan = compileExtractionPlan(LINKBOARD_LEXICON)!
    expect(plan.title[0]).toEqual(['name'])
    expect(plan.body).toContainEqual(['links', '*', 'text'])
    expect(plan.url).toContainEqual(['links', '*', 'url'])
  })

  it('detects geo pairs, language format, machine formats, and string-array tags', () => {
    const plan = compileExtractionPlan(PLACE_LEXICON)!
    expect(plan.geo).toEqual({
      lat: ['location', 'lat'],
      lon: ['location', 'lon'],
      geohash: ['location', 'geohash'],
    })
    expect(plan.tags).toContainEqual(['tags'])
    expect(plan.langs).toEqual([['langs']])
    const all = [...plan.title, ...plan.body]
    expect(all).not.toContainEqual(['author'])              // format: did
    expect(all).not.toContainEqual(['location', 'geohash']) // never-text name
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @atsearch/common run test -- plan.test`
Expected: FAIL — `Cannot find module '../lexicon/plan'`

- [ ] **Step 4: Create `packages/common/src/text.ts`**

Move `stripMarkdown` verbatim from `normalize.ts` (delete it there; add `import { stripMarkdown } from './text.js'` at the top of `normalize.ts`):

```ts
/**
 * Strip the most common Markdown syntax so tokenisation works on prose,
 * not on `##`, `**`, `[]()`, etc.
 */
export function stripMarkdown(md: string): string {
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
```

- [ ] **Step 5: Create `packages/common/src/lexicon/plan.ts`**

```ts
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
```

- [ ] **Step 6: Export from `packages/common/src/index.ts`**

```ts
export * from './types.js'
export * from './descriptor.js'
export * from './signing.js'
export * from './verify.js'
export * from './normalize.js'
export * from './text.js'
export * from './lexicon/plan.js'
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @atsearch/common run test -- plan.test`
Expected: PASS (8 tests). Then run the whole suite to catch the `stripMarkdown` move: `pnpm --filter @atsearch/common run test` — all green. Also `pnpm --filter @atsearch/common run build` — no TS errors.

- [ ] **Step 8: Commit**

```bash
git add packages/common/src
git commit -m "feat(common): compileExtractionPlan — schema-driven field classification"
```

---

### Task 2: `executeExtractionPlan`

**Files:**
- Modify: `packages/common/src/lexicon/plan.ts` (append)
- Modify: `packages/common/src/types.ts` (add `langs?: string[]` to `IndexedRecord`)
- Modify: `packages/common/src/descriptor.ts` (emit `lang:` keys in `deriveDescriptors`)
- Test: `packages/common/src/__tests__/plan.test.ts` (append)

**Interfaces:**
- Consumes: `ExtractionPlan`, `compileExtractionPlan` (Task 1); `IndexedRecord`, `stripMarkdown`.
- Produces: `executeExtractionPlan(plan: ExtractionPlan, did: string, rkey: string, record: Record<string, unknown>): IndexedRecord | null`; `IndexedRecord.langs?: string[]`; `deriveDescriptors` now emits `lang:xx` keys when `record.langs` present.

- [ ] **Step 1: Write the failing tests** (append to `plan.test.ts`)

```ts
import { executeExtractionPlan } from '../lexicon/plan'
import { deriveDescriptors } from '../descriptor'

describe('executeExtractionPlan', () => {
  const did = 'did:plc:abc123'

  it('extracts a full IndexedRecord from at.functions.metadata', () => {
    const plan = compileExtractionPlan(FUNCTIONS_LEXICON)!
    const rec = executeExtractionPlan(plan, did, 'rkey1', {
      name: 'echo',
      version: '1.0.0',
      description: 'Echoes **input** back',
      mode: 'pure-v1',
      entrypoint: 'run',
      updatedAt: '2026-07-01T00:00:00.000Z',
    })!
    expect(rec.$type).toBe('at.functions.metadata')
    expect(rec.title).toBe('echo')
    expect(rec.description).toContain('Echoes input back') // markdown stripped
    expect(rec.tags).toContain('pure-v1')
    expect(rec.createdAt).toBe('2026-07-01T00:00:00.000Z')
    expect(rec.author).toEqual({ did })
  })

  it('maps over arrays with * and picks http urls', () => {
    const plan = compileExtractionPlan(LINKBOARD_LEXICON)!
    const rec = executeExtractionPlan(plan, did, 'self', {
      name: 'My Links',
      links: [
        { url: 'at://did:plc:x/foo/bar', text: 'not this url' },
        { url: 'https://example.com', text: 'My homepage' },
      ],
    })!
    expect(rec.title).toBe('My Links')
    expect(rec.description).toContain('not this url')
    expect(rec.description).toContain('My homepage')
    expect(rec.url).toBe('https://example.com')
  })

  it('extracts geo and langs; deriveDescriptors emits geo + lang keys', () => {
    const plan = compileExtractionPlan(PLACE_LEXICON)!
    const rec = executeExtractionPlan(plan, did, 'r1', {
      title: 'Community Fridge',
      tags: ['Food'],
      langs: 'en-US',
      location: { lat: 49.28, lon: -123.12, geohash: 'c2b2n' },
      createdAt: '2026-01-01T00:00:00.000Z',
    })!
    expect(rec.location).toEqual({ lat: 49.28, lon: -123.12, geohash: 'c2b2n' })
    expect(rec.langs).toEqual(['en'])
    expect(rec.tags).toEqual(['food'])
    const keys = deriveDescriptors(rec)
    expect(keys).toContain('geo:c2')
    expect(keys).toContain('lang:en')
  })

  it('returns null when the record has no resolvable text', () => {
    const plan = compileExtractionPlan(WHTWND_LEXICON)!
    expect(executeExtractionPlan(plan, did, 'r1', { isDraft: true })).toBeNull()
  })

  it('falls back: title from body slice, createdAt to now, url to atproto browser', () => {
    const plan = compileExtractionPlan(WHTWND_LEXICON)!
    const rec = executeExtractionPlan(plan, did, 'r9', { content: 'Hello world, this is a post' })!
    expect(rec.title).toBe('Hello world, this is a post')
    expect(Number.isFinite(Date.parse(rec.createdAt))).toBe(true)
    expect(rec.url).toContain('https://atproto.com/at/')
    expect(rec.url).toContain(encodeURIComponent(`at://${did}/com.whtwnd.blog.entry/r9`))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @atsearch/common run test -- plan.test`
Expected: FAIL — `executeExtractionPlan` is not exported.

- [ ] **Step 3: Add `langs` to `IndexedRecord`** in `packages/common/src/types.ts`

```ts
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
```

- [ ] **Step 4: Emit `lang:` keys** in `deriveDescriptors` (`packages/common/src/descriptor.ts`) — add after the geohash block, before `return`:

```ts
  if (record.langs) {
    for (const lang of record.langs) {
      const code = lang.toLowerCase().slice(0, 2)
      if (code) keys.add(`lang:${code}`)
    }
  }
```

- [ ] **Step 5: Implement `executeExtractionPlan`** (append to `packages/common/src/lexicon/plan.ts`)

```ts
import type { IndexedRecord } from '../types.js'
import { stripMarkdown } from '../text.js'
```
(put these imports at the top of the file), then:

```ts
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @atsearch/common run test`
Expected: PASS, whole suite green. `pnpm --filter @atsearch/common run build` clean.

- [ ] **Step 7: Commit**

```bash
git add packages/common/src
git commit -m "feat(common): executeExtractionPlan + langs on IndexedRecord"
```

---

### Task 3: Normalization ladder — plan tier in `normalizeRecord` + `hasAdapter`

**Files:**
- Modify: `packages/common/src/normalize.ts`
- Test: `packages/common/src/__tests__/normalize-ladder.test.ts` (create)

**Interfaces:**
- Consumes: `ExtractionPlan`, `executeExtractionPlan` from `./lexicon/plan.js`.
- Produces: `normalizeRecord(did, collection, rkey, raw, plan?: ExtractionPlan): IndexedRecord | null` (4th arg optional — all existing callers keep working); `hasAdapter(collection: string): boolean`; `adapterNsids(): string[]`. Tasks 5–6 and 8 consume these via `@atsearch/common`.

- [ ] **Step 1: Write the failing tests**

`packages/common/src/__tests__/normalize-ladder.test.ts`:

```ts
import { normalizeRecord, hasAdapter } from '../normalize'
import { compileExtractionPlan } from '../lexicon/plan'
import { FUNCTIONS_LEXICON, WHTWND_LEXICON } from './fixtures/lexicons'

const did = 'did:plc:abc123'

describe('normalization ladder', () => {
  it('hasAdapter reflects the ADAPTERS map', () => {
    expect(hasAdapter('app.bsky.feed.post')).toBe(true)
    expect(hasAdapter('xyz.unknown.thing')).toBe(false)
  })

  it('tier 1: adapter wins over plan for known lexicons', () => {
    const plan = compileExtractionPlan(FUNCTIONS_LEXICON)!
    const rec = normalizeRecord(did, 'at.functions.metadata', 'r1',
      { name: 'echo', version: '2.0.0' }, plan)!
    // The hand adapter formats "name vVersion"; the plan tier would give bare "echo"
    expect(rec.title).toBe('echo v2.0.0')
  })

  it('tier 2: plan wins over heuristics for unknown lexicons', () => {
    const plan = compileExtractionPlan(WHTWND_LEXICON)!
    // Pretend whtwnd had no adapter by using a different collection name
    const renamed = { ...plan, nsid: 'com.unknownblog.entry' }
    const rec = normalizeRecord(did, 'com.unknownblog.entry', 'r1',
      { title: 'Post', content: 'Body text here', theme: 'github-light' }, renamed)!
    expect(rec.$type).toBe('com.unknownblog.entry')
    expect(rec.title).toBe('Post')
    expect(rec.description).toBe('Body text here')
  })

  it('tier 3: falls back to heuristics when plan resolves nothing', () => {
    const plan = compileExtractionPlan(WHTWND_LEXICON)!
    const renamed = { ...plan, nsid: 'com.unknownblog.entry' }
    // Record has none of the plan's fields but has a heuristic-probeable one
    const rec = normalizeRecord(did, 'com.unknownblog.entry', 'r1',
      { summary: 'only a summary field' }, renamed)!
    expect(rec.description).toBe('only a summary field')
  })

  it('without a plan, behavior is unchanged (generic heuristics)', () => {
    const rec = normalizeRecord(did, 'xyz.unknown.thing', 'r1', { title: 'Hi' })!
    expect(rec.title).toBe('Hi')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @atsearch/common run test -- normalize-ladder`
Expected: FAIL — `hasAdapter` not exported.

- [ ] **Step 3: Implement in `normalize.ts`**

Add imports at top:

```ts
import { executeExtractionPlan } from './lexicon/plan.js'
import type { ExtractionPlan } from './lexicon/plan.js'
```

Replace `normalizeRecord` with:

```ts
/**
 * Normalise a raw AT Proto record into the IndexedRecord shape.
 * Three-tier ladder: known adapter → compiled extraction plan → heuristics.
 * Returns null only if the record has no extractable text at all.
 */
export function normalizeRecord(
  did: string,
  collection: string,
  rkey: string,
  raw: unknown,
  plan?: ExtractionPlan,
): IndexedRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  const adapter = ADAPTERS[collection]
  if (adapter) return adapter(did, rkey, r)

  if (plan?.indexable) {
    const fromPlan = executeExtractionPlan(plan, did, rkey, r)
    if (fromPlan) return fromPlan
  }

  return normalizeGeneric(did, collection, rkey, r)
}

/** True when a hand-written adapter exists for this collection. */
export function hasAdapter(collection: string): boolean {
  return collection in ADAPTERS
}

/** NSIDs covered by hand-written adapters (tier 1). */
export function adapterNsids(): string[] {
  return Object.keys(ADAPTERS)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @atsearch/common run test` and `pnpm --filter @atsearch/common run build`
Expected: all PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/common/src
git commit -m "feat(common): three-tier normalization ladder (adapter → plan → heuristic)"
```

---

### Task 4: Indexer test infra + `lexicons` table

**Files:**
- Create: `packages/indexer/jest.config.js`
- Modify: `packages/indexer/package.json` (test script + devDeps)
- Modify: `packages/indexer/src/db.ts` (lexicons table + helpers)
- Test: `packages/indexer/src/__tests__/db.test.ts` (create)

**Interfaces:**
- Produces: `interface LexiconRow { nsid: string; status: 'plan' | 'no-text' | 'unresolvable'; doc_json: string | null; plan_json: string | null; description: string | null; resolved_at: string | null; next_retry_at: string | null; attempts: number }`; `upsertLexicon(db, row: LexiconRow): void`; `getLexicon(db, nsid): LexiconRow | undefined`; `listLexicons(db): LexiconRow[]`. Tasks 5 and 8 consume these.

- [ ] **Step 1: Add jest to the indexer**

`packages/indexer/jest.config.js` — copy of common's config verbatim:

```js
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'bundler',
        },
      },
    ],
  },
}
```

In `packages/indexer/package.json` add to `"scripts"`:

```json
"test": "NODE_OPTIONS=--experimental-vm-modules jest --testPathPattern=src/__tests__"
```

and to `"devDependencies"`:

```json
"@types/jest": "^29.5.11",
"jest": "^29.7.0",
"ts-jest": "^29.1.2"
```

Then run: `pnpm install`

- [ ] **Step 2: Write the failing tests**

`packages/indexer/src/__tests__/db.test.ts`:

```ts
import { openDb, upsertLexicon, getLexicon, listLexicons } from '../db'
import type { LexiconRow } from '../db'

const row = (overrides: Partial<LexiconRow> = {}): LexiconRow => ({
  nsid: 'com.example.foo',
  status: 'plan',
  doc_json: '{"lexicon":1}',
  plan_json: '{"nsid":"com.example.foo","indexable":true}',
  description: 'A foo record',
  resolved_at: '2026-08-03T00:00:00.000Z',
  next_retry_at: null,
  attempts: 0,
  ...overrides,
})

describe('lexicons table', () => {
  it('round-trips a row', () => {
    const db = openDb(':memory:')
    upsertLexicon(db, row())
    const got = getLexicon(db, 'com.example.foo')
    expect(got).toEqual(row())
  })

  it('upsert replaces on conflict', () => {
    const db = openDb(':memory:')
    upsertLexicon(db, row({ status: 'unresolvable', attempts: 2 }))
    upsertLexicon(db, row({ status: 'plan', attempts: 0 }))
    expect(getLexicon(db, 'com.example.foo')!.status).toBe('plan')
    expect(getLexicon(db, 'com.example.foo')!.attempts).toBe(0)
  })

  it('missing nsid returns undefined; listLexicons lists all', () => {
    const db = openDb(':memory:')
    expect(getLexicon(db, 'nope')).toBeUndefined()
    upsertLexicon(db, row())
    upsertLexicon(db, row({ nsid: 'com.example.bar', status: 'no-text' }))
    expect(listLexicons(db).map((r) => r.nsid).sort()).toEqual([
      'com.example.bar',
      'com.example.foo',
    ])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @atsearch/common run build && pnpm --filter @atsearch/indexer run test`
Expected: FAIL — `upsertLexicon` is not exported.

- [ ] **Step 4: Implement in `db.ts`**

Add to the `db.exec(...)` schema block in `openDb`:

```sql
    CREATE TABLE IF NOT EXISTS lexicons (
      nsid TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      doc_json TEXT,
      plan_json TEXT,
      description TEXT,
      resolved_at TEXT,
      next_retry_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0
    );
```

Append to `db.ts`:

```ts
export interface LexiconRow {
  nsid: string
  status: 'plan' | 'no-text' | 'unresolvable'
  doc_json: string | null
  plan_json: string | null
  description: string | null
  resolved_at: string | null
  next_retry_at: string | null
  attempts: number
}

export function upsertLexicon(db: Database.Database, row: LexiconRow): void {
  db.prepare(`
    INSERT INTO lexicons (nsid, status, doc_json, plan_json, description, resolved_at, next_retry_at, attempts)
    VALUES (@nsid, @status, @doc_json, @plan_json, @description, @resolved_at, @next_retry_at, @attempts)
    ON CONFLICT(nsid) DO UPDATE SET
      status = excluded.status,
      doc_json = excluded.doc_json,
      plan_json = excluded.plan_json,
      description = excluded.description,
      resolved_at = excluded.resolved_at,
      next_retry_at = excluded.next_retry_at,
      attempts = excluded.attempts
  `).run(row)
}

export function getLexicon(db: Database.Database, nsid: string): LexiconRow | undefined {
  return db.prepare('SELECT * FROM lexicons WHERE nsid = ?').get(nsid) as LexiconRow | undefined
}

export function listLexicons(db: Database.Database): LexiconRow[] {
  return db.prepare('SELECT * FROM lexicons ORDER BY nsid').all() as LexiconRow[]
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @atsearch/indexer run test`
Expected: PASS (3 tests). Also `pnpm --filter @atsearch/indexer run lint` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/indexer
git commit -m "feat(indexer): jest infra + lexicons table"
```

---

### Task 5: `LexiconRegistry` with triage decisions

**Files:**
- Create: `packages/indexer/src/lexiconRegistry.ts`
- Test: `packages/indexer/src/__tests__/lexiconRegistry.test.ts`
- Modify: `packages/indexer/package.json` (add `@atproto/lexicon-resolver`)

**Interfaces:**
- Consumes: `compileExtractionPlan`, `hasAdapter`, `ExtractionPlan` from `@atsearch/common`; `getLexicon`, `upsertLexicon` from `./db.js` (Task 4).
- Produces:
  - `type TriageDecision = { action: 'ingest'; plan?: ExtractionPlan } | { action: 'drop'; reason: 'no-text' | 'denied' | 'not-allowlisted' | 'unresolvable' | 'pending' }`
  - `class LexiconRegistry { constructor(db: Database.Database, opts: LexiconRegistryOptions); decide(nsid: string): TriageDecision; resolveNow(nsid: string): Promise<void> }`
  - `interface LexiconRegistryOptions { resolveLexiconDoc: (nsid: string) => Promise<{ doc: unknown } | null>; allowlist?: string[]; denylist?: string[]; now?: () => number; onResolved?: (nsid: string, status: string) => void }`
  - `defaultResolveLexiconDoc(nsid: string): Promise<{ doc: unknown } | null>` (wraps `@atproto/lexicon-resolver`)
  - `nextRetryDelayMs(attempts: number): number`, `nsidMatches(patterns: string[], nsid: string): boolean`
  Task 6 consumes `LexiconRegistry`/`defaultResolveLexiconDoc`; Task 8 reads the rows it writes.

- [ ] **Step 1: Add the resolver dependency**

Run: `pnpm --filter @atsearch/indexer add @atproto/lexicon-resolver`

- [ ] **Step 2: Write the failing tests**

`packages/indexer/src/__tests__/lexiconRegistry.test.ts`:

```ts
import { openDb, getLexicon } from '../db'
import { LexiconRegistry, nextRetryDelayMs, nsidMatches } from '../lexiconRegistry'

const FOO_LEXICON = {
  lexicon: 1,
  id: 'com.example.foo',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      description: 'A foo',
      record: { type: 'object', properties: { title: { type: 'string', maxLength: 100 } } },
    },
  },
}

const LIKE_LEXICON = {
  lexicon: 1,
  id: 'xyz.app.like',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        properties: {
          subject: { type: 'string', format: 'at-uri' },
          createdAt: { type: 'string', format: 'datetime' },
        },
      },
    },
  },
}

describe('nextRetryDelayMs / nsidMatches', () => {
  it('backs off 1h, 6h, 24h, then 7d', () => {
    expect(nextRetryDelayMs(1)).toBe(3_600_000)
    expect(nextRetryDelayMs(2)).toBe(21_600_000)
    expect(nextRetryDelayMs(3)).toBe(86_400_000)
    expect(nextRetryDelayMs(4)).toBe(604_800_000)
    expect(nextRetryDelayMs(99)).toBe(604_800_000)
  })

  it('matches exact nsids and prefix wildcards', () => {
    expect(nsidMatches(['com.example.foo'], 'com.example.foo')).toBe(true)
    expect(nsidMatches(['com.example.*'], 'com.example.foo')).toBe(true)
    expect(nsidMatches(['com.example.*'], 'org.other.foo')).toBe(false)
    expect(nsidMatches([], 'com.example.foo')).toBe(false)
  })
})

describe('LexiconRegistry.decide', () => {
  const mkRegistry = (
    docs: Record<string, unknown>,
    opts: { allowlist?: string[]; denylist?: string[]; now?: () => number; fail?: boolean } = {},
  ) => {
    const db = openDb(':memory:')
    const calls: string[] = []
    const registry = new LexiconRegistry(db, {
      resolveLexiconDoc: async (nsid) => {
        calls.push(nsid)
        if (opts.fail) throw new Error('dns boom')
        return nsid in docs ? { doc: docs[nsid] } : null
      },
      allowlist: opts.allowlist,
      denylist: opts.denylist,
      now: opts.now,
    })
    return { db, registry, calls }
  }

  it('adapters always ingest without a plan', () => {
    const { registry, calls } = mkRegistry({})
    expect(registry.decide('app.bsky.feed.post')).toEqual({ action: 'ingest' })
    expect(calls).toEqual([]) // no resolution scheduled for adapter lexicons
  })

  it('denylist wins over everything', () => {
    const { registry } = mkRegistry({}, { denylist: ['app.bsky.*'] })
    expect(registry.decide('app.bsky.feed.post')).toEqual({ action: 'drop', reason: 'denied' })
  })

  it('unknown collection: drop pending, then ingest with plan after resolution', async () => {
    const { registry } = mkRegistry({ 'com.example.foo': FOO_LEXICON })
    expect(registry.decide('com.example.foo')).toEqual({ action: 'drop', reason: 'pending' })
    await registry.resolveNow('com.example.foo')
    const decision = registry.decide('com.example.foo')
    expect(decision.action).toBe('ingest')
    expect((decision as { plan?: { nsid: string } }).plan?.nsid).toBe('com.example.foo')
  })

  it('text-free lexicons resolve to no-text and drop', async () => {
    const { registry } = mkRegistry({ 'xyz.app.like': LIKE_LEXICON })
    registry.decide('xyz.app.like')
    await registry.resolveNow('xyz.app.like')
    expect(registry.decide('xyz.app.like')).toEqual({ action: 'drop', reason: 'no-text' })
  })

  it('failed resolution → unresolvable with retry backoff recorded', async () => {
    const { db, registry } = mkRegistry({}, { fail: true, now: () => 1_000_000 })
    // Call resolveNow directly (a decide() first would also schedule a background
    // resolution and race the attempts counter).
    await registry.resolveNow('com.example.gone')
    expect(registry.decide('com.example.gone')).toEqual({ action: 'drop', reason: 'unresolvable' })
    const row = getLexicon(db, 'com.example.gone')!
    expect(row.attempts).toBe(1)
    expect(Date.parse(row.next_retry_at!)).toBe(1_000_000 + 3_600_000)
  })

  it('allowlisted collections ingest generically while pending/unresolvable', async () => {
    const { registry } = mkRegistry({}, { fail: true, allowlist: ['com.example.*'] })
    expect(registry.decide('com.example.legacy')).toEqual({ action: 'ingest' })
    await registry.resolveNow('com.example.legacy')
    expect(registry.decide('com.example.legacy')).toEqual({ action: 'ingest' })
    expect(registry.decide('org.other.thing')).toEqual({ action: 'drop', reason: 'not-allowlisted' })
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @atsearch/indexer run test -- lexiconRegistry`
Expected: FAIL — `Cannot find module '../lexiconRegistry'`

- [ ] **Step 4: Implement `packages/indexer/src/lexiconRegistry.ts`**

```ts
import type Database from 'better-sqlite3'
import { resolveLexicon } from '@atproto/lexicon-resolver'
import { compileExtractionPlan, hasAdapter } from '@atsearch/common'
import type { ExtractionPlan } from '@atsearch/common'
import { getLexicon, upsertLexicon } from './db.js'

export type TriageDecision =
  | { action: 'ingest'; plan?: ExtractionPlan }
  | { action: 'drop'; reason: 'no-text' | 'denied' | 'not-allowlisted' | 'unresolvable' | 'pending' }

export interface LexiconRegistryOptions {
  /** Injected for tests; production uses defaultResolveLexiconDoc. null = not found. */
  resolveLexiconDoc: (nsid: string) => Promise<{ doc: unknown } | null>
  /** Exact NSIDs or `prefix.*`. When set, only matching collections are ingested. */
  allowlist?: string[]
  /** Exact NSIDs or `prefix.*`. Always dropped. Wins over allowlist and adapters. */
  denylist?: string[]
  now?: () => number
  onResolved?: (nsid: string, status: string) => void
}

const RETRY_DELAYS_MS = [3_600_000, 21_600_000, 86_400_000] // 1h, 6h, 24h
const RETRY_MAX_MS = 604_800_000 // 7d
const RESOLVED_TTL_MS = 604_800_000 // 7d

export function nextRetryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[attempts - 1] ?? RETRY_MAX_MS
}

/** Same semantics as the firehose collection filters: exact NSID or `prefix.*`. */
export function nsidMatches(patterns: string[], nsid: string): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('.*')) {
      if (nsid.startsWith(pattern.slice(0, -2))) return true
    } else if (pattern === nsid) {
      return true
    }
  }
  return false
}

export async function defaultResolveLexiconDoc(
  nsid: string,
): Promise<{ doc: unknown } | null> {
  try {
    const res = await resolveLexicon(nsid)
    return { doc: res.lexicon }
  } catch {
    return null
  }
}

function extractDescription(doc: unknown): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const desc = (doc as any)?.defs?.main?.description
  return typeof desc === 'string' ? desc : null
}

/**
 * SQLite-backed registry mapping collection NSIDs to triage decisions.
 * decide() is synchronous (hot path: one map hit or one PK lookup);
 * unknown NSIDs schedule a background resolution and drop until it lands.
 */
export class LexiconRegistry {
  /** Terminal decisions only (plan / no-text / denied / not-allowlisted / adapter). */
  private cache = new Map<string, TriageDecision>()
  private inFlight = new Set<string>()

  constructor(
    private db: Database.Database,
    private opts: LexiconRegistryOptions,
  ) {}

  decide(nsid: string): TriageDecision {
    const cached = this.cache.get(nsid)
    if (cached) return cached

    if (this.opts.denylist?.length && nsidMatches(this.opts.denylist, nsid)) {
      return this.remember(nsid, { action: 'drop', reason: 'denied' })
    }
    if (hasAdapter(nsid)) {
      return this.remember(nsid, { action: 'ingest' })
    }
    const allowlisted = this.opts.allowlist?.length
      ? nsidMatches(this.opts.allowlist, nsid)
      : undefined
    if (allowlisted === false) {
      return this.remember(nsid, { action: 'drop', reason: 'not-allowlisted' })
    }

    const now = this.opts.now?.() ?? Date.now()
    const row = getLexicon(this.db, nsid)
    if (row?.status === 'plan' && row.plan_json) {
      if (row.resolved_at && now - Date.parse(row.resolved_at) > RESOLVED_TTL_MS) {
        this.scheduleResolve(nsid) // stale: refresh in background, keep serving old plan
      }
      return this.remember(nsid, {
        action: 'ingest',
        plan: JSON.parse(row.plan_json) as ExtractionPlan,
      })
    }
    if (row?.status === 'no-text') {
      return this.remember(nsid, { action: 'drop', reason: 'no-text' })
    }
    if (row?.status === 'unresolvable') {
      if (row.next_retry_at && now >= Date.parse(row.next_retry_at)) {
        this.scheduleResolve(nsid)
      }
      return allowlisted
        ? { action: 'ingest' }
        : { action: 'drop', reason: 'unresolvable' }
    }

    this.scheduleResolve(nsid)
    return allowlisted ? { action: 'ingest' } : { action: 'drop', reason: 'pending' }
  }

  /** Run one resolution to completion. Exposed for tests and the UFOs pre-warm. */
  async resolveNow(nsid: string): Promise<void> {
    const now = this.opts.now?.() ?? Date.now()
    const prev = getLexicon(this.db, nsid)

    let resolved: { doc: unknown } | null = null
    try {
      resolved = await this.opts.resolveLexiconDoc(nsid)
    } catch {
      resolved = null
    }

    if (!resolved) {
      const attempts = (prev?.attempts ?? 0) + 1
      upsertLexicon(this.db, {
        nsid,
        status: 'unresolvable',
        doc_json: null,
        plan_json: null,
        description: null,
        resolved_at: null,
        next_retry_at: new Date(now + nextRetryDelayMs(attempts)).toISOString(),
        attempts,
      })
      this.cache.delete(nsid)
      this.opts.onResolved?.(nsid, 'unresolvable')
      return
    }

    const plan = compileExtractionPlan(resolved.doc)
    const status: 'plan' | 'no-text' = plan?.indexable ? 'plan' : 'no-text'
    upsertLexicon(this.db, {
      nsid,
      status,
      doc_json: JSON.stringify(resolved.doc),
      plan_json: plan?.indexable ? JSON.stringify(plan) : null,
      description: extractDescription(resolved.doc),
      resolved_at: new Date(now).toISOString(),
      next_retry_at: null,
      attempts: 0,
    })
    this.cache.delete(nsid)
    this.opts.onResolved?.(nsid, status)
  }

  private remember(nsid: string, decision: TriageDecision): TriageDecision {
    this.cache.set(nsid, decision)
    return decision
  }

  private scheduleResolve(nsid: string): void {
    if (this.inFlight.has(nsid)) return
    this.inFlight.add(nsid)
    void this.resolveNow(nsid).finally(() => this.inFlight.delete(nsid))
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @atsearch/indexer run test`
Expected: PASS (all suites). Note: `decide()` on an unknown NSID also fires `scheduleResolve`, so `resolveNow` in tests may run a second time concurrently — both write the same terminal row, so assertions hold; if the `attempts` assertion flakes, await a microtask (`await Promise.resolve()`) before `resolveNow`. `pnpm --filter @atsearch/indexer run lint` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/indexer
git commit -m "feat(indexer): LexiconRegistry — runtime lexicon resolution + triage"
```

---

### Task 6: Wire triage into ingestion (both consumers) + `ATSEARCH_LEXICON_MODE`

**Files:**
- Modify: `packages/indexer/src/ingest.ts`
- Modify: `packages/indexer/src/firehose.ts`
- Modify: `packages/indexer/src/firehoseRepos.ts`
- Modify: `packages/indexer/src/index.ts`

**Interfaces:**
- Consumes: `LexiconRegistry`, `defaultResolveLexiconDoc` (Task 5); `normalizeRecord(did, collection, rkey, raw, plan?)` (Task 3).
- Produces: `ingestRecord(db, uri, cid, rawRecord, plan?: ExtractionPlan): IngestResult | null`; both consumer option interfaces gain `registry?: LexiconRegistry`; env vars `ATSEARCH_LEXICON_MODE` (`curated` default | `auto`), `ATSEARCH_LEXICON_ALLOWLIST`, `ATSEARCH_LEXICON_DENYLIST`.

No unit tests in this task (thin wiring over tested parts); verified by lint/build and the manual smoke run in Task 10.

- [ ] **Step 1: Thread the plan through `ingest.ts`**

```ts
import type { ExtractionPlan } from '@atsearch/common'
```

Change the signature and the normalize call:

```ts
export function ingestRecord(
  db: Database.Database,
  uri: string,
  cid: string,
  rawRecord: unknown,
  plan?: ExtractionPlan,
): IngestResult | null {
  const parts = uri.replace('at://', '').split('/')
  if (parts.length !== 3) return null
  const [did, collection, rkey] = parts

  const normalized = normalizeRecord(did, collection, rkey, rawRecord, plan)
  if (!normalized) return null
  // … rest unchanged
```

- [ ] **Step 2: Triage in the Jetstream consumer (`firehose.ts`)**

Add to imports: `import type { LexiconRegistry } from './lexiconRegistry.js'`.
Add to `FirehoseOptions`:

```ts
  /** When set, collections are triaged (schema-driven) before ingest. */
  registry?: LexiconRegistry
```

In the `ws.on('message', …)` handler, replace the ingest call block:

```ts
        if (!allCollections && !collections.includes(commit.collection)) return

        const decision = opts.registry?.decide(commit.collection) ?? { action: 'ingest' as const }
        if (decision.action !== 'ingest') return

        const uri = `at://${event.did}/${commit.collection}/${commit.rkey}`
        const result = ingestRecord(db, uri, commit.cid, commit.record, decision.plan)
```

Also update the stale `@deprecated` header comment (the entrypoint *does* use this in `jetstream` mode) — replace the first two lines of the file's doc comment with:

```ts
/**
 * Jetstream consumer (ATSEARCH_MODE=jetstream).
 *
```

- [ ] **Step 3: Triage in the relay consumer (`firehoseRepos.ts`)**

Add to imports: `import type { LexiconRegistry } from './lexiconRegistry.js'`.
Add to `RepoFirehoseOptions`:

```ts
  /** When set, collections are triaged (schema-driven) before ingest. */
  registry?: LexiconRegistry
```

Change `ingestOne`:

```ts
  const ingestOne = async (did: string, collection: string, rkey: string, cidStr: string, record: unknown) => {
    const decision = opts.registry?.decide(collection) ?? { action: 'ingest' as const }
    if (decision.action !== 'ingest') return
    const uri = `at://${did}/${collection}/${rkey}`
    const result = ingestRecord(db, uri, cidStr, record, decision.plan)
    if (result) {
      await Promise.all(result.descriptors.map((key) => advertiseDescriptor(dhtNode, key)))
      opts.onIngested?.(uri, cidStr)
    }
  }
```

- [ ] **Step 4: Registry construction + mode flag in `index.ts`**

Add imports:

```ts
import { LexiconRegistry, defaultResolveLexiconDoc } from './lexiconRegistry.js'
```

After `const MODE = …` add:

```ts
/**
 * Lexicon handling:
 *   curated — current behavior: fixed collection lists, no runtime schema resolution
 *   auto    — resolve lexicon schemas at runtime, triage collections, subscribe wide
 */
const LEXICON_MODE = process.env.ATSEARCH_LEXICON_MODE ?? 'curated'

const parseList = (v: string | undefined): string[] | undefined => {
  const items = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return items.length ? items : undefined
}
```

Inside `main()`, after the DB is opened:

```ts
  const registry =
    LEXICON_MODE === 'auto'
      ? new LexiconRegistry(db, {
          resolveLexiconDoc: defaultResolveLexiconDoc,
          allowlist: parseList(process.env.ATSEARCH_LEXICON_ALLOWLIST),
          denylist: parseList(process.env.ATSEARCH_LEXICON_DENYLIST),
          onResolved: (nsid, status) => console.log(`[lexicon] ${nsid} → ${status}`),
        })
      : undefined
  if (registry) console.log('Lexicon mode: auto (runtime schema resolution + triage)')
```

In the `jetstream` branch, widen the default subscription when auto and pass the registry:

```ts
    startFirehose(db, dhtNode, {
      jetstreamUrl: JETSTREAM_URL,
      collections: collections.length ? collections : registry ? ['*'] : undefined,
      registry,
      onStatus: (msg) => console.log(`[jetstream] ${msg}`),
      onIngested: (uri, cid) => console.log(`Indexed: ${uri} @ ${cid}`),
    })
```

In the `firehose` branch, pass `registry,` into the `startRepoFirehose` options the same way.

- [ ] **Step 5: Verify build + existing tests**

Run: `pnpm --filter @atsearch/common run build && pnpm --filter @atsearch/indexer run lint && pnpm --filter @atsearch/indexer run test && pnpm --filter @atsearch/indexer run build`
Expected: all clean/green.

- [ ] **Step 6: Commit**

```bash
git add packages/indexer
git commit -m "feat(indexer): collection triage in both consumers + ATSEARCH_LEXICON_MODE"
```

---

### Task 7: Composable `type:` filter in queries

**Files:**
- Modify: `packages/common/src/descriptor.ts`
- Modify: `packages/query-node/src/services/search/SearchService.ts`
- Test: `packages/common/src/__tests__/descriptor.test.ts` (append)

**Interfaces:**
- Consumes: `tokenize` (existing).
- Produces: `interface ParsedQuery { typeFilter?: string; text: string }`; `parseQuery(query: string): ParsedQuery`; `descriptorToQueryKeys` now returns type key + token/tag keys when both are present. The query-node uses `parseQuery` to filter candidates by collection.

- [ ] **Step 1: Write the failing tests** (append to `descriptor.test.ts`)

```ts
import { parseQuery } from '../descriptor'

describe('parseQuery', () => {
  it('plain text has no filter', () => {
    expect(parseQuery('community fridge')).toEqual({ text: 'community fridge' })
  })

  it('bare type: filter', () => {
    expect(parseQuery('type:at.functions.metadata')).toEqual({
      typeFilter: 'at.functions.metadata',
      text: '',
    })
  })

  it('type: combined with free text, anywhere in the query', () => {
    expect(parseQuery('resize image type:at.functions.metadata')).toEqual({
      typeFilter: 'at.functions.metadata',
      text: 'resize image',
    })
    expect(parseQuery('collection:com.whtwnd.blog.entry svelte tips')).toEqual({
      typeFilter: 'com.whtwnd.blog.entry',
      text: 'svelte tips',
    })
  })
})

describe('descriptorToQueryKeys with type filter', () => {
  it('bare type: yields only the type key (unchanged behavior)', () => {
    expect(descriptorToQueryKeys('type:at.functions.metadata')).toEqual([
      'type:at.functions.metadata',
    ])
  })

  it('type + text yields type key AND token/tag keys', () => {
    const keys = descriptorToQueryKeys('resize type:at.functions.metadata')
    expect(keys).toContain('type:at.functions.metadata')
    expect(keys).toContain('token:resize')
    expect(keys).toContain('tag:resize')
    expect(keys).not.toContain('token:type')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @atsearch/common run test -- descriptor`
Expected: FAIL — `parseQuery` not exported.

- [ ] **Step 3: Implement in `descriptor.ts`**

Replace `descriptorToQueryKeys` with:

```ts
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
```

- [ ] **Step 4: Run common tests**

Run: `pnpm --filter @atsearch/common run test && pnpm --filter @atsearch/common run build`
Expected: PASS. If any pre-existing `descriptorToQueryKeys` test asserted that a mixed query tokenizes the literal words `type`/nsid segments, update that expectation to the new filtered behavior.

- [ ] **Step 5: Filter candidates in `SearchService.ts`**

Update the import and query parsing at the top of `runSearch`:

```ts
import { descriptorToQueryKeys, parseQuery, tokenize } from '@atsearch/common'
```

```ts
  const { query } = opts
  const indexerUrls = opts.indexerUrls ?? services.env.indexerUrls

  const { typeFilter, text } = parseQuery(query)
  const descriptorKeys = descriptorToQueryKeys(query)
  const queryTokens = tokenize(text)
  const queryTags = queryTokens
```

Then, where results are built, filter by collection when a type filter is combined with text (bare `type:` queries already only fetch `type:` pointers, and this filter is a no-op for them):

```ts
  const candidates = Array.from(candidateMap.values()).filter(
    (c) => !typeFilter || c.ref.uri.includes(`/${typeFilter}/`),
  )

  const results = await Promise.all(
    candidates.map(async (candidate) => {
```

(Adjust the old `Array.from(candidateMap.entries()).map(async ([, candidate]) => …)` accordingly — the map key was unused.)

- [ ] **Step 6: Build query node**

Run: `pnpm --filter @atsearch/query-node run lint && pnpm --filter @atsearch/query-node run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/common/src packages/query-node/src
git commit -m "feat(search): composable type: filter with free text"
```

---

### Task 8: `/lexicons` endpoints (indexer + query node)

**Files:**
- Modify: `packages/indexer/src/server.ts`
- Modify: `packages/query-node/src/server.ts`

**Interfaces:**
- Consumes: `listLexicons` (Task 4); `lexiconMeta`, `hasAdapter` from `@atsearch/common`.
- Produces: indexer `GET /lexicons` → `{ lexicons: Array<{ nsid, status, indexable, label, description? }> }`; query-node `GET /lexicons` merges the same shape across `services.env.indexerUrls`. Task 9's UI tooltip data source.

No unit tests (no HTTP test infra exists in these packages); verified with curl in the steps below.

- [ ] **Step 1: Indexer route** — in `packages/indexer/src/server.ts`, add to imports:

```ts
import { getPointersByDescriptor, getAllDescriptorKeys, listLexicons } from './db.js'
import { lexiconMeta, adapterNsids } from '@atsearch/common'
```

(replacing the existing `./db.js` import line), and add after the `/descriptors` route:

```ts
  // Lexicon registry metadata: which collections this indexer understands and how.
  fastify.get('/lexicons', async () => {
    const rows = listLexicons(config.db)
    const fromRegistry = rows.map((r) => ({
      nsid: r.nsid,
      status: r.status,
      indexable: r.status === 'plan',
      label: lexiconMeta(r.nsid).label,
      ...(r.description ? { description: r.description } : {}),
    }))
    // Adapter-covered lexicons may never hit the registry — include them too.
    const fromAdapters = adapterNsids()
      .filter((nsid) => !rows.some((r) => r.nsid === nsid))
      .map((nsid) => ({
        nsid,
        status: 'adapter',
        indexable: true,
        label: lexiconMeta(nsid).label,
      }))
    return { lexicons: [...fromRegistry, ...fromAdapters].sort((a, b) => a.nsid.localeCompare(b.nsid)) }
  })
```

- [ ] **Step 2: Query-node route** — in `packages/query-node/src/server.ts`, add after the `/interactions` route:

```ts
  /** Merged lexicon metadata from all configured indexers (for UI chips/tooltips). */
  fastify.get('/lexicons', async () => {
    type LexiconInfo = {
      nsid: string
      status: string
      indexable: boolean
      label: string
      description?: string
    }
    const merged = new Map<string, LexiconInfo>()
    await Promise.all(
      services.env.indexerUrls.map(async (base) => {
        try {
          const res = await fetch(`${base}/lexicons`, { signal: AbortSignal.timeout(5_000) })
          if (!res.ok) return
          const data = (await res.json()) as { lexicons?: LexiconInfo[] }
          for (const lex of data.lexicons ?? []) {
            if (!merged.has(lex.nsid)) merged.set(lex.nsid, lex)
          }
        } catch {
          // indexer unreachable — partial results are fine
        }
      }),
    )
    return { lexicons: Array.from(merged.values()).sort((a, b) => a.nsid.localeCompare(b.nsid)) }
  })
```

- [ ] **Step 3: Verify by running the stack**

```bash
pnpm run build
pnpm run seed
pnpm run demo
```

Then in another terminal:

```bash
curl -s localhost:3001/lexicons | head -c 500
curl -s localhost:3002/lexicons | head -c 500
```

Expected: both return `{"lexicons":[…]}` including adapter entries (e.g. `app.bsky.feed.post` with `"status":"adapter"`). Stop the demo afterwards.

- [ ] **Step 4: Commit**

```bash
git add packages/indexer/src/server.ts packages/query-node/src/server.ts
git commit -m "feat(api): GET /lexicons on indexer and query node"
```

---

### Task 9: Demo-client chips for unknown lexicons

**Files:**
- Modify: `packages/demo-client/src/lib/lexicon.ts`
- Modify: `packages/common/src/normalize.ts` (keep `lexiconMeta` mirrors in sync)
- Modify: `packages/demo-client/src/lib/components/ResultItem.svelte` (chip tooltip)

**Interfaces:**
- Consumes: existing `.type-chip--{variant}` CSS classes in `ResultItem.svelte` (post/profile/feed/list/blog/link/function/thing/generic).
- Produces: `lexiconMeta()` in both files returns a stable hashed variant (instead of always `generic`) for unknown NSIDs.

- [ ] **Step 1: Update `packages/demo-client/src/lib/lexicon.ts`** — replace the fallback in `lexiconMeta`:

```ts
/** Existing chip palettes reused for unknown lexicons, chosen by stable hash. */
const FALLBACK_VARIANTS: LexiconMeta['variant'][] = [
  'post', 'profile', 'feed', 'list', 'blog', 'link', 'function', 'thing',
]

function hashVariant(nsid: string): LexiconMeta['variant'] {
  let h = 0
  for (let i = 0; i < nsid.length; i++) h = (h * 31 + nsid.charCodeAt(i)) >>> 0
  return FALLBACK_VARIANTS[h % FALLBACK_VARIANTS.length]
}

/**
 * Return display metadata for a lexicon $type string.
 * Unknown types get the last NSID segment as label and a stable hashed
 * color variant, so every app gets a distinct-ish chip without config.
 */
export function lexiconMeta($type: string): LexiconMeta {
  const known = LEXICON_META[$type]
  if (known) return known
  const segments = $type.split('.')
  const label = segments[segments.length - 1] ?? $type
  return { label, variant: hashVariant($type) }
}
```

- [ ] **Step 2: Mirror the same change in `packages/common/src/normalize.ts`** — replace that file's `lexiconMeta` fallback identically (add the same `FALLBACK_VARIANTS` + `hashVariant` above it; the `variant` union type there already contains all eight values).

- [ ] **Step 3: Chip tooltip** — in `ResultItem.svelte`, both chip renders (currently lines 115 and 140) become:

```svelte
<span class="type-chip type-chip--{meta.variant}" title={record.$type}>{meta.label}</span>
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @atsearch/common run test && pnpm --filter @atsearch/common run build && pnpm --filter @atsearch/demo-client run lint`
Expected: green. Optional visual check: `pnpm run demo`, search `fridge`, hover a chip → tooltip shows the NSID.

- [ ] **Step 5: Commit**

```bash
git add packages/demo-client/src packages/common/src/normalize.ts
git commit -m "feat(client): hashed chip variants + NSID tooltips for unknown lexicons"
```

---

### Task 10: Flip default to auto, document, smoke-test

**Files:**
- Modify: `packages/indexer/src/index.ts` (default `ATSEARCH_LEXICON_MODE` → `auto`)
- Modify: `README.md` (env table + architecture note)
- Modify: `docker-compose.yml` (surface the new env vars, pass-through only)

**Interfaces:** none new.

- [ ] **Step 1: Flip the default** in `packages/indexer/src/index.ts`:

```ts
const LEXICON_MODE = process.env.ATSEARCH_LEXICON_MODE ?? 'auto'
```

- [ ] **Step 2: Document env vars** — in README's **Indexer** env table add:

```markdown
| `ATSEARCH_LEXICON_MODE` | `auto` | `auto`: resolve lexicon schemas at runtime (`_lexicon` DNS → `com.atproto.lexicon.schema`), compile extraction plans, triage collections (text-free ones like likes/follows are dropped). `curated`: fixed collection lists, no resolution. |
| `ATSEARCH_LEXICON_ALLOWLIST` | — | Comma-separated NSIDs or `prefix.*`. When set, only these collections are ingested; schema-less ones fall back to heuristic extraction. |
| `ATSEARCH_LEXICON_DENYLIST` | — | Comma-separated NSIDs or `prefix.*`. Always dropped. |
```

Also update the README **Descriptor derivation** section's intro sentence to mention the three-tier ladder (adapter → compiled plan → heuristic) with one sentence, and remove `Lexicon-driven descriptor derivation (support any AT Proto record type)` from **Future work** (it's built now).

- [ ] **Step 3: docker-compose pass-through** — in the `indexer` service's `environment:` block add:

```yaml
      ATSEARCH_LEXICON_MODE: ${ATSEARCH_LEXICON_MODE:-auto}
      ATSEARCH_LEXICON_ALLOWLIST: ${ATSEARCH_LEXICON_ALLOWLIST:-}
      ATSEARCH_LEXICON_DENYLIST: ${ATSEARCH_LEXICON_DENYLIST:-}
```

- [ ] **Step 4: Full-suite verification**

```bash
pnpm run build
pnpm run test
pnpm --filter @atsearch/indexer run test
```

Expected: all green.

- [ ] **Step 5: Live smoke test (jetstream auto mode, ~2 minutes)**

```bash
ATSEARCH_MODE=jetstream ATSEARCH_LEXICON_MODE=auto \
ATSEARCH_DB_PATH=./data/smoke.db ATSEARCH_HTTP_PORT=3021 ATSEARCH_DHT_PORT=8021 \
  pnpm --filter @atsearch/indexer run dev
```

Watch the logs for ~2 minutes. Expected: `[lexicon] app.bsky.feed.like → no-text` (triage working), `[lexicon] <some-nsid> → plan` for schema-publishing apps, and `Indexed: at://…` lines for text-bearing records. Then `curl -s localhost:3021/lexicons` shows the resolved registry. Ctrl-C and delete `./data/smoke.db*`.

- [ ] **Step 6: Commit**

```bash
git add packages/indexer/src/index.ts README.md docker-compose.yml
git commit -m "feat: default ATSEARCH_LEXICON_MODE=auto + docs"
```

---

## Out of scope for this plan

- **AT Functions lexicon publishing** (separate repo + DNS record the user must create): publish `at.functions.metadata` via `com.atproto.lexicon.schema` and add the `_lexicon` DNS TXT record. Follow-up task in the at-functions repo.
- UFOs pre-warm poller (`ATSEARCH_UFOS_URL`) — the registry's `resolveNow` is designed for it; add later if the drop-while-pending window proves annoying in production.
- DHT multiaddr → HTTP resolution, sharding, rate limiting (pre-existing gaps, spec §9).
