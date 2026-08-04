import Fastify from 'fastify'
import type Database from 'better-sqlite3'
import {
  signPointer,
  hexToKey,
  generateKeypair,
  derivePublicKey,
  privateKeyToHex,
  publicKeyToHex,
} from '@atsearch/common'
import type { PointerRecord } from '@atsearch/common'
import { getPointersByDescriptor, getAllDescriptorKeys, listLexicons, listLexiconPlans } from './db.js'
import { lexiconMeta, adapterNsids } from '@atsearch/common'
import type { DhtNode } from './dht.js'
import { getNodePeerId } from './dht.js'

const POINTER_TTL_HOURS = 24

export interface ServerConfig {
  db: Database.Database
  dhtNode: DhtNode
  port: number
  privateKeyHex?: string
}

export async function buildServer(config: ServerConfig) {
  let privateKey: Uint8Array
  let publicKey: Uint8Array

  if (config.privateKeyHex) {
    privateKey = hexToKey(config.privateKeyHex)
    publicKey = derivePublicKey(privateKey)
    console.log('Using persisted signing key. Public key:', publicKeyToHex(publicKey))
  } else {
    const kp = generateKeypair()
    privateKey = kp.privateKey
    publicKey = kp.publicKey
    console.log('Generated ephemeral signing key. Set ATSEARCH_NODE_KEY to persist.')
    console.log('Public key:', publicKeyToHex(publicKey))
    console.log('Private key (save as ATSEARCH_NODE_KEY):', privateKeyToHex(privateKey))
  }

  const fastify = Fastify({ logger: true })

  fastify.get('/health', async () => ({
    status: 'ok',
    peerId: getNodePeerId(config.dhtNode),
    publicKey: publicKeyToHex(publicKey),
  }))

  fastify.get<{ Params: { descriptorKey: string } }>(
    '/pointers/:descriptorKey',
    async (request) => {
      const { descriptorKey } = request.params
      const rows = getPointersByDescriptor(config.db, descriptorKey)

      const now = new Date()
      const expiresAt = new Date(now.getTime() + POINTER_TTL_HOURS * 3600 * 1000).toISOString()
      const peerId = getNodePeerId(config.dhtNode)

      const pointers = await Promise.all(
        rows.map(async (row) => {
          const base: Omit<PointerRecord, 'signature'> = {
            version: 1,
            descriptorKey,
            ref: { uri: row.uri, cid: row.cid },
            providerPeerId: peerId,
            indexedAt: row.indexed_at,
            expiresAt,
          }
          return signPointer(base, privateKey)
        }),
      )

      return { descriptorKey, pointers }
    },
  )

  fastify.get('/descriptors', async () => {
    const keys = getAllDescriptorKeys(config.db)
    return { keys }
  })

  // Lexicon registry metadata: which collections this indexer understands and how.
  // `?plans=1` includes the compiled extraction plan — the query node mirrors
  // these so it normalises hydrated records the same way the indexer did.
  fastify.get<{ Querystring: { plans?: string } }>('/lexicons', async (request) => {
    const withPlans = request.query.plans === '1' || request.query.plans === 'true'
    // Plan mirroring only needs nsid + plan; skip the heavy row read entirely.
    if (withPlans) {
      return {
        lexicons: listLexiconPlans(config.db).map((r) => ({
          nsid: r.nsid,
          plan: JSON.parse(r.plan_json),
        })),
      }
    }
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

  // Cache fallback: serve stored record JSON when AT Proto is unreachable.
  // The response is explicitly marked as a local cache — NOT authoritative.
  fastify.get<{ Querystring: { uri?: string } }>('/record', async (request, reply) => {
    const { uri } = request.query
    if (!uri) return reply.status(400).send({ error: 'Missing uri' })

    const row = config.db
      .prepare('SELECT json, cid, indexed_at FROM records WHERE uri = ?')
      .get(uri) as { json: string; cid: string; indexed_at: string } | undefined

    if (!row) return reply.status(404).send({ error: 'Record not found in local cache' })

    return {
      uri,
      cid: row.cid,
      record: JSON.parse(row.json),
      source: 'local-cache',
      indexedAt: row.indexed_at,
    }
  })

  return fastify
}

export async function startServer(config: ServerConfig): Promise<void> {
  const fastify = await buildServer(config)
  await fastify.listen({ port: config.port, host: '0.0.0.0' })
}
