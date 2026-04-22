# AT Search

A decentralized search and discovery layer for AT Protocol objects, built as a Kademlia DHT overlay that routes queries to indexers without replacing AT Protocol's native identity, repo, or PDS model.

---

## Monorepo layout and tooling

This repo is a **single workspace**: the root `package.json` lists `"workspaces": ["packages/*"]`. **Bun** is the supported tool for installs and scripts (`bun install`, `bun run …`); the lockfile is **`bun.lock`**. Run installs from the **repository root** so `workspace:*` links resolve.

### Packages

| Directory | Package name | Purpose |
|-----------|--------------|---------|
| `packages/common` | `@atsearch/common` | Shared types, descriptor derivation, Ed25519 signing. **`bun run --filter @atsearch/common build`** runs `tsc` to `dist/`. **`bun run --filter @atsearch/common test`** runs Jest. |
| `packages/indexer` | `@atsearch/indexer` | SQLite index, DHT provider, `GET /pointers/:key`, `GET /record`. Depends on **`@atsearch/common`** via `workspace:*`. **`build`** → `tsc`; **`dev`** → `tsx watch`. **`seed`** → `tsx src/seed.ts`. The compiled app is run with **`node dist/index.js`** in production and in `scripts/run-demo.sh` because **better-sqlite3** is built for Node’s native ABI (Bun cannot load that binary). |
| `packages/query-node` | `@atsearch/query-node` | Search API (`/search`, `/resolve`, `/interactions`), Slingshot/Constellation/XRPC hydration, ranking. Depends on **`@atsearch/common`** via `workspace:*`. **`build`** / **`dev`** same pattern as indexer (no better-sqlite3; **Bun** can run `dist/index.js`). |
| `packages/demo-client` | `@atsearch/demo-client` | SvelteKit UI. **No** `workspace:*` dependency on `@atsearch/common`; it only calls the query node over **HTTP**. **`vite build`** / **`vite dev`**. |

### Root scripts

Defined in the root `package.json` and meant to be run from the repo root:

| Command | Effect |
|---------|--------|
| `bun install` | Installs all workspace dependencies and links `workspace:*` packages. |
| `bun run build` | `bun run --filter '*' build` — runs `build` in every package that defines it (build order follows Bun’s workspace scheduling; `common` should complete before dependents in practice). |
| `bun run dev` | Runs each package’s `dev` script in parallel (useful less often than running one package’s dev server). |
| `bun run test` | Runs `test` in each package that defines it (currently **@atsearch/common**). |
| `bun run lint` | `tsc --noEmit` / `svelte-check` per package where configured. |
| `bun run seed` | `bun run --filter @atsearch/indexer seed` — writes seed data into `ATSEARCH_DB_PATH` (default `./data/indexer.db`). |
| `bun run demo` | `bash scripts/run-demo.sh` — builds packages, seeds, then starts indexer (**Node**), query node (**Bun**), and the demo (**Bun** + Vite). See that script for ports and env. |

**Work on one package:** `cd packages/<name> && bun run dev`, or from root `bun run --filter @atsearch/<name> <script>` (e.g. `bun run --filter @atsearch/query-node dev`).

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  Publisher                                                        │
│  Writes records (com.example.thing) into their AT Proto repo     │
└─────────────────────────┬─────────────────────────────────────────┘
                          │ AT Proto firehose / polling
                          ▼
┌───────────────────────────────────────────────────────────────────┐
│  Indexer Node                                                     │
│  • Ingests com.example.thing records                             │
│  • Derives descriptor keys (type, tag, token, geo)               │
│  • Stores (uri, cid, descriptors) in SQLite                      │
│  • Advertises as DHT provider for each descriptor key            │
│  • Serves GET /pointers/:descriptorKey (signed PointerRecords)   │
└────────────┬──────────────────────────────┬──────────────────────┘
             │ DHT advertise                │ HTTP /pointers/:key
             ▼                              ▼
┌───────────────────┐           ┌───────────────────────────────────┐
│  Kademlia DHT     │           │  Query Node                       │
│  (libp2p kad-dht) │◄─────────►│  • Accepts GET /search?q=…        │
│  descriptorKey    │   find    │  • Derives descriptor keys        │
│    → providers    │  providers│  • Queries DHT for providers      │
└───────────────────┘           │  • Fetches pointer records        │
                                │  • Hydrates uri+cid via Slingshot → XRPC fallback → indexer cache │
                                │  • Constellation for likes/replies │
                                │  • Verifies CID on PDS            │
                                │  • Ranks and returns results      │
                                └────────────────┬──────────────────┘
                                                 │ JSON results
                                                 ▼
                                ┌────────────────────────────────────┐
                                │  Demo Client (SvelteKit + Vite)    │
                                │  • Search input                    │
                                │  • Results, pagination, interactions │
                                │  • Verification status             │
                                │  • Matched descriptors             │
                                └────────────────────────────────────┘
```

### Data flow (conceptual)

See **Monorepo layout and tooling** for package names and how they are built and run.

---

## Identity model

### Why CID alone is insufficient

A CID (Content Identifier) is an immutable hash of a record's content at a specific point in time. Using a CID alone as an identity is incorrect for three reasons:

1. **No location.** A CID tells you nothing about where to fetch the record. You need the AT URI to resolve the DID to a PDS and fetch the record.

2. **No ownership.** The same content could be published by multiple different accounts under different URIs. Records with identical content (same CID) from different repositories are distinct objects.

3. **No update path.** When a record is updated, the CID changes. The AT URI remains stable. Treating CID as identity breaks identity across updates.

### Strong reference: `uri + cid`

Every result in AT Search is represented as a **strong reference**:

```
uri: at://did:plc:abc/com.example.thing/123
cid: bafyreiXXXXXX
```

- The **URI** (`at://did/collection/rkey`) is the durable identity. It tells you who published the record and where.
- The **CID** is the immutable content hash for that specific version of the record.
- Together `uri + cid` uniquely identifies a specific version of a specific record.

**The current serving location** (PDS endpoint) is derived at query time by resolving the DID — it is not stored as part of identity and can change without invalidating the reference.

### Key invariants

| Scenario | Behavior |
|----------|----------|
| Same CID, different URIs | Never deduplicated — these are different objects |
| Same URI, new CID | Treated as a new version — both uri+cid pairs are indexed |
| PDS migration | Identity unchanged — re-resolved from DID at fetch time |
| Stale DHT entry | Ignored if pointer `expiresAt` is in the past |
| Duplicate providers | Merged; candidates deduplicated by `uri + cid` |

---

## DHT vs AT Protocol roles

| Concern | DHT layer | AT Protocol |
|---------|-----------|-------------|
| Record storage | ❌ never | ✅ authoritative |
| Record identity | ❌ never | ✅ AT URI |
| Content truth | ❌ never | ✅ CID from PDS |
| Discovery hints | ✅ descriptor → provider | ❌ |
| Pointer records | ✅ (hint only, verified) | ❌ |
| DID resolution | ❌ | ✅ PLC directory / did:web |

The DHT is purely a **discovery and hinting layer**. Every query ultimately verifies results against the live AT Protocol PDS. No record content lives in the DHT.

---

## Descriptor derivation

The indexer normalises several collections (see `packages/common` / `packages/indexer` ingest). From a **`com.example.thing`** record, descriptors include:

| Descriptor type | Example | Source |
|----------------|---------|--------|
| `type:…` | `type:com.example.thing` | Static |
| `tag:…` | `tag:mutual-aid` | `record.tags` |
| `token:…` | `token:fridge` | Tokenized title + description |
| `geo:…` | `geo:c2`, `geo:c2b2`, `geo:c2b2n` | Geohash prefixes at lengths 2, 4, full |

Rules: lowercase, stopwords removed, deduped.

Each descriptor key is hashed as `sha256("atsearch:v1:" + key)` before being used as a DHT CID.

---

## Pointer record structure

Indexers serve signed pointer records over HTTP at `GET /pointers/:descriptorKey`.

```typescript
interface PointerRecord {
  version: 1
  descriptorKey: string        // e.g. "tag:food"
  ref: {
    uri: string                // at://did/collection/rkey
    cid: string                // immutable content hash
  }
  providerPeerId: string       // libp2p peer ID of this indexer
  providerDid?: string         // optional AT Proto DID of this indexer
  indexedAt: string            // ISO timestamp
  expiresAt: string            // ISO timestamp (TTL: 24h default)
  signature: string            // Ed25519 signature (base64), covers all other fields
}
```

The signature covers all fields except `signature` itself, serialized as canonically sorted JSON. This allows query nodes to verify that pointer records have not been tampered with in transit.

---

## Ranking

Results are scored as follows:

| Condition | Score change |
|-----------|-------------|
| All query tokens match record | +5 |
| Per matching token | +1 |
| Per matching tag | +2 |
| Geohash match | +2 per level |
| CID verified against PDS | +1 |
| Expired pointer | -3 |
| Fetch failure | -2 |
| CID mismatch (stale pointer) | -2 |

Results are returned sorted descending by score.

---

## Setup

### Prerequisites

- [Bun](https://bun.sh/) 1.0+ (package manager and runtime used in this repo)

### Install

```bash
bun install
```

### Build

```bash
bun run build
```

### Test

```bash
bun run test
```

---

## Running the demo

### Quick start (local mode, no AT Proto credentials needed)

```bash
# 1. Install dependencies
bun install

# 2. Build all packages
bun run build

# 3. Seed the database with synthetic records
bun run seed

# 4. Start the full stack
bun run demo
```

`scripts/run-demo.sh` uses **Bun** for installs, builds, seeding, the query node, and the demo client. The **indexer** process is started with **`node`** because **`better-sqlite3`** is a native addon built for Node’s ABI; running that package under Bun’s runtime triggers `NODE_MODULE_VERSION` mismatch errors. Set **`NODE_BIN`** if `node` is not on your `PATH`.

The script checks that **indexer HTTP**, **indexer DHT**, **query HTTP**, **query DHT**, and **Vite** ports are free before starting (so you do not accidentally hit an old query node and get **404 on `/interactions`**). Override ports if needed, for example:

```bash
INDEXER_PORT=3011 QUERY_PORT=3012 DEMO_PORT=5180 bun run demo
```

This will start:
- **Indexer** on `http://localhost:3001` (or `INDEXER_PORT`)
- **Query node** on `http://localhost:3002` (or `QUERY_PORT`)
- **Demo client** on `http://localhost:5173` (or `DEMO_PORT`; the script prints the real URL)

Open the printed URL and try queries like `fridge`, `vancouver`, `mutual-aid`. For a **Bluesky / federated profile** not present in your local SQLite index, enter a **handle** (`user.bsky.social`) or **DID** (`did:plc:…`) alone on the search line; the query node resolves it via Slingshot / public XRPC and returns `app.bsky.actor.profile/self` as a hit.

---

## Deploy publicly (single VM, Docker Compose)

This repo includes a production-ready `docker-compose.yml` that runs the full stack on one host:

- **`indexer`**: HTTP `:3001`, libp2p DHT `:8001`
- **`query-node`**: HTTP `:3002`, libp2p DHT `:8002`
- **`web`**: Caddy on `:80/:443` serving the demo and proxying **`/api/* → query-node`**

### Prereqs

- Install Docker + Compose plugin
- Point a DNS name at the server (A/AAAA record)
- Allow inbound **80/tcp** + **443/tcp**
- Optional: allow inbound **8001/tcp** + **8002/tcp** (if you want DHT reachability from other machines)

### Configure environment

On the server (repo root), create `.env` with at least:

```bash
ATSEARCH_PUBLIC_HOSTNAME=atsearch.yourdomain.com
```

Recommended:

```bash
USE_MICROCOSM=true
MICROCOSM_SLINGSHOT_BASE_URL=https://slingshot.microcosm.blue
MICROCOSM_CONSTELLATION_BASE_URL=https://constellation.microcosm.blue
FALLBACK_ATPROTO_XRPC_BASE_URL=https://public.api.bsky.app
APP_USER_AGENT='at-search-demo/0.1 (public; +https://atsearch.yourdomain.com)'

# Optional: stable pointer signatures across restarts
# ATSEARCH_NODE_KEY=ed25519_private_key_hex
```

### Launch

```bash
docker compose up -d --build
```

Then:

- **UI**: `https://atsearch.yourdomain.com`
- **API (proxied)**: `https://atsearch.yourdomain.com/api/health`

### Notes

- The demo UI defaults to calling `window.location.origin + "/api"`; Caddy reverse-proxies that to the query node.
- SQLite persists in the `atsearch_data` Docker volume.
- If you do **not** want DHT ports exposed publicly, remove the `8001:8001` / `8002:8002` mappings from `docker-compose.yml`.

### Manual start

```bash
# Terminal 1 — indexer
cd packages/indexer
ATSEARCH_LIBP2P_LISTEN_HOST=127.0.0.1 \
ATSEARCH_DB_PATH=../../data/indexer.db ATSEARCH_HTTP_PORT=3001 bun run dev

# Terminal 2 — query node
cd packages/query-node
USE_MICROCOSM=true \
MICROCOSM_SLINGSHOT_BASE_URL=https://slingshot.microcosm.blue \
MICROCOSM_CONSTELLATION_BASE_URL=https://constellation.microcosm.blue \
FALLBACK_ATPROTO_XRPC_BASE_URL=https://public.api.bsky.app \
APP_USER_AGENT='at-search-demo/0.1 (manual)' \
ATSEARCH_LIBP2P_LISTEN_HOST=127.0.0.1 \
ATSEARCH_HTTP_PORT=3002 ATSEARCH_INDEXER_URLS=http://localhost:3001 bun run dev

# Terminal 3 — demo client
cd packages/demo-client
# The dev server proxies /api → query-node (see vite.config.ts), so you don't need VITE_QUERY_API_URL.
# If you changed the query node port, set VITE_QUERY_PROXY_TARGET accordingly.
# Example: VITE_QUERY_PROXY_TARGET=http://127.0.0.1:3012 bun run dev -- --port 5180
bun run dev -- --port 5173
```

### With AT Proto credentials (poll mode)

```bash
ATSEARCH_MODE=poll \
ATSEARCH_PDS_URL=https://bsky.social \
ATSEARCH_POLL_DIDS=did:plc:yourDid \
ATSEARCH_DB_PATH=./data/indexer.db \
ATSEARCH_HTTP_PORT=3001 \
  bun run --filter @atsearch/indexer dev
```

---

## Environment variables

---

## Deploy to Render.com

This repo includes a Render Blueprint at `render.yaml` that provisions:

- `at-search-web` (public) — static demo + `/api` proxy
- `at-search-query-node` (private) — Fastify API
- `at-search-indexer` (private) — Fastify indexer + SQLite disk

### Steps

1. Push this repo to GitHub/GitLab.
2. In Render, choose **New → Blueprint** and select the repository.
3. Render will detect `render.yaml` and propose creating the three services.
4. After deploy completes, open the `at-search-web` URL; the UI will call `/api/*` on the same origin.

### Notes (Render limitations)

- Render services only expose a single HTTP port. The Blueprint sets `ATSEARCH_DHT_PORT=0` to disable DHT listeners by default.
- The indexer uses an attached disk mounted at `/data` and stores SQLite at `/data/indexer.db`.
- If you want to run `ATSEARCH_MODE=poll`, set `ATSEARCH_MODE=poll`, `ATSEARCH_PDS_URL`, and `ATSEARCH_POLL_DIDS` on the `at-search-indexer` service in Render.

### Indexer

| Variable | Default | Description |
|----------|---------|-------------|
| `ATSEARCH_MODE` | `local` | `local`, `poll`, or `jetstream` (jetstream logs a warning; use `MIGRATION_MICROCOSM.md`) |
| `ATSEARCH_PDS_URL` | `https://bsky.social` | PDS base URL |
| `ATSEARCH_HANDLE` | — | AT handle (for auth; poll-related tooling if used) |
| `ATSEARCH_PASSWORD` | — | App password |
| `ATSEARCH_DHT_BOOTSTRAP` | — | Comma-separated bootstrap multiaddrs |
| `ATSEARCH_DHT_PORT` | `8001` | libp2p TCP listen port |
| `ATSEARCH_LIBP2P_LISTEN_HOST` | `127.0.0.1` | IPv4 for libp2p TCP bind (`0.0.0.0` can fail on some hosts with `ERR_NO_VALID_ADDRESSES`) |
| `ATSEARCH_HTTP_PORT` | `3001` | HTTP server port |
| `ATSEARCH_DB_PATH` | `./data/indexer.db` | SQLite database path |
| `ATSEARCH_NODE_KEY` | — | Ed25519 private key hex (persisted signing key) |

### Query node

| Variable | Default | Description |
|----------|---------|-------------|
| `ATSEARCH_DHT_BOOTSTRAP` | — | Comma-separated bootstrap multiaddrs |
| `ATSEARCH_DHT_PORT` | `8002` | libp2p TCP listen port |
| `ATSEARCH_LIBP2P_LISTEN_HOST` | `127.0.0.1` | Same as indexer; libp2p bind address |
| `ATSEARCH_HTTP_PORT` | `3002` | HTTP server port |
| `ATSEARCH_INDEXER_URLS` | `http://localhost:3001` | Comma-separated indexer base URLs |
| `USE_MICROCOSM` | `true` when set; if unset, defaults to on when `MICROCOSM_SLINGSHOT_BASE_URL` is non-empty | Prefer Slingshot for record/identity reads |
| `MICROCOSM_SLINGSHOT_BASE_URL` | — | e.g. `https://slingshot.microcosm.blue` |
| `MICROCOSM_CONSTELLATION_BASE_URL` | — | e.g. `https://constellation.microcosm.blue` (for `GET /interactions` / backlinks) |
| `FALLBACK_ATPROTO_XRPC_BASE_URL` | `https://public.api.bsky.app` | App View / public XRPC when Slingshot does not serve a method |
| `APP_USER_AGENT` | `at-search-demo/0.1 (local dev)` | User-Agent on outbound Microcosm + XRPC requests |

### Why Microcosm?

**Slingshot** is an edge cache for public `com.atproto.*` reads (records, handles). The query node tries it first, then falls back to direct XRPC and finally the indexer’s SQLite cache (seed / poll data).

**Constellation** indexes backlinks from firehose-seen records. The demo uses it for **likes** and **replies** on Bluesky posts (`GET /interactions?subjectUri=…`), not for full-text search.

### Demo client

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_QUERY_API_URL` | (unset) | Optional override for query node base URL. If unset, the demo calls `window.location.origin + "/api"` (and in dev, Vite proxies `/api` to the local query node). |

---

## Seed data

The seed script (`bun run seed`) inserts 12 synthetic records covering:

- Vancouver community fridge (2 records: original + updated version)
- East Van Tool Library (overlapping tags and geo)
- Seattle Capitol Hill Fridge (overlapping token `fridge`)
- Toronto Kensington food pantry (overlapping tag `food`)
- London Hackney Bike Repair (different geography)
- Berlin Kreuzberg Free Shop (different geography)
- Duplicate content record: identical to the Vancouver fridge but different URI (demonstrates CID-alone deduplication is wrong)
- Updated Vancouver fridge: same URI as original but new CID (demonstrates versioning)
- Stale Community Garden (old `createdAt`, exercises stale pointer path)
- Auckland Grey Lynn Repair Cafe
- Sydney Newtown Tool Library (overlapping tag `tools`)
- Vancouver Seed Library (overlapping geo)

---

## Limitations

1. **Firehose full decode not implemented.** The firehose emits CAR-encoded blocks. Full record extraction requires `@atproto/sync` + DAG-CBOR decoding; the prototype logs seen records but falls back to PDS polling for actual content.

2. **DHT → HTTP peer resolution not implemented.** In production, DHT `findProviders` returns multiaddrs that need to be resolved to HTTP endpoints. The prototype uses configured `ATSEARCH_INDEXER_URLS` directly (DHT discovery supplements but does not replace this in the current implementation).

3. **No DHT record persistence.** libp2p kad-dht provider records expire; real indexers would need periodic re-advertisement.

4. **CID computation.** AT Protocol CIDs are DAG-CBOR encoded. We cannot recompute them from JSON. Instead, we compare against the CID returned by the PDS via `com.atproto.repo.getRecord`. This is correct but means verification requires a live PDS.

5. **No authentication for write operations.** The indexer's pointer signing keys are ephemeral by default. In production, keys should be persisted and associated with a verified AT Proto DID.

6. **SQLite is single-node.** For production, a distributed store or at least replicated SQLite would be needed.

7. **No rate limiting** on the query node or indexer HTTP endpoints.

---

## Future work

- Full CAR block decoding for firehose ingestion
- DHT multiaddr → HTTP endpoint resolution (removes need for out-of-band indexer URL configuration)
- DID-anchored indexer identity (indexer signs with DID key)
- Geohash range queries (expand geo prefix search)
- Lexicon-driven descriptor derivation (support any AT Proto record type)
- Server-side search pagination (the demo UI paginates 10 results per page client-side)
- Persistent DHT routing tables
- HTTPS + TLS for indexer HTTP endpoints
- Query node result caching
- Prometheus metrics for query latency, DHT lookup time, verification success rate
