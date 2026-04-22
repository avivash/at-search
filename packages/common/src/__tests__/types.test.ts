import { parseAtUri, buildAtUri } from '../types'

describe('parseAtUri', () => {
  it('parses a valid AT URI', () => {
    const result = parseAtUri('at://did:plc:abc123/com.example.thing/rkey456')
    expect(result).toEqual({
      did: 'did:plc:abc123',
      collection: 'com.example.thing',
      rkey: 'rkey456',
    })
  })

  it('throws on invalid URI', () => {
    expect(() => parseAtUri('https://not-an-at-uri')).toThrow()
    expect(() => parseAtUri('at://only-two-parts')).toThrow()
  })
})

describe('buildAtUri', () => {
  it('builds a valid AT URI', () => {
    expect(buildAtUri('did:plc:abc', 'com.example.thing', 'rkey1')).toBe(
      'at://did:plc:abc/com.example.thing/rkey1',
    )
  })
})
