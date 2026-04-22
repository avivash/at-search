import type { SearchResult } from '@atsearch/common'
import { tokenize } from '@atsearch/common'
import type { ThingRecord } from '@atsearch/common'

interface RankInput {
  ref: { uri: string; cid: string }
  record: ThingRecord | null
  matchedDescriptors: string[]
  queryTokens: string[]
  queryTags: string[]
  verified: boolean
  verificationError?: string
  fetchError?: string
  pointerExpired: boolean
}

export function scoreResult(input: RankInput): number {
  // Hard discard: record completely unavailable
  if (!input.record) return -10

  let score = 0

  const recordTokens = tokenize(
    [input.record.title, input.record.description].filter(Boolean).join(' '),
  )
  const recordTags = (input.record.tags ?? []).map((t) =>
    t.toLowerCase().replace(/\s+/g, '-'),
  )

  // +5 if every query token matches
  const allQueryTokensMatch =
    input.queryTokens.length > 0 &&
    input.queryTokens.every((qt) => recordTokens.includes(qt))
  if (allQueryTokensMatch) score += 5

  // +1 per matching token
  for (const qt of input.queryTokens) {
    if (recordTokens.includes(qt)) score += 1
  }

  // +2 per matching tag
  for (const qt of input.queryTags) {
    if (recordTags.includes(qt)) score += 2
  }

  // +2 per geohash level matched
  const geoMatches = input.matchedDescriptors.filter((d) => d.startsWith('geo:')).length
  score += geoMatches * 2

  // +1 CID verified against live PDS
  if (input.verified) score += 1

  // Penalties
  if (input.pointerExpired) score -= 3
  if (input.fetchError) score -= 2
  // verificationError without a fetch failure = CID mismatch on live PDS
  if (input.verificationError && !input.fetchError) score -= 2

  return score
}

export function rankResults(results: SearchResult[]): SearchResult[] {
  return [...results].sort((a, b) => b.score - a.score)
}
