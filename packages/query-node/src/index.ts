import 'dotenv/config'
import { createDhtNode } from './dht.js'
import { buildServer } from './server.js'

const PORT = parseInt(process.env.ATSEARCH_HTTP_PORT ?? '3002', 10)
const DHT_PORT = parseInt(process.env.ATSEARCH_DHT_PORT ?? '8002', 10)
const BOOTSTRAP_PEERS = process.env.ATSEARCH_DHT_BOOTSTRAP
  ? process.env.ATSEARCH_DHT_BOOTSTRAP.split(',').map((s) => s.trim())
  : []

async function main() {
  console.log('Starting AT Search query node...')

  let dhtNode = null
  if (BOOTSTRAP_PEERS.length > 0) {
    try {
      dhtNode = await createDhtNode({
        listenPort: DHT_PORT,
        bootstrapPeers: BOOTSTRAP_PEERS,
      })
      console.log(`DHT node started. Peer ID: ${dhtNode.peerId.toString()}`)
    } catch (err) {
      console.warn('DHT failed to start, continuing without DHT:', err)
    }
  } else {
    console.log('No DHT bootstrap peers configured; running without DHT')
  }

  const fastify = await buildServer(dhtNode)
  await fastify.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`Query node HTTP server listening on port ${PORT}`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
