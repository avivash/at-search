import type { ScoreComponent, SearchResult } from '@atsearch/common'
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

export interface ScoredResult {
  score: number
  breakdown: ScoreComponent[]
}

/**
 * Score a candidate and explain the outcome.
 *
 * `score` is the sum of `breakdown`, never computed separately — so the number
 * shown in the UI and the reasons listed beside it can never disagree.
 */
export function scoreResult(input: RankInput): ScoredResult {
  // Hard discard: record completely unavailable
  if (!input.record) {
    return {
      score: -10,
      breakdown: [{ reason: 'unavailable', label: 'record unavailable', points: -10 }],
    }
  }

  const breakdown: ScoreComponent[] = []

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
  if (allQueryTokensMatch) {
    breakdown.push({ reason: 'all-terms', label: 'every search term matched', points: 5 })
  }

  // +1 per matching token
  for (const qt of input.queryTokens) {
    if (recordTokens.includes(qt)) {
      breakdown.push({ reason: 'token', label: `"${qt}" in the text`, points: 1 })
    }
  }

  // +2 per matching tag
  for (const qt of input.queryTags) {
    if (recordTags.includes(qt)) {
      breakdown.push({ reason: 'tag', label: `tagged "${qt}"`, points: 2 })
    }
  }

  // +2 per geohash level matched (levels aren't individually meaningful; report once)
  const geoMatches = input.matchedDescriptors.filter((d) => d.startsWith('geo:')).length
  if (geoMatches > 0) {
    breakdown.push({ reason: 'geo', label: 'location match', points: geoMatches * 2 })
  }

  // +1 CID verified against live PDS
  if (input.verified) {
    breakdown.push({ reason: 'verified', label: 'verified against the PDS', points: 1 })
  }

  // Penalties
  if (input.pointerExpired) {
    breakdown.push({ reason: 'pointer-expired', label: 'index entry expired', points: -3 })
  }
  if (input.fetchError) {
    breakdown.push({ reason: 'fetch-error', label: 'record could not be fetched', points: -2 })
  }
  // verificationError without a fetch failure = CID mismatch on live PDS
  if (input.verificationError && !input.fetchError) {
    breakdown.push({ reason: 'cid-mismatch', label: 'record changed since indexing', points: -2 })
  }

  return { score: breakdown.reduce((n, p) => n + p.points, 0), breakdown }
}

export function rankResults(results: SearchResult[]): SearchResult[] {
  return [...results].sort((a, b) => b.score - a.score)
}
