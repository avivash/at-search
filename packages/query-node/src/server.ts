import Fastify from 'fastify'
import cors from '@fastify/cors'
import { createServices } from './services/createServices.js'
import { runSearch } from './services/search/SearchService.js'
import type { DhtNode } from './dht.js'
import { getNodePeerId } from './dht.js'

const services = createServices()

function normalizeHostname(input: string): string | null {
  let s = input.trim()
  if (!s) return null

  // Allow users to paste full URLs; extract hostname.
  try {
    if (/^https?:\/\//i.test(s)) {
      s = new URL(s).hostname
    }
  } catch {
    // ignore parse failure; fall back to best-effort below
  }

  s = s.trim().toLowerCase()
  if (!s) return null
  // Best-effort cleanup if someone pasted a path or port without a scheme.
  s = s.split('/')[0] ?? s
  s = s.split(':')[0] ?? s
  s = s.replace(/^@+/, '')

  // Hostname only (no scheme, no path)
  if (s.includes('://') || s.includes('@') || s.includes('?') || s.includes('#')) return null
  if (s === 'localhost' || s.endsWith('.localhost')) return null
  // Basic “looks like a DNS name” check
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s)) return null
  return s
}

function makeRateLimiter(opts?: { windowMs?: number; max?: number }) {
  const windowMs = opts?.windowMs ?? 60_000
  const max = opts?.max ?? 10
  const hits = new Map<string, number[]>()
  return {
    check(key: string): { allowed: boolean; retryAfterMs: number } {
      const now = Date.now()
      const arr = hits.get(key) ?? []
      const fresh = arr.filter((t) => now - t < windowMs)
      if (fresh.length >= max) {
        const oldest = fresh[0] ?? now
        const retryAfterMs = Math.max(0, windowMs - (now - oldest))
        hits.set(key, fresh)
        return { allowed: false, retryAfterMs }
      }
      fresh.push(now)
      hits.set(key, fresh)
      return { allowed: true, retryAfterMs: 0 }
    },
  }
}

export async function buildServer(dhtNode: DhtNode | null) {
  const fastify = Fastify({ logger: true })

  await fastify.register(cors, { origin: true })

  const crawlLimiter = makeRateLimiter({
    windowMs: parseInt(process.env.ATSEARCH_CRAWL_WINDOW_MS ?? '60000', 10),
    max: parseInt(process.env.ATSEARCH_CRAWL_MAX_PER_WINDOW ?? '6', 10),
  })

  fastify.get('/health', async () => ({
    status: 'ok',
    peerId: dhtNode ? getNodePeerId(dhtNode) : null,
    indexerUrls: services.env.indexerUrls,
    microcosm: {
      useMicrocosm: services.env.useMicrocosm,
      slingshotConfigured: Boolean(services.env.slingshotBaseUrl),
      constellationConfigured: Boolean(services.env.constellationBaseUrl),
    },
    crawl: {
      configured: Boolean(process.env.ATSEARCH_RELAY_ADMIN_PASSWORD),
      relayAdminUrl: (process.env.ATSEARCH_RELAY_ADMIN_URL ?? 'http://relay:2470').replace(/\/$/, ''),
    },
  }))

  fastify.post<{ Body: { hostname?: string } }>(
    '/crawl',
    async (request, reply) => {
      if (!process.env.ATSEARCH_RELAY_ADMIN_PASSWORD) {
        return reply.status(503).send({ error: 'Crawl submissions not configured on this server' })
      }

      const ip = request.ip || 'unknown'
      const rate = crawlLimiter.check(ip)
      if (!rate.allowed) {
        reply.header('Retry-After', Math.ceil(rate.retryAfterMs / 1000))
        return reply.status(429).send({ error: 'Rate limited. Try again shortly.' })
      }

      const hostname = normalizeHostname(request.body?.hostname ?? '')
      if (!hostname) {
        return reply.status(400).send({ error: 'Invalid hostname (expected: pds.example.com)' })
      }

      const relayAdminUrl = (process.env.ATSEARCH_RELAY_ADMIN_URL ?? 'http://relay:2470').replace(/\/$/, '')
      const auth = Buffer.from(`admin:${process.env.ATSEARCH_RELAY_ADMIN_PASSWORD}`, 'utf8').toString('base64')

      try {
        const res = await fetch(`${relayAdminUrl}/admin/pds/requestCrawl`, {
          method: 'POST',
          headers: {
            authorization: `Basic ${auth}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ hostname }),
        })

        const text = await res.text().catch(() => '')
        if (!res.ok) {
          request.log.warn({ status: res.status, hostname, body: text.slice(0, 300) }, 'crawl request failed')
          return reply.status(502).send({ error: `Relay rejected crawl (${res.status})` })
        }

        return reply.send({
          status: 'ok',
          hostname,
          relayResponse: text ? safeJson(text) : null,
        })
      } catch (err) {
        request.log.warn({ err, hostname }, 'crawl request error')
        return reply.status(502).send({ error: (err as Error).message })
      }
    },
  )

  fastify.get<{ Querystring: { q?: string; collection?: string } }>(
    '/search',
    async (request, reply) => {
      const q = request.query.q
      if (!q || q.trim().length === 0) {
        return reply.status(400).send({ error: 'Missing query parameter: q' })
      }

      const collection = request.query.collection?.trim()
      const needle =
        collection && collection.length > 0 ? `/${collection}/` : null

      const start = Date.now()
      let results = await runSearch(services, {
        query: q.trim(),
        dhtNode,
        indexerUrls: services.env.indexerUrls,
        verifyRecords: true,
      })

      if (needle) {
        results = results.filter((r) => r.ref.uri.includes(needle))
      }

      const took = Date.now() - start

      return {
        query: q.trim(),
        ...(collection ? { collection } : {}),
        results,
        took,
      }
    },
  )

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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
