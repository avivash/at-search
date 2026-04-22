import {
  parseAtUri,
  normalizeRecord,
  type IndexedRecord,
  type StrongRef,
} from '@atsearch/common'
import type { MicrocosmEnv } from '../env.js'
import { logFetch, type FetchBackend } from '../fetchLog.js'
import { TtlCache } from '../ttlCache.js'
import { SlingshotProvider, type SlingshotGetRecordResponse } from '../providers/slingshot.js'
import { xrpcGet } from '../providers/xrpcClient.js'
import { resolvePds } from './pdsResolve.js'

export interface FetchResult {
  record: IndexedRecord | null
  verified: boolean
  verificationError?: string
  fetchError?: string
  hydrationSource?: FetchBackend
}

interface VerificationResult {
  found: boolean
  cidMatch: boolean
  liveCid?: string
}

type CachedLoc = { record: IndexedRecord; cid: string; source: FetchBackend }

export class RecordService {
  private slingshot: SlingshotProvider | null
  private locationCache: TtlCache<CachedLoc>

  constructor(private env: MicrocosmEnv) {
    this.slingshot = env.slingshotBaseUrl
      ? new SlingshotProvider(env.slingshotBaseUrl, env.appUserAgent)
      : null
    this.locationCache = new TtlCache(60_000)
  }

  /**
   * Latest record at repo location (Slingshot → fallback XRPC → indexer).
   * Used to attach cid to Constellation backlink rows.
   */
  async resolveLatestAtLocation(
    did: string,
    collection: string,
    rkey: string,
  ): Promise<{ ref: StrongRef; record: IndexedRecord; hydrationSource: FetchBackend } | null> {
    const cacheKey = `${did}|${collection}|${rkey}`
    const hit = this.locationCache.get(cacheKey)
    if (hit) {
      return {
        ref: { uri: `at://${did}/${collection}/${rkey}`, cid: hit.cid },
        record: hit.record,
        hydrationSource: hit.source,
      }
    }

    const fromNet = await this.fetchRawFromNetwork(did, collection, rkey)
    if (fromNet?.cid) {
      const rec = normalizeRecord(did, collection, rkey, fromNet.payload)
      const ref = { uri: `at://${did}/${collection}/${rkey}`, cid: fromNet.cid }
      const display =
        rec ??
        ({
          $type: collection,
          title: `${collection.split('.').pop() ?? 'record'} · ${rkey.slice(0, 12)}…`,
          description: undefined,
          author: { did },
          createdAt: new Date().toISOString(),
        } satisfies IndexedRecord)
      this.locationCache.set(cacheKey, { record: display, cid: fromNet.cid, source: fromNet.source })
      return { ref, record: display, hydrationSource: fromNet.source }
    }

    const row = await this.fetchFromIndexerCacheByUri(`at://${did}/${collection}/${rkey}`)
    if (row?.record && row.cid) {
      const ref = { uri: `at://${did}/${collection}/${rkey}`, cid: row.cid }
      this.locationCache.set(cacheKey, { record: row.record, cid: row.cid, source: 'indexer-cache' })
      return { ref, record: row.record, hydrationSource: 'indexer-cache' }
    }

    return null
  }

  /**
   * Fetch and verify a record by strong ref (uri + cid).
   * Order: Slingshot → direct XRPC (fallback host + PDS) → indexer cache.
   */
  async fetchAndVerify(ref: StrongRef): Promise<FetchResult> {
    const { did, collection, rkey } = parseAtUri(ref.uri)

    const fromNet = await this.fetchRawFromNetwork(did, collection, rkey)
    if (fromNet && fromNet.cid === ref.cid) {
      const rec = normalizeRecord(did, collection, rkey, fromNet.payload)
      if (rec) {
        logFetch('record', fromNet.source, ref.uri)
        return this.applyPdsVerification(ref, rec, fromNet.source)
      }
    }

    const cached = await this.fetchFromIndexerCacheByUri(ref.uri)
    if (cached?.record) {
      logFetch('record', 'indexer-cache', ref.uri)
      const cidMatch = cached.cid === ref.cid
      if (!cidMatch) {
        return {
          record: cached.record,
          verified: false,
          hydrationSource: 'indexer-cache',
          verificationError: `Cache CID ${(cached.cid ?? '').slice(0, 12)}… differs from pointer CID ${ref.cid.slice(0, 12)}…`,
        }
      }
      return this.applyPdsVerification(ref, cached.record, 'indexer-cache')
    }

    return {
      record: null,
      verified: false,
      fetchError: `Could not resolve record for ${ref.uri}`,
    }
  }

  private async applyPdsVerification(
    ref: StrongRef,
    record: IndexedRecord,
    hydrationSource: FetchBackend,
  ): Promise<FetchResult> {
    try {
      const { did, collection, rkey } = parseAtUri(ref.uri)
      const pdsUrl = await resolvePds(did)
      if (pdsUrl) {
        const verification = await verifyCidOnPds(pdsUrl, did, collection, rkey, ref.cid, this.env.appUserAgent)
        if (verification.cidMatch) {
          return { record, verified: true, hydrationSource }
        }
        if (verification.found && !verification.cidMatch) {
          return {
            record,
            verified: false,
            hydrationSource,
            verificationError: `CID mismatch: indexed ${ref.cid.slice(0, 12)}… but PDS returned ${(verification.liveCid ?? '?').slice(0, 12)}…`,
          }
        }
        if (!verification.found) {
          return {
            record,
            verified: false,
            hydrationSource,
            verificationError: 'Record no longer found on PDS (may have been deleted)',
          }
        }
      }
    } catch {
      // non-fatal
    }

    return {
      record,
      verified: false,
      hydrationSource,
      fetchError: 'PDS unreachable — content unverified against live repo',
    }
  }

  private async fetchRawFromNetwork(
    did: string,
    collection: string,
    rkey: string,
  ): Promise<{ payload: unknown; cid: string; source: FetchBackend } | null> {
    if (this.env.useMicrocosm && this.slingshot) {
      const body = await this.slingshot.getRecord(did, collection, rkey)
      const parsed = parseGetRecordBody(body)
      if (parsed?.cid && (parsed.value ?? parsed.record)) {
        logFetch('record', 'slingshot', `at://${did}/${collection}/${rkey}`)
        return {
          payload: parsed.value ?? parsed.record,
          cid: parsed.cid,
          source: 'slingshot',
        }
      }
    }

    const fb = await this.tryGetRecordOnHost(this.env.fallbackAtprotoXrpcBaseUrl, did, collection, rkey)
    if (fb) {
      logFetch('record', 'atproto-fallback', this.env.fallbackAtprotoXrpcBaseUrl)
      return { ...fb, source: 'atproto-fallback' }
    }

    const pdsUrl = await resolvePds(did)
    if (pdsUrl) {
      const onPds = await this.tryGetRecordOnHost(pdsUrl, did, collection, rkey)
      if (onPds) {
        logFetch('record', 'atproto-fallback', pdsUrl)
        return { ...onPds, source: 'atproto-fallback' }
      }
    }

    return null
  }

  private async tryGetRecordOnHost(
    host: string,
    did: string,
    collection: string,
    rkey: string,
  ): Promise<{ payload: unknown; cid: string } | null> {
    try {
      const body = await xrpcGet<SlingshotGetRecordResponse>(
        host,
        'com.atproto.repo.getRecord',
        { repo: did, collection, rkey },
        this.env.appUserAgent,
      )
      const parsed = parseGetRecordBody(body)
      if (!parsed?.cid || !(parsed.value ?? parsed.record)) return null
      return { payload: parsed.value ?? parsed.record, cid: parsed.cid }
    } catch {
      return null
    }
  }

  private async fetchFromIndexerCacheByUri(uri: string): Promise<{
    record: IndexedRecord | null
    cid?: string
  } | null> {
    for (const base of this.env.indexerUrls) {
      try {
        const url = `${base}/record?uri=${encodeURIComponent(uri)}`
        const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
        if (!res.ok) continue
        const data = (await res.json()) as { record?: IndexedRecord; cid?: string }
        if (!data.record) continue
        return { record: data.record, cid: data.cid }
      } catch {
        // next
      }
    }
    return null
  }
}

function parseGetRecordBody(body: SlingshotGetRecordResponse | null): {
  cid: string
  value?: unknown
  record?: unknown
} | null {
  if (!body?.cid) return null
  return { cid: body.cid, value: body.value, record: body.record }
}

async function verifyCidOnPds(
  pdsUrl: string,
  did: string,
  collection: string,
  rkey: string,
  expectedCid: string,
  userAgent: string,
): Promise<VerificationResult> {
  try {
    const url = `${pdsUrl}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent },
      signal: AbortSignal.timeout(8_000),
    })
    if (res.status === 404) return { found: false, cidMatch: false }
    if (!res.ok) throw new Error(`PDS returned HTTP ${res.status}`)
    const json = (await res.json()) as { cid?: string }
    const liveCid = json.cid
    return { found: true, cidMatch: liveCid === expectedCid, liveCid }
  } catch {
    return { found: false, cidMatch: false }
  }
}
