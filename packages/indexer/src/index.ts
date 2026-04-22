import 'dotenv/config'
import { openDb } from './db.js'
import { createDhtNode } from './dht.js'
import { startServer } from './server.js'
import { startPolling } from './poller.js'

const PORT = parseInt(process.env.ATSEARCH_HTTP_PORT ?? '3001', 10)
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
 * Jetstream live ingestion was removed from the default demo path; the query node
 * now hydrates via Slingshot / direct XRPC. See MIGRATION_MICROCOSM.md.
 */
const MODE = process.env.ATSEARCH_MODE ?? 'local'

const PDS_URL = process.env.ATSEARCH_PDS_URL ?? 'https://bsky.social'
const BOOTSTRAP_PEERS = process.env.ATSEARCH_DHT_BOOTSTRAP
  ? process.env.ATSEARCH_DHT_BOOTSTRAP.split(',').map((s) => s.trim())
  : []

async function main() {
  console.log('Starting AT Search indexer...')

  const db = openDb(DB_PATH)
  console.log(`Database opened at ${DB_PATH}`)

  const dhtNode = await createDhtNode({
    listenPort: DHT_PORT,
    bootstrapPeers: BOOTSTRAP_PEERS,
  })
  console.log(`DHT node started. Peer ID: ${dhtNode.peerId.toString()}`)

  await startServer({ db, dhtNode, port: PORT, privateKeyHex: NODE_KEY })
  console.log(`HTTP server listening on port ${PORT}`)

  if (MODE === 'poll') {
    const dids = (process.env.ATSEARCH_POLL_DIDS ?? '').split(',').filter(Boolean)
    if (dids.length === 0) {
      console.warn('ATSEARCH_MODE=poll but no ATSEARCH_POLL_DIDS set; polling skipped')
    } else {
      console.log(`Polling ${dids.length} DIDs from ${PDS_URL}`)
      startPolling(db, dhtNode, {
        pdsUrl: PDS_URL,
        dids,
        onIngested: (uri, cid) => console.log(`Indexed: ${uri} @ ${cid}`),
      })
    }
  } else if (MODE === 'jetstream') {
    // Warn only — Jetstream consumer code remains in ./firehose.ts as a reference snapshot.
    console.warn(
      '[indexer] Jetstream ingestion is disabled. Use local+seed or poll. See MIGRATION_MICROCOSM.md.',
    )
  } else {
    console.log('Mode=local: no live ingestion. Run the seed script to populate.')
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
