import { scoreResult, rankResults } from '../rank'
import { qualifiesForTextQuery } from '../services/search/SearchService'
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
    // +5 all terms, +3 'fridge' in the title, +1 verified — not a tag on this record
    expect(score).toBe(9)
    expect(sum(breakdown)).toBe(score)
    expect(breakdown.map((b) => b.reason)).toEqual(['all-terms', 'title', 'verified'])
    expect(breakdown[0]).toEqual({
      reason: 'all-terms',
      label: 'every search term matched',
      points: 5,
    })
  })

  it('names the specific term and tag that matched', () => {
    // One term, in the title and the tags, on a record verified against its PDS.
    const { score, breakdown } = scoreResult(
      input({
        record: record({ title: 'THE PERFECT BODY hamburger', tags: ['hamburger'] }),
        queryTokens: ['hamburger'],
        queryTags: ['hamburger'],
      }),
    )
    // +5 all terms, +3 title, +2 tag, +1 verified
    expect(score).toBe(11)
    expect(sum(breakdown)).toBe(score)
    expect(breakdown).toContainEqual({
      reason: 'title',
      label: '"hamburger" in the title',
      points: 3,
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

describe('qualifiesForTextQuery', () => {

  it('accepts anything when the query has no text terms (bare type: listing)', () => {
    expect(qualifiesForTextQuery(['type:at.functions.metadata'], false)).toBe(true)
  })

  it('requires a text match when the query has text terms', () => {
    // `echo type:at.functions.metadata` must not return every function in the
    // collection — only those whose text actually matched.
    expect(qualifiesForTextQuery(['type:at.functions.metadata'], true)).toBe(false)
    expect(qualifiesForTextQuery(['type:at.functions.metadata', 'token:echo'], true)).toBe(true)
    expect(qualifiesForTextQuery(['tag:echo'], true)).toBe(true)
  })

  it('counts geo and lang as non-text signals', () => {
    expect(qualifiesForTextQuery(['geo:c2', 'lang:en'], true)).toBe(false)
  })
})

describe('title relevance and stable ordering', () => {
  it('ranks a title match above a body-only match', () => {
    const titleMatch = scoreResult(
      input({
        record: record({ title: 'Potato gnocchi', description: 'Bake the potatoes.' }),
        queryTokens: ['gnocchi'],
        queryTags: ['gnocchi'],
      }),
    )
    const bodyMatch = scoreResult(
      input({
        record: record({
          title: 'Full of Flavor: How to Create Like a Chef',
          description: 'From a Vitello Tonnato Burger to Green Olive Gnocchi with Wilted Greens.',
        }),
        queryTokens: ['gnocchi'],
        queryTags: ['gnocchi'],
      }),
    )
    expect(titleMatch.score).toBeGreaterThan(bodyMatch.score)
    expect(titleMatch.breakdown).toContainEqual({
      reason: 'title',
      label: '"gnocchi" in the title',
      points: 3,
    })
    expect(bodyMatch.breakdown).toContainEqual({
      reason: 'token',
      label: '"gnocchi" in the text',
      points: 1,
    })
  })

  it('counts a term once — title wins, it does not also score as body text', () => {
    const { breakdown } = scoreResult(
      input({
        record: record({ title: 'Potato gnocchi', description: 'gnocchi gnocchi gnocchi' }),
        queryTokens: ['gnocchi'],
        queryTags: ['gnocchi'],
      }),
    )
    expect(breakdown.filter((b) => b.reason === 'title' || b.reason === 'token')).toHaveLength(1)
  })

  it('breaks score ties deterministically instead of by fetch order', () => {
    const mk = (uri: string, createdAt: string): SearchResult =>
      ({ score: 7, ref: { uri, cid: 'c' }, record: { createdAt } } as SearchResult)
    const a = mk('at://x/y/a', '2026-01-01T00:00:00.000Z')
    const b = mk('at://x/y/b', '2026-08-01T00:00:00.000Z')

    // Same inputs in either arrival order must produce the same ranking.
    expect(rankResults([a, b]).map((r) => r.ref.uri)).toEqual(rankResults([b, a]).map((r) => r.ref.uri))
    // Newer first among equal scores.
    expect(rankResults([a, b])[0].ref.uri).toBe('at://x/y/b')
  })
})
