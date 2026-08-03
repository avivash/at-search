import { scoreResult, rankResults } from '../rank'
import type { IndexedRecord, SearchResult } from '@atsearch/common'

const record = (overrides: Partial<IndexedRecord> = {}): IndexedRecord => ({
  $type: 'app.bsky.feed.post',
  title: 'Community fridge in Vancouver',
  description: 'A mutual aid fridge for sharing food',
  tags: ['hamburger'],
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const input = (overrides: Record<string, unknown> = {}) => ({
  ref: { uri: 'at://did:plc:abc/app.bsky.feed.post/1', cid: 'bafy1' },
  record: record(),
  matchedDescriptors: [] as string[],
  queryTokens: ['fridge'],
  queryTags: ['fridge'],
  verified: true,
  pointerExpired: false,
  ...overrides,
})

/** Sum of a breakdown must always equal the reported score. */
const sum = (parts: Array<{ points: number }>) =>
  parts.reduce((n, p) => n + p.points, 0)

describe('scoreResult breakdown', () => {
  it('explains a fully-matching verified result and totals correctly', () => {
    const { score, breakdown } = scoreResult(input())
    // +5 all terms, +1 token, +1 verified — 'fridge' is not a tag on this record
    expect(score).toBe(7)
    expect(sum(breakdown)).toBe(score)
    expect(breakdown.map((b) => b.reason)).toEqual(['all-terms', 'token', 'verified'])
    expect(breakdown[0]).toEqual({
      reason: 'all-terms',
      label: 'every search term matched',
      points: 5,
    })
  })

  it('names the specific term and tag that matched', () => {
    // The +9 case from the live UI: one term, present in both text and tags,
    // on a record verified against its PDS.
    const { score, breakdown } = scoreResult(
      input({
        record: record({ title: 'THE PERFECT BODY hamburger', tags: ['hamburger'] }),
        queryTokens: ['hamburger'],
        queryTags: ['hamburger'],
      }),
    )
    // +5 all terms, +1 token, +2 tag, +1 verified — the screenshot case
    expect(score).toBe(9)
    expect(sum(breakdown)).toBe(score)
    expect(breakdown).toContainEqual({
      reason: 'token',
      label: '"hamburger" in the text',
      points: 1,
    })
    expect(breakdown).toContainEqual({
      reason: 'tag',
      label: 'tagged "hamburger"',
      points: 2,
    })
  })

  it('aggregates geohash levels into one entry', () => {
    const { breakdown } = scoreResult(
      input({ matchedDescriptors: ['geo:c2', 'geo:c2b2', 'geo:c2b2n'] }),
    )
    const geo = breakdown.filter((b) => b.reason === 'geo')
    expect(geo).toHaveLength(1)
    expect(geo[0]).toEqual({ reason: 'geo', label: 'location match', points: 6 })
  })

  it('explains penalties and keeps the total consistent', () => {
    const { score, breakdown } = scoreResult(
      input({ verified: false, pointerExpired: true, fetchError: 'timeout' }),
    )
    expect(sum(breakdown)).toBe(score)
    expect(breakdown).toContainEqual({
      reason: 'pointer-expired',
      label: 'index entry expired',
      points: -3,
    })
    expect(breakdown).toContainEqual({
      reason: 'fetch-error',
      label: 'record could not be fetched',
      points: -2,
    })
    expect(breakdown.some((b) => b.reason === 'verified')).toBe(false)
  })

  it('flags a CID mismatch only when the fetch itself succeeded', () => {
    const mismatch = scoreResult(input({ verified: false, verificationError: 'cid mismatch' }))
    expect(mismatch.breakdown).toContainEqual({
      reason: 'cid-mismatch',
      label: 'record changed since indexing',
      points: -2,
    })

    const unfetchable = scoreResult(
      input({ verified: false, verificationError: 'cid mismatch', fetchError: 'timeout' }),
    )
    expect(unfetchable.breakdown.some((b) => b.reason === 'cid-mismatch')).toBe(false)
  })

  it('discards unavailable records with a single explanation', () => {
    const { score, breakdown } = scoreResult(input({ record: null }))
    expect(score).toBe(-10)
    expect(breakdown).toEqual([
      { reason: 'unavailable', label: 'record unavailable', points: -10 },
    ])
  })
})

describe('rankResults', () => {
  it('sorts by score descending', () => {
    const mk = (score: number): SearchResult =>
      ({ score, ref: { uri: `at://x/y/${score}`, cid: 'c' } }) as SearchResult
    expect(rankResults([mk(1), mk(9), mk(5)]).map((r) => r.score)).toEqual([9, 5, 1])
  })
})
