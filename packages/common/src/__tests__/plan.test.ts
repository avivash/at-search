import { compileExtractionPlan, executeExtractionPlan } from '../lexicon/plan'
import { deriveDescriptors } from '../descriptor'
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

describe('executeExtractionPlan', () => {
  const did = 'did:plc:abc123'

  it('extracts a full IndexedRecord from at.functions.metadata', () => {
    const plan = compileExtractionPlan(FUNCTIONS_LEXICON)!
    const rec = executeExtractionPlan(plan, did, 'rkey1', {
      name: 'echo',
      version: '1.0.0',
      description: 'Echoes **input** back',
      mode: 'pure-v1',
      entrypoint: 'run',
      updatedAt: '2026-07-01T00:00:00.000Z',
    })!
    expect(rec.$type).toBe('at.functions.metadata')
    expect(rec.title).toBe('echo')
    expect(rec.description).toContain('Echoes input back') // markdown stripped
    expect(rec.tags).toContain('pure-v1')
    expect(rec.createdAt).toBe('2026-07-01T00:00:00.000Z')
    expect(rec.author).toEqual({ did })
  })

  it('maps over arrays with * and picks http urls', () => {
    const plan = compileExtractionPlan(LINKBOARD_LEXICON)!
    const rec = executeExtractionPlan(plan, did, 'self', {
      name: 'My Links',
      links: [
        { url: 'at://did:plc:x/foo/bar', text: 'not this url' },
        { url: 'https://example.com', text: 'My homepage' },
      ],
    })!
    expect(rec.title).toBe('My Links')
    expect(rec.description).toContain('not this url')
    expect(rec.description).toContain('My homepage')
    expect(rec.url).toBe('https://example.com')
  })

  it('extracts geo and langs; deriveDescriptors emits geo + lang keys', () => {
    const plan = compileExtractionPlan(PLACE_LEXICON)!
    const rec = executeExtractionPlan(plan, did, 'r1', {
      title: 'Community Fridge',
      tags: ['Food'],
      langs: 'en-US',
      location: { lat: 49.28, lon: -123.12, geohash: 'c2b2n' },
      createdAt: '2026-01-01T00:00:00.000Z',
    })!
    expect(rec.location).toEqual({ lat: 49.28, lon: -123.12, geohash: 'c2b2n' })
    expect(rec.langs).toEqual(['en'])
    expect(rec.tags).toEqual(['food'])
    const keys = deriveDescriptors(rec)
    expect(keys).toContain('geo:c2')
    expect(keys).toContain('lang:en')
  })

  it('returns null when the record has no resolvable text', () => {
    const plan = compileExtractionPlan(WHTWND_LEXICON)!
    expect(executeExtractionPlan(plan, did, 'r1', { isDraft: true })).toBeNull()
  })

  it('falls back: title from body slice, createdAt to now, url to atproto browser', () => {
    const plan = compileExtractionPlan(WHTWND_LEXICON)!
    const rec = executeExtractionPlan(plan, did, 'r9', { content: 'Hello world, this is a post' })!
    expect(rec.title).toBe('Hello world, this is a post')
    expect(Number.isFinite(Date.parse(rec.createdAt))).toBe(true)
    expect(rec.url).toContain('https://atproto.com/at/')
    expect(rec.url).toContain(encodeURIComponent(`at://${did}/com.whtwnd.blog.entry/r9`))
  })
})
