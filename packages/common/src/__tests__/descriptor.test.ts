import { deriveDescriptors, descriptorToQueryKeys, hashDescriptorKey, tokenize } from '../descriptor'
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
  it('does not add type: keys (would match the full corpus)', () => {
    const keys = descriptorToQueryKeys('fridge food')
    expect(keys.some((k) => k.startsWith('type:'))).toBe(false)
  })

  it('generates both token and tag candidates', () => {
    const keys = descriptorToQueryKeys('food fridge')
    expect(keys).toContain('token:food')
    expect(keys).toContain('tag:food')
    expect(keys).toContain('token:fridge')
    expect(keys).toContain('tag:fridge')
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
