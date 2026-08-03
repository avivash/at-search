import { compileExtractionPlan } from '../lexicon/plan'
import {
  LIKE_LEXICON,
  WHTWND_LEXICON,
  FUNCTIONS_LEXICON,
  FRONTPAGE_LEXICON,
  LINKBOARD_LEXICON,
  PLACE_LEXICON,
  QUERY_LEXICON,
} from './fixtures/lexicons'

describe('compileExtractionPlan', () => {
  it('returns null for non-record lexicons', () => {
    expect(compileExtractionPlan(QUERY_LEXICON)).toBeNull()
    expect(compileExtractionPlan(null)).toBeNull()
    expect(compileExtractionPlan({ lexicon: 1 })).toBeNull()
  })

  it('marks text-free collections as not indexable (triage)', () => {
    const plan = compileExtractionPlan(LIKE_LEXICON)!
    expect(plan.nsid).toBe('app.bsky.feed.like')
    expect(plan.indexable).toBe(false)
    expect(plan.title).toEqual([])
    expect(plan.body).toEqual([])
    // datetime is still recognized, but dates alone are not searchable text
    expect(plan.createdAt).toEqual([['createdAt']])
  })

  it('classifies whtwnd blog: named title/body win, enums and refs skipped', () => {
    const plan = compileExtractionPlan(WHTWND_LEXICON)!
    expect(plan.indexable).toBe(true)
    expect(plan.title[0]).toEqual(['title'])
    expect(plan.body[0]).toEqual(['content'])
    // subtitle: unnamed-match, maxLength 1000 > 256 → body candidate after named ones
    expect(plan.body).toContainEqual(['subtitle'])
    // enum strings (theme, visibility) are closed config sets → skipped entirely
    expect(plan.tags).toEqual([])
    const all = [...plan.title, ...plan.body, ...plan.tags]
    expect(all).not.toContainEqual(['theme'])
    expect(all).not.toContainEqual(['visibility'])
  })

  it('classifies at.functions.metadata: knownValues→tags, const skipped, updatedAt→date', () => {
    const plan = compileExtractionPlan(FUNCTIONS_LEXICON)!
    expect(plan.indexable).toBe(true)
    expect(plan.title[0]).toEqual(['name'])
    expect(plan.body).toContainEqual(['description'])
    expect(plan.tags).toContainEqual(['mode'])
    expect(plan.createdAt).toContainEqual(['updatedAt'])
    const all = [...plan.title, ...plan.body, ...plan.tags]
    expect(all).not.toContainEqual(['entrypoint']) // const
    expect(all).not.toContainEqual(['code'])       // blob
  })

  it('classifies frontpage: format uri → url, not text', () => {
    const plan = compileExtractionPlan(FRONTPAGE_LEXICON)!
    expect(plan.title[0]).toEqual(['title'])
    expect(plan.url).toEqual([['url']])
    expect(plan.body).toEqual([])
  })

  it('descends into arrays of objects with a * segment', () => {
    const plan = compileExtractionPlan(LINKBOARD_LEXICON)!
    expect(plan.title[0]).toEqual(['name'])
    expect(plan.body).toContainEqual(['links', '*', 'text'])
    expect(plan.url).toContainEqual(['links', '*', 'url'])
  })

  it('detects geo pairs, language format, machine formats, and string-array tags', () => {
    const plan = compileExtractionPlan(PLACE_LEXICON)!
    expect(plan.geo).toEqual({
      lat: ['location', 'lat'],
      lon: ['location', 'lon'],
      geohash: ['location', 'geohash'],
    })
    expect(plan.tags).toContainEqual(['tags'])
    expect(plan.langs).toEqual([['langs']])
    const all = [...plan.title, ...plan.body]
    expect(all).not.toContainEqual(['author'])              // format: did
    expect(all).not.toContainEqual(['location', 'geohash']) // never-text name
  })
})
