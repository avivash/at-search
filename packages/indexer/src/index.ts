import 'dotenv/config'
import { openDb, pruneRecordsOlderThan } from './db.js'
import { createDhtNode } from './dht.js'
import { startServer } from './server.js'
import { startPolling } from './poller.js'
import { startFirehose } from './firehose.js'
import { startRepoFirehose } from './firehoseRepos.js'
import { LexiconRegistry, defaultResolveLexiconDoc } from './lexiconRegistry.js'
import { IngestBatcher } from './ingestBatch.js'

// Render sets `PORT`; support it as a fallback.
const PORT = parseInt(process.env.ATSEARCH_HTTP_PORT ?? process.env.PORT ?? '3001', 10)
const DB_PATH = process.env.ATSEARCH_DB_PATH ?? './data/indexer.db'
const DHT_PORT = parseInt(process.env.ATSEARCH_DHT_PORT ?? '8001', 10)
const NODE_KEY = process.env.ATSEARCH_NODE_KEY

/**
 * Indexer modes:
 *
 *   local      — no live ingestion; use the seed script to populate (default)
 *
 *   poll       — periodically poll specific DIDs via com.atproto.repo.listRecords.
 *                Useful for a known set of accounts without firehose access.
 *                Requires ATSEARCH_POLL_DIDS (comma-separated DIDs) and
 *                ATSEARCH_PDS_URL (default: https://bsky.social).
 *
 *   jetstream  — live ingestion from the public Jetstream websocket relay.
 *                Useful when you want to discover records across many repos
 *                without preconfiguring DIDs (e.g. all at.functions.metadata).
 *
 *   firehose   — live ingestion from the full atproto repo event stream
 *                (com.atproto.sync.subscribeRepos). This includes custom lexicons.
 *
 * Jetstream live ingestion was removed from the default demo path; the query node
 * now hydrates via Slingshot / direct XRPC. See MIGRATION_MICROCOSM.md.
 */
const MODE = process.env.ATSEARCH_MODE ?? 'local'

/**
 * Retention. The index grows without bound on a full-firehose subscription;
 * 0 disables pruning. Freed pages return to SQLite's freelist and are reused,
 * so this bounds growth rather than shrinking an existing database.
 */
const RETENTION_DAYS = parseFloat(process.env.ATSEARCH_RETENTION_DAYS ?? '0')
/** Log every ingested record. Off by default: at firehose volume this alone fills disks. */
const LOG_INGEST = process.env.ATSEARCH_LOG_INGEST === '1'
const BATCH_SIZE = parseInt(process.env.ATSEARCH_INGEST_BATCH ?? '500', 10)
const BATCH_FLUSH_MS = parseInt(process.env.ATSEARCH_INGEST_FLUSH_MS ?? '2000', 10)

/**
 * Lexicon handling:
 *   auto    — default: resolve lexicon schemas at runtime, triage collections, subscribe wide
 *   curated — fixed collection lists, no runtime schema resolution
 */
const LEXICON_MODE = process.env.ATSEARCH_LEXICON_MODE ?? 'auto'

const parseList = (v: string | undefined): string[] | undefined => {
  const items = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return items.length ? items : undefined
}

const PDS_URL = process.env.ATSEARCH_PDS_URL ?? 'https://bsky.social'
const JETSTREAM_URL =
  (process.env.ATSEARCH_JETSTREAM_URL ?? 'wss://jetstream2.us-west.bsky.network').replace(/\/$/, '')
// @atproto/sync Firehose expects an HTTP(S) service base (it upgrades to WS internally).
const FIREHOSE_URL = (process.env.ATSEARCH_FIREHOSE_URL ?? 'https://bsky.network').replace(/\/$/, '')
const BOOTSTRAP_PEERS = process.env.ATSEARCH_DHT_BOOTSTRAP
  ? process.env.ATSEARCH_DHT_BOOTSTRAP.split(',').map((s) => s.trim())
  : []

async function main() {
  console.log('Starting AT Search indexer...')

  const db = openDb(DB_PATH)
  console.log(`Database opened at ${DB_PATH}`)

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

  // Live ingestion batches its writes; seed/poll paths still write directly.
  const isLive = MODE === 'jetstream' || MODE === 'firehose'
  const batcher = isLive
    ? new IngestBatcher(db, { maxBatch: BATCH_SIZE, flushMs: BATCH_FLUSH_MS })
    : undefined
  if (batcher) {
    console.log(`Batching index writes (${BATCH_SIZE} records / ${BATCH_FLUSH_MS}ms)`)
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => {
        batcher.stop()
        process.exit(0)
      })
    }
  }

  // Per-record logging is off by default; report a rate instead.
  let ingestedSinceReport = 0
  const onIngested = LOG_INGEST
    ? (uri: string, cid: string) => console.log(`Indexed: ${uri} @ ${cid}`)
    : () => {
        ingestedSinceReport++
      }
  if (!LOG_INGEST) {
    setInterval(() => {
      if (ingestedSinceReport > 0) {
        console.log(`Indexed ${ingestedSinceReport} records in the last minute`)
        ingestedSinceReport = 0
      }
    }, 60_000).unref()
  }

  if (RETENTION_DAYS > 0) {
    const prune = () => {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString()
      try {
        const removed = pruneRecordsOlderThan(db, cutoff)
        if (removed > 0) console.log(`[retention] pruned ${removed} records older than ${RETENTION_DAYS}d`)
      } catch (err) {
        console.warn('[retention] prune failed:', (err as Error).message)
      }
    }
    prune()
    setInterval(prune, 3_600_000).unref()
    console.log(`Retention: ${RETENTION_DAYS} days`)
  }

  const dhtNode = await createDhtNode({
    listenPort: DHT_PORT,
    bootstrapPeers: BOOTSTRAP_PEERS,
  })
  console.log(`DHT node started. Peer ID: ${dhtNode.peerId.toString()}`)

  await startServer({ db, dhtNode, port: PORT, privateKeyHex: NODE_KEY })
  console.log(`HTTP server listening on port ${PORT}`)

  if (MODE === 'poll') {
    const dids = (process.env.ATSEARCH_POLL_DIDS ?? '').split(',').filter(Boolean)
    const collections = (process.env.ATSEARCH_POLL_COLLECTIONS ?? 'com.example.thing')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (dids.length === 0) {
      console.warn('ATSEARCH_MODE=poll but no ATSEARCH_POLL_DIDS set; polling skipped')
    } else {
      console.log(`Polling ${dids.length} DIDs from ${PDS_URL} (${collections.join(', ')})`)
      startPolling(db, dhtNode, {
        pdsUrl: PDS_URL,
        dids,
        collections,
        onIngested,
      })
    }
  } else if (MODE === 'jetstream') {
    const collections = (process.env.ATSEARCH_JETSTREAM_COLLECTIONS ?? process.env.ATSEARCH_POLL_COLLECTIONS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    console.log(
      `Jetstream ingest enabled (${JETSTREAM_URL})` +
        (collections.length ? `; collections: ${collections.join(', ')}` : '; collections: (defaults)'),
    )

    startFirehose(db, dhtNode, {
      jetstreamUrl: JETSTREAM_URL,
      collections: collections.length ? collections : registry ? ['*'] : undefined,
      registry,
      batcher,
      onStatus: (msg) => console.log(`[jetstream] ${msg}`),
      onIngested,
    })
  } else if (MODE === 'firehose') {
    const collections = (process.env.ATSEARCH_FIREHOSE_COLLECTIONS ?? process.env.ATSEARCH_POLL_COLLECTIONS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    console.log(
      `Repo firehose ingest enabled (${FIREHOSE_URL})` +
        (collections.length ? `; collections: ${collections.join(', ')}` : '; collections: (all)'),
    )

    startRepoFirehose(db, dhtNode, {
      relayUrl: FIREHOSE_URL,
      collections: collections.length ? collections : undefined,
      registry,
      batcher,
      onStatus: (msg) => console.log(`[firehose] ${msg}`),
      onIngested,
    })
  } else {
    console.log('Mode=local: no live ingestion. Run the seed script to populate.')
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
