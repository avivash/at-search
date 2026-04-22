/**
 * @deprecated Reference-only Jetstream consumer — not imported by the indexer entrypoint.
 * The demo stack hydrates records via Slingshot / direct XRPC (see MIGRATION_MICROCOSM.md).
 *
 * Jetstream consumer.
 *
 * Jetstream is Bluesky's JSON-over-WebSocket relay that re-encodes the raw
 * AT Proto firehose (binary DAG-CBOR + CAR blocks) into plain JSON events.
 * It aggregates commits from every PDS that federates with bsky.network —
 * Bluesky, Blacksky, Northsky, self-hosted PDSes, etc.
 *
 * Public endpoints (pick the geographically closest one):
 *   wss://jetstream1.us-east.bsky.network/subscribe
 *   wss://jetstream2.us-east.bsky.network/subscribe
 *   wss://jetstream1.us-west.bsky.network/subscribe
 *   wss://jetstream2.us-west.bsky.network/subscribe
 *
 * Event format:
 *   { did, time_us, kind: 'commit', commit: { rev, operation, collection, rkey, record, cid } }
 *   { did, time_us, kind: 'account' | 'identity', ... }
 */

import WebSocket from 'ws'
import type Database from 'better-sqlite3'
import { ingestRecord } from './ingest.js'
import { advertiseDescriptor } from './dht.js'
import type { DhtNode } from './dht.js'

const SUPPORTED_COLLECTIONS = [
  'app.bsky.feed.post',
  'app.bsky.actor.profile',
  'com.example.thing',
]

interface JetstreamCommit {
  rev: string
  operation: 'create' | 'update' | 'delete'
  collection: string
  rkey: string
  record?: unknown
  cid?: string
}

interface JetstreamEvent {
  did: string
  time_us: number
  kind: 'commit' | 'account' | 'identity'
  commit?: JetstreamCommit
}

export interface FirehoseOptions {
  /** Jetstream WebSocket base URL (without path) */
  jetstreamUrl: string
  /** Collections to subscribe to (defaults to SUPPORTED_COLLECTIONS) */
  collections?: string[]
  /** Called after each successful record ingest */
  onIngested?: (uri: string, cid: string) => void
  /** Called on connection events for logging */
  onStatus?: (msg: string) => void
}

export function startFirehose(
  db: Database.Database,
  dhtNode: DhtNode,
  opts: FirehoseOptions,
): () => void {
  const collections = opts.collections ?? SUPPORTED_COLLECTIONS
  const collectionsParam = collections.map((c) => `wantedCollections=${encodeURIComponent(c)}`).join('&')
  const wsUrl = `${opts.jetstreamUrl}/subscribe?${collectionsParam}`

  let ws: WebSocket | null = null
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelay = 1000

  const connect = () => {
    if (stopped) return

    opts.onStatus?.(`Connecting to Jetstream: ${wsUrl}`)
    ws = new WebSocket(wsUrl)

    ws.on('open', () => {
      opts.onStatus?.('Jetstream connected')
      reconnectDelay = 1000 // reset backoff on successful connect
    })

    ws.on('message', async (data: Buffer | string) => {
      try {
        const event = JSON.parse(data.toString()) as JetstreamEvent
        if (event.kind !== 'commit') return

        const commit = event.commit
        if (!commit) return
        if (commit.operation === 'delete') return
        if (!commit.record || !commit.cid) return
        if (!collections.includes(commit.collection)) return

        const uri = `at://${event.did}/${commit.collection}/${commit.rkey}`
        const result = ingestRecord(db, uri, commit.cid, commit.record)

        if (result) {
          // Advertise all descriptors on the DHT so other query nodes can discover this indexer
          await Promise.all(result.descriptors.map((key) => advertiseDescriptor(dhtNode, key)))
          opts.onIngested?.(uri, commit.cid)
        }
      } catch (err) {
        // Malformed events are common on the firehose; don't crash
        if (process.env.DEBUG_FIREHOSE) {
          console.debug('Firehose parse error:', err)
        }
      }
    })

    ws.on('error', (err) => {
      opts.onStatus?.(`Jetstream error: ${err.message}`)
    })

    ws.on('close', (code) => {
      opts.onStatus?.(`Jetstream closed (${code}). Reconnecting in ${reconnectDelay}ms…`)
      if (!stopped) {
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000) // exponential backoff, max 30s
          connect()
        }, reconnectDelay)
      }
    })
  }

  connect()

  return () => {
    stopped = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    ws?.close()
    opts.onStatus?.('Jetstream consumer stopped')
  }
}
