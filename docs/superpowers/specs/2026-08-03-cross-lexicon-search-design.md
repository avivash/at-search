# Cross-Lexicon Search ("Cross-Pollination") — Design

**Date:** 2026-08-03
**Branch:** `wider.search-area`
**Status:** Draft — awaiting review

## 1. Problem

AT Search should search the *entire* ATmosphere the way Google searches the web:
any lexicon, any app, any PDS, without anyone at AT Search having to know the
app exists. Today the pipeline falls short in three places:

1. **Discovery.** The indexer only ingests collections on a hardcoded list
   (11 NSIDs in `packages/indexer/src/firehose.ts`). A new app's records never
   enter the index unless we edit code. The `*` wildcard exists but indexes
   blindly.
2. **Understanding.** Unknown collections go through `normalizeGeneric()`
   (field-name guessing in `packages/common/src/normalize.ts`). It can't tell
   human text from machine data — e.g. a record whose `subject` is an
   `at://` URI gets that URI indexed as its title — and it has no idea whether
   a collection is even worth indexing (`app.bsky.feed.like` has no text at
   all, yet in `*` mode every like would be probed).
3. **Presentation.** `lexiconMeta()` is a hardcoded table; every unknown type
   renders as a grey "generic" chip. And `type:` queries are exclusive — you
   can't combine a lexicon filter with free text, which is exactly what
   AT Functions needs ("image resize" *within* `at.functions.metadata`).

Hand-written adapters don't scale to the ecosystem: the cost is O(apps), and
the tail of apps is exactly what a "Google for the ATmosphere" must cover.

## 2. The insight: lexicons are now self-describing at runtime

Since the lexicon-publishing spec landed, the protocol itself ships the
metadata we've been hand-writing:

- **Schema resolution.** An NSID resolves to its schema at runtime:
  DNS TXT `_lexicon.{authority}` → DID → repo record
  `com.atproto.lexicon.schema/{nsid}`. Official support exists as the
  [`@atproto/lexicon-resolver`](https://www.npmjs.com/package/@atproto/lexicon-resolver)
  npm package and the `com.atproto.lexicon.resolveLexicon` XRPC method.
  ([spec](https://atproto.com/specs/lexicon))
- **Collection discovery.** [UFOs](https://ufos.microcosm.blue/)
  ([API](https://ufos-api.microcosm.blue/)) tracks every collection NSID ever
  seen on the firehose, with sample records, timeseries stats, and unique-user
  counts — a ready-made feed of "what exists and what's active".
- **Transport.** Jetstream `wantedCollections` supports NSID *prefix*
  wildcards (`app.bsky.feed.*`), up to 100 entries; omitting it streams
  everything.

So instead of teaching AT Search about every app, we let every app's published
schema teach AT Search how to index it. That is the seamless fix.

## 3. Approaches considered

### A. Scale the adapter registry (status quo, harder)
Keep writing `normalizeXxx()` adapters; maybe accept community PRs.
*Pros:* highest per-lexicon quality; no new moving parts.
*Cons:* O(apps) human effort forever; the tail never gets covered; new apps
are invisible until someone notices them. Not seamless — rejected as the
primary mechanism (but kept as an override tier).

### B. Schema-driven extraction ladder (recommended)
On first sight of an unknown collection, resolve its lexicon schema and
*compile* it into an extraction plan (which fields are searchable text, tags,
dates, languages, geo; or "no text → skip collection"). Normalization becomes
a three-tier ladder: **adapter → compiled plan → heuristic fallback**.
*Pros:* automatic for any app that publishes its lexicon (protocol-native and
increasingly standard); precision comes from the schema, not guesses; triage
makes full-firehose ingestion affordable; zero config for new apps.
*Cons:* new registry component; many tail NSIDs never publish schemas (they
fall to the existing heuristic — no worse than today).

### C. Index everything with heuristics only
Subscribe `*`, run `normalizeGeneric` on every record.
*Pros:* max nominal coverage, no resolver.
*Cons:* indexes machine fields as text (bad precision), wastes storage/CPU on
no-text collections (likes, follows, reposts dominate firehose volume), and
never improves as apps publish schemas. Rejected.

**Decision: B**, with A's adapters retained as the top tier and C's heuristic
as the bottom tier.

## 4. Architecture

```
Jetstream (mode `*` or dynamic wantedCollections)
        │  commit event {did, collection, rkey, record, cid}
        ▼
┌─ Indexer ─────────────────────────────────────────────────────┐
│  CollectionTriage (in-memory map, backed by LexiconRegistry)  │
│    known-indexable → ingest    no-text/denylist → drop        │
│    unknown → enqueue schema resolution, drop meanwhile        │
│                                                               │
│  LexiconRegistry (SQLite table `lexicons`)                    │
│    nsid → { status, lexiconDoc, plan, resolvedAt, ttl }       │
│    status: adapter | plan | no-text | unresolvable | denied   │
│    resolver: @atproto/lexicon-resolver (DNS→DID→repo record)  │
│    optional pre-warm: UFOs API poller (active NSIDs)          │
│                                                               │
│  normalizeRecord ladder (packages/common)                     │
│    1. ADAPTERS[nsid]            (hand-written, ~10 apps)      │
│    2. executeExtractionPlan()   (compiled from schema)        │
│    3. normalizeGeneric()        (existing heuristics)         │
│        ▼ IndexedRecord → deriveDescriptors → SQLite + DHT     │
└───────────────────────────────────────────────────────────────┘
        ▼ unchanged: pointers, DHT, query node hydration
Query node additions: `type:` filter composable with free text;
GET /lexicons metadata endpoint for the UI.
```

Everything downstream of `IndexedRecord` (descriptors, pointer records, DHT,
hydration, verification, ranking) is untouched — that normalization boundary
is the whole reason this change stays small.

## 5. Components

### 5.1 `packages/common/src/lexicon/plan.ts` (new, pure)

```ts
interface ExtractionPlan {
  nsid: string
  indexable: boolean            // false → collection carries no human text
  title: FieldPath[]            // priority-ordered
  body: FieldPath[]
  tags: FieldPath[]             // arrays of plain strings
  createdAt: FieldPath[]        // string format=datetime
  langs: FieldPath[]            // string format=language
  url: FieldPath[]              // string format=uri (http only)
  geo?: { lat: FieldPath; lon: FieldPath }
}
```

- `compileExtractionPlan(lexiconDoc): ExtractionPlan` walks the record type's
  properties (including nested objects one level deep and known refs like
  richtext facets) and classifies each field by **schema structure first,
  name second**:
  - `string` with `format: datetime` → createdAt candidate
  - `string` with `format: at-uri | did | cid | tid | uri(at://)` → *never* text
  - `string` with `format: language` → langs
  - `array of string` (no format) named `tags|labels|keywords|categories` → tags
  - unformatted `string` → text candidate; rank title-vs-body by name
    (`title|name|displayName|subject|heading` → title) then by `maxLength`
    (short strings title-like, long strings body-like); `maxGraphemes` counts too
  - `ref`/`union`/`blob`/`bytes` → skipped (except whitelisted refs, e.g.
    `app.bsky.richtext.facet` for tag features)
  - `indexable = false` when no text candidates survive (likes, follows,
    reposts, blocks compile to this — that's the triage win)
- `executeExtractionPlan(plan, did, rkey, record): IndexedRecord | null` —
  same output contract as today's adapters; missing/malformed fields degrade
  gracefully (plan paths are candidates, not guarantees).

Pure functions → directly unit-testable against real lexicon JSON fixtures.

### 5.2 `packages/indexer/src/lexiconRegistry.ts` (new)

- SQLite table `lexicons(nsid PRIMARY KEY, status, doc_json, plan_json,
  resolved_at, next_retry_at)`.
- `getPlan(nsid)`: in-memory LRU → SQLite → schedule async resolution.
- Resolution via `@atproto/lexicon-resolver`; failures are **negative-cached**
  (`unresolvable`, exponential retry: 1h → 6h → 24h → weekly) so the tail of
  junk NSIDs costs one DNS lookup a week, not one per event.
- Success TTL ~7 days, then background refresh (schemas evolve).
- Env knobs: `ATSEARCH_LEXICON_DENYLIST` (never index),
  `ATSEARCH_LEXICON_ALLOWLIST` (if set, restrict to it — preserves today's
  curated behavior for constrained deployments).
- Optional `ATSEARCH_UFOS_URL` poller: pre-warm the registry with NSIDs whose
  recent activity crosses a threshold, so schemas are usually resolved before
  the first event arrives.

### 5.3 Ingest changes (`packages/indexer/src/ingest.ts`, firehose consumers)

- Firehose/Jetstream consumer consults `CollectionTriage` before parsing
  further: `drop` statuses short-circuit at a map lookup (no JSON churn
  beyond Jetstream's own envelope).
- While a collection is `unknown` (resolution in flight), events are dropped
  after counting — with the UFOs pre-warm this window is small, and records
  are re-seen naturally on the live stream. (No replay buffer in v1: YAGNI.)
- `ingestRecord` gains an optional `plan` argument and inserts tier 2 between
  the adapter map and `normalizeGeneric`.
- Default mode changes: `ATSEARCH_JETSTREAM_COLLECTIONS` unset → `*` with
  triage. The old curated list remains available via the allowlist knob.

### 5.4 Query node

- `descriptorToQueryKeys()`: support `type:nsid` **combined** with free text
  ("resize type:at.functions.metadata" → `type:` key intersected with token
  keys at ranking time — type match becomes a filter, not just another key).
  Bare `type:nsid` keeps today's list-the-collection behavior.
- New `GET /lexicons` endpoint returning registry metadata
  (`nsid → { label, description, indexable }`) for UI tooltips/filters.

### 5.5 Demo client

- `lexiconMeta()` fallback: keep curated variants; for unknown NSIDs derive
  the label from the last NSID segment (already done) and pick a **stable
  hashed color variant** instead of always-grey, with the lexicon description
  (from `/lexicons`) as tooltip.
- Optional type-filter chips sourced from `/lexicons`.

### 5.6 AT Functions (dogfooding, separate repo)

- Publish `at.functions.metadata` via `com.atproto.lexicon.schema` in the
  authority repo and add the `_lexicon.functions.at` DNS TXT record — making
  AT Functions discoverable through the exact pipeline this design builds.
- AT Functions' backend "discover functions" feature = AT Search query
  `type:at.functions.metadata` + free text. No PDS enumeration needed.

## 6. Error handling

| Failure | Behavior |
|---|---|
| DNS/`resolveLexicon` failure | negative-cache, exponential retry; events fall to heuristic tier only if collection was previously indexable, else dropped |
| Malformed/unparseable schema | treat as `unresolvable` (heuristic tier applies if record reaches ingest via allowlist) |
| Schema changes shape | TTL refresh recompiles plan; old IndexedRecords stand until record update re-ingests |
| Registry DB unavailable | triage degrades to current behavior (curated allowlist) |
| Jetstream reconnect (dynamic list mode) | resubscribe with current list; `*` mode unaffected |

## 7. Testing

- **Plan compilation goldens:** real lexicon JSON fixtures (whitewind blog
  entry, frontpage post, linkat board, at.functions.metadata, bsky post,
  bsky like/follow) → snapshot the compiled `ExtractionPlan`; assert
  like/follow compile to `indexable: false`.
- **Execution goldens:** plan + sample record → expected `IndexedRecord`;
  compare plan output vs existing hand adapters on the same records (plan
  tier should be ≥ heuristic quality, adapters may stay richer).
- **Registry:** resolution success/negative-cache/retry schedule with a
  mocked resolver; allow/denylist precedence.
- **Query:** `type:` + tokens composition ranking test.
- **End-to-end (manual):** droplet in `*` mode for a day; inspect which
  collections were auto-indexed vs triaged out.

## 8. Rollout

1. `plan.ts` + tests (pure, no wiring) — the riskiest logic, proven first.
2. Registry + triage in indexer behind `ATSEARCH_LEXICON_MODE=auto` flag.
3. Query-node `type:` composition + `/lexicons`.
4. Client chip/tooltip polish.
5. Flip default to auto mode; deploy droplet in `*` mode.
6. AT Functions lexicon publishing (separate repo, anytime after 1).

## 9. Out of scope (explicitly)

- DHT multiaddr → HTTP resolution, multi-indexer sharding, rate limiting —
  real, pre-existing gaps, orthogonal to cross-pollination.
- Replay buffer for events seen before first schema resolution.
- Semantic/vector search — descriptor keys stay lexical in v1.
