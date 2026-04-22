import type { StrongRef, SearchResult, PointerRecordSigned } from '@atsearch/common'
import { descriptorToQueryKeys, tokenize } from '@atsearch/common'
import type { DhtNode } from '../../dht.js'
import { findProviders } from '../../dht.js'
import { scoreResult, rankResults } from '../../rank.js'
import type { AppServices } from '../createServices.js'
import type { FetchResult } from '../atproto/RecordService.js'
import { maybeProfileSearchHit } from './identityLookup.js'

export interface SearchOptions {
  query: string
  dhtNode: DhtNode | null
  indexerUrls?: string[]
  verifyRecords?: boolean
}

/**
 * App-owned search: descriptor discovery, hydration via RecordService, ranking.
 * Microcosm is used inside RecordService / IdentityService, not as a search engine.
 */
export async function runSearch(services: AppServices, opts: SearchOptions): Promise<SearchResult[]> {
  const { query } = opts
  const indexerUrls = opts.indexerUrls ?? services.env.indexerUrls

  const descriptorKeys = descriptorToQueryKeys(query)
  const queryTokens = tokenize(query)
  const queryTags = queryTokens

  const candidateMap = new Map<string, { ref: StrongRef; descriptors: Set<string>; expired: boolean }>()

  await Promise.all(
    descriptorKeys.map(async (key) => {
      const pointers = await fetchPointersForKey(key, opts.dhtNode, indexerUrls)
      const now = new Date()

      for (const ptr of pointers) {
        const refKey = `${ptr.ref.uri}::${ptr.ref.cid}`
        const expired = new Date(ptr.expiresAt) < now

        const existing = candidateMap.get(refKey)
        if (existing) {
          existing.descriptors.add(key)
          if (!expired) existing.expired = false
        } else {
          candidateMap.set(refKey, {
            ref: ptr.ref,
            descriptors: new Set([key]),
            expired,
          })
        }
      }
    }),
  )

  const hydrateMemo = new Map<string, Promise<FetchResult>>()

  const results = await Promise.all(
    Array.from(candidateMap.entries()).map(async ([, candidate]) => {
      const refKey = `${candidate.ref.uri}::${candidate.ref.cid}`
      const { record, verified, verificationError, fetchError } =
        opts.verifyRecords !== false
          ? await (() => {
              let p = hydrateMemo.get(refKey)
              if (!p) {
                p = services.record.fetchAndVerify(candidate.ref)
                hydrateMemo.set(refKey, p)
              }
              return p
            })()
          : { record: null, verified: false, verificationError: undefined, fetchError: 'verification skipped' }

      const enriched = record ? await services.identity.enrichIndexedRecord(record) : null

      const matchedDescriptors = Array.from(candidate.descriptors)

      const score = scoreResult({
        ref: candidate.ref,
        record: enriched,
        matchedDescriptors,
        queryTokens,
        queryTags,
        verified,
        verificationError,
        fetchError,
        pointerExpired: candidate.expired,
      })

      return {
        ref: candidate.ref,
        record:
          enriched ??
          ({
            $type: 'com.example.thing' as const,
            title: candidate.ref.uri,
            createdAt: new Date().toISOString(),
          } as SearchResult['record']),
        matchedDescriptors,
        score,
        verified,
        verificationError,
        fetchError,
      } satisfies SearchResult
    }),
  )

  const ranked = rankResults(results)

  const profileHit = await maybeProfileSearchHit(services, query)
  if (!profileHit) return ranked

  const k = `${profileHit.ref.uri}::${profileHit.ref.cid}`
  const deduped = ranked.filter((r) => `${r.ref.uri}::${r.ref.cid}` !== k)
  return [profileHit, ...deduped]
}

async function fetchPointersForKey(
  descriptorKey: string,
  dhtNode: DhtNode | null,
  fallbackIndexerUrls: string[],
): Promise<PointerRecordSigned[]> {
  const providerUrls: string[] = []

  if (dhtNode) {
    try {
      const peers = await findProviders(dhtNode, descriptorKey)
      if (peers.length > 0) {
        console.debug(`DHT found ${peers.length} providers for ${descriptorKey}`)
      }
    } catch {
      // non-fatal
    }
  }

  providerUrls.push(...fallbackIndexerUrls)

  const allPointers: PointerRecordSigned[] = []

  await Promise.all(
    providerUrls.map(async (base) => {
      try {
        const url = `${base}/pointers/${encodeURIComponent(descriptorKey)}`
        const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
        if (!res.ok) return
        const data = (await res.json()) as { pointers?: PointerRecordSigned[] }
        if (data.pointers) allPointers.push(...data.pointers)
      } catch {
        // provider unreachable
      }
    }),
  )

  return allPointers
}
