import { deriveDescriptors, descriptorToQueryKeys, hashDescriptorKey, parseQuery, tokenize } from '../descriptor'
import type { ThingRecord } from '../types'

const makeRecord = (overrides: Partial<ThingRecord> = {}): ThingRecord => ({
  $type: 'com.example.thing',
  title: 'Community Fridge in Vancouver',
  description: 'A mutual aid fridge for sharing food',
  tags: ['food', 'mutual-aid', 'community'],
  location: {
    lat: 49.2827,
    lon: -123.1207,
    geohash: 'c2b2n',
  },
  createdAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

describe('tokenize', () => {
  it('lowercases and splits', () => {
    expect(tokenize('Hello World')).toContain('hello')
    expect(tokenize('Hello World')).toContain('world')
  })

  it('removes stopwords', () => {
    expect(tokenize('a the and for')).toEqual([])
  })

  it('removes short tokens', () => {
    expect(tokenize('ab x')).toEqual(['ab'])
  })

  it('removes punctuation', () => {
    expect(tokenize('food, fridge!')).toContain('food')
    expect(tokenize('food, fridge!')).toContain('fridge')
  })
})

describe('deriveDescriptors', () => {
  it('includes type descriptor', () => {
    const keys = deriveDescriptors(makeRecord())
    expect(keys).toContain('type:com.example.thing')
  })

  it('includes tag descriptors', () => {
    const keys = deriveDescriptors(makeRecord())
    expect(keys).toContain('tag:food')
    expect(keys).toContain('tag:mutual-aid')
    expect(keys).toContain('tag:community')
  })

  it('normalizes tags to lowercase with dashes', () => {
    const keys = deriveDescriptors(makeRecord({ tags: ['Mutual Aid', 'FOOD'] }))
    expect(keys).toContain('tag:mutual-aid')
    expect(keys).toContain('tag:food')
  })

  it('includes token descriptors from title', () => {
    const keys = deriveDescriptors(makeRecord())
    expect(keys).toContain('token:community')
    expect(keys).toContain('token:fridge')
    expect(keys).toContain('token:vancouver')
  })

  it('includes geohash prefix descriptors', () => {
    const keys = deriveDescriptors(makeRecord())
    expect(keys).toContain('geo:c2')
    expect(keys).toContain('geo:c2b2')
    expect(keys).toContain('geo:c2b2n')
  })

  it('handles missing optional fields gracefully', () => {
    const keys = deriveDescriptors(makeRecord({ tags: undefined, description: undefined, location: undefined }))
    expect(keys).toContain('type:com.example.thing')
    expect(keys.some((k) => k.startsWith('token:'))).toBe(true)
  })

  it('deduplicates descriptors', () => {
    const keys = deriveDescriptors(makeRecord({ title: 'food food food' }))
    const tokenFoodCount = keys.filter((k) => k === 'token:food').length
    expect(tokenFoodCount).toBe(1)
  })
})

describe('descriptorToQueryKeys', () => {
  it('does not infer type: keys from free-text alone', () => {
    const keys = descriptorToQueryKeys('fridge food')
    expect(keys.some((k) => k.startsWith('type:'))).toBe(false)
  })

  it('accepts explicit type:<nsid> for lexicon-scoped listing', () => {
    const keys = descriptorToQueryKeys('type:at.functions.metadata')
    expect(keys).toContain('type:at.functions.metadata')
    expect(keys.some((k) => k.startsWith('token:') || k.startsWith('tag:'))).toBe(false)
  })

  it('accepts collection: as an alias for type:', () => {
    const keys = descriptorToQueryKeys('collection:at.functions.metadata')
    expect(keys).toContain('type:at.functions.metadata')
    expect(keys.some((k) => k.startsWith('token:') || k.startsWith('tag:'))).toBe(false)
  })

  it('generates both token and tag candidates', () => {
    const keys = descriptorToQueryKeys('food fridge')
    expect(keys).toContain('token:food')
    expect(keys).toContain('tag:food')
    expect(keys).toContain('token:fridge')
    expect(keys).toContain('tag:fridge')
  })
})

describe('parseQuery', () => {
  it('plain text has no filter', () => {
    expect(parseQuery('community fridge')).toEqual({ text: 'community fridge' })
  })

  it('bare type: filter', () => {
    expect(parseQuery('type:at.functions.metadata')).toEqual({
      typeFilter: 'at.functions.metadata',
      text: '',
    })
  })

  it('type: combined with free text, anywhere in the query', () => {
    expect(parseQuery('resize image type:at.functions.metadata')).toEqual({
      typeFilter: 'at.functions.metadata',
      text: 'resize image',
    })
    expect(parseQuery('collection:com.whtwnd.blog.entry svelte tips')).toEqual({
      typeFilter: 'com.whtwnd.blog.entry',
      text: 'svelte tips',
    })
  })
})

describe('descriptorToQueryKeys with type filter', () => {
  it('bare type: yields only the type key (unchanged behavior)', () => {
    expect(descriptorToQueryKeys('type:at.functions.metadata')).toEqual([
      'type:at.functions.metadata',
    ])
  })

  it('type + text yields type key AND token/tag keys', () => {
    const keys = descriptorToQueryKeys('resize type:at.functions.metadata')
    expect(keys).toContain('type:at.functions.metadata')
    expect(keys).toContain('token:resize')
    expect(keys).toContain('tag:resize')
    expect(keys).not.toContain('token:type')
  })
})

describe('hashDescriptorKey', () => {
  it('returns a 64-char hex string', () => {
    const h = hashDescriptorKey('type:com.example.thing')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic', () => {
    expect(hashDescriptorKey('tag:food')).toBe(hashDescriptorKey('tag:food'))
  })

  it('differs for different keys', () => {
    expect(hashDescriptorKey('tag:food')).not.toBe(hashDescriptorKey('tag:drink'))
  })
})
