import type { SearchResult } from '@atsearch/common'
import { tokenize } from '@atsearch/common'
import { scoreResult } from '../../rank.js'
import type { AppServices } from '../createServices.js'

/**
 * If the query is a bare DID or a single handle-shaped string, resolve the actor
 * and return their `app.bsky.actor.profile/self` as a search hit (Slingshot / XRPC).
 * This does not depend on the indexer having ingested that profile.
 */
export async function maybeProfileSearchHit(
  services: AppServices,
  rawQuery: string,
): Promise<SearchResult | null> {
  const q = rawQuery.trim()
  if (!q) return null

  let did: string | null = null

  if (/^did:[a-z0-9]+:[^/\s]+$/i.test(q)) {
    did = q
  } else {
    if (/\s/.test(q)) return null
    const handle = q.replace(/^@/, '')
    if (!/^[\w.-]+\.[\w.-]+$/.test(handle)) return null
    const resolved = await services.identity.resolveHandle(handle)
    if (resolved?.did) did = resolved.did
  }

  if (!did) return null

  const loc = await services.record.resolveLatestAtLocation(did, 'app.bsky.actor.profile', 'self')
  if (!loc) return null

  const fv = await services.record.fetchAndVerify(loc.ref)
  if (!fv.record) return null

  const record = await services.identity.enrichIndexedRecord(fv.record)
  const queryTokens = tokenize(rawQuery)
  const queryTags = queryTokens
  const matchedDescriptors: string[] = []
  for (const t of queryTokens) {
    matchedDescriptors.push(`token:${t}`)
    matchedDescriptors.push(`tag:${t}`)
  }
  if (matchedDescriptors.length === 0) {
    matchedDescriptors.push('token:profile')
  }

  const score = scoreResult({
    ref: loc.ref,
    record,
    matchedDescriptors,
    queryTokens,
    queryTags,
    verified: fv.verified,
    verificationError: fv.verificationError,
    fetchError: fv.fetchError,
    pointerExpired: false,
  })

  return {
    ref: loc.ref,
    record,
    matchedDescriptors,
    score: score + 50,
    verified: fv.verified,
    verificationError: fv.verificationError,
    fetchError: fv.fetchError,
  }
}
