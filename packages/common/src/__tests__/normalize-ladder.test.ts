import { normalizeRecord, hasAdapter } from '../normalize'
import { compileExtractionPlan } from '../lexicon/plan'
import { FUNCTIONS_LEXICON, WHTWND_LEXICON } from './fixtures/lexicons'

const did = 'did:plc:abc123'

describe('normalization ladder', () => {
  it('hasAdapter reflects the ADAPTERS map', () => {
    expect(hasAdapter('app.bsky.feed.post')).toBe(true)
    expect(hasAdapter('xyz.unknown.thing')).toBe(false)
  })

  it('tier 1: adapter wins over plan for known lexicons', () => {
    const plan = compileExtractionPlan(FUNCTIONS_LEXICON)!
    const rec = normalizeRecord(did, 'at.functions.metadata', 'r1',
      { name: 'echo', version: '2.0.0' }, plan)!
    // The hand adapter formats "name vVersion"; the plan tier would give bare "echo"
    expect(rec.title).toBe('echo v2.0.0')
  })

  it('tier 2: plan wins over heuristics for unknown lexicons', () => {
    const plan = compileExtractionPlan(WHTWND_LEXICON)!
    // Pretend whtwnd had no adapter by using a different collection name
    const renamed = { ...plan, nsid: 'com.unknownblog.entry' }
    const rec = normalizeRecord(did, 'com.unknownblog.entry', 'r1',
      { title: 'Post', content: 'Body text here', theme: 'github-light' }, renamed)!
    expect(rec.$type).toBe('com.unknownblog.entry')
    expect(rec.title).toBe('Post')
    expect(rec.description).toBe('Body text here')
  })

  it('tier 3: falls back to heuristics when plan resolves nothing', () => {
    const plan = compileExtractionPlan(WHTWND_LEXICON)!
    const renamed = { ...plan, nsid: 'com.unknownblog.entry' }
    // Record has none of the plan's fields but has a heuristic-probeable one
    const rec = normalizeRecord(did, 'com.unknownblog.entry', 'r1',
      { summary: 'only a summary field' }, renamed)!
    expect(rec.description).toBe('only a summary field')
  })

  it('without a plan, behavior is unchanged (generic heuristics)', () => {
    const rec = normalizeRecord(did, 'xyz.unknown.thing', 'r1', { title: 'Hi' })!
    expect(rec.title).toBe('Hi')
  })
})
