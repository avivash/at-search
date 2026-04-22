import Fastify from 'fastify'
import cors from '@fastify/cors'
import { createServices } from './services/createServices.js'
import { runSearch } from './services/search/SearchService.js'
import type { DhtNode } from './dht.js'
import { getNodePeerId } from './dht.js'

const services = createServices()

export async function buildServer(dhtNode: DhtNode | null) {
  const fastify = Fastify({ logger: true })

  await fastify.register(cors, { origin: true })

  fastify.get('/health', async () => ({
    status: 'ok',
    peerId: dhtNode ? getNodePeerId(dhtNode) : null,
    indexerUrls: services.env.indexerUrls,
    microcosm: {
      useMicrocosm: services.env.useMicrocosm,
      slingshotConfigured: Boolean(services.env.slingshotBaseUrl),
      constellationConfigured: Boolean(services.env.constellationBaseUrl),
    },
  }))

  fastify.get<{ Querystring: { q?: string } }>('/search', async (request, reply) => {
    const q = request.query.q
    if (!q || q.trim().length === 0) {
      return reply.status(400).send({ error: 'Missing query parameter: q' })
    }

    const start = Date.now()
    const results = await runSearch(services, {
      query: q.trim(),
      dhtNode,
      indexerUrls: services.env.indexerUrls,
      verifyRecords: true,
    })
    const took = Date.now() - start

    return {
      query: q.trim(),
      results,
      took,
    }
  })

  fastify.get<{ Querystring: { uri?: string; cid?: string } }>(
    '/resolve',
    async (request, reply) => {
      const { uri, cid } = request.query
      if (!uri || !cid) {
        return reply.status(400).send({ error: 'Missing required params: uri, cid' })
      }

      const result = await services.record.fetchAndVerify({ uri, cid })

      if (!result.record) {
        return reply.status(404).send({
          error: result.fetchError ?? 'Record not found',
        })
      }

      return {
        ref: { uri, cid },
        record: result.record,
        verified: result.verified,
        verificationError: result.verificationError,
        hydrationSource: result.hydrationSource,
      }
    },
  )

  /** Constellation-backed likes/replies for a Bluesky post (at-uri). */
  fastify.get<{ Querystring: { subjectUri?: string } }>(
    '/interactions',
    async (request, reply) => {
      const subjectUri = request.query.subjectUri?.trim()
      if (!subjectUri?.startsWith('at://')) {
        return reply.status(400).send({ error: 'Missing or invalid subjectUri (expected at://…)' })
      }

      try {
        const data = await services.backlinks.getPostInteractions(subjectUri)
        return data
      } catch (err) {
        request.log.warn({ err }, 'interactions partial failure')
        return reply.status(200).send({
          subjectUri,
          likeSamples: [],
          replySamples: [],
          partialErrors: [(err as Error).message],
        })
      }
    },
  )

  return fastify
}
