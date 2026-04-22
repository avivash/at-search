/**
 * Integration test: seed → index → describe → sign → verify pointer structure.
 *
 * Runs entirely in-memory without a live AT Proto PDS or DHT.
 * Exercises the full pipeline using only @atsearch/common primitives.
 */
import { createHash } from 'crypto'
import { deriveDescriptors, descriptorToQueryKeys, hashDescriptorKey } from '../descriptor'
import { generateKeypair, signPointer, verifyPointerSignature } from '../signing'
import { parseAtUri } from '../types'
import type { ThingRecord, PointerRecord } from '../types'

const COLLECTION = 'com.example.thing'

function fakeCid(s: string): string {
  return `bafyrei${createHash('sha256').update(s).digest('hex').slice(0, 32)}`
}

const seedRecords: Array<{ uri: string; cid: string; record: ThingRecord }> = [
  {
    uri: 'at://did:plc:inttest01/com.example.thing/r001',
    cid: fakeCid('fridge-vancouver'),
    record: {
      $type: COLLECTION,
      title: 'Community Fridge Vancouver',
      description: 'Mutual aid fridge in East Vancouver',
      tags: ['food', 'mutual-aid', 'vancouver'],
      location: { lat: 49.28, lon: -123.12, geohash: 'c2b2n' },
      createdAt: '2024-01-01T00:00:00.000Z',
    },
  },
  {
    uri: 'at://did:plc:inttest02/com.example.thing/r002',
    cid: fakeCid('tool-library'),
    record: {
      $type: COLLECTION,
      title: 'East Van Tool Library',
      description: 'Free tool lending, mutual aid model',
      tags: ['tools', 'mutual-aid', 'vancouver'],
      location: { lat: 49.27, lon: -123.07, geohash: 'c2b2p' },
      createdAt: '2024-01-02T00:00:00.000Z',
    },
  },
  // Same CID as r001 but different URI — must NOT be treated as duplicate
  {
    uri: 'at://did:plc:inttest03/com.example.thing/r003',
    cid: fakeCid('fridge-vancouver'),
    record: {
      $type: COLLECTION,
      title: 'Community Fridge Vancouver',
      description: 'Mutual aid fridge in East Vancouver',
      tags: ['food', 'mutual-aid', 'vancouver'],
      location: { lat: 49.28, lon: -123.12, geohash: 'c2b2n' },
      createdAt: '2024-01-01T00:00:00.000Z',
    },
  },
]

describe('integration: seed → index → search → verify', () => {
  let privateKey: Uint8Array
  let publicKey: Uint8Array

  // In-memory descriptor index: Map<descriptorKey, Set<uri::cid>>
  const descriptorIndex = new Map<string, Set<string>>()

  beforeAll(() => {
    const kp = generateKeypair()
    privateKey = kp.privateKey
    publicKey = kp.publicKey
  })

  it('1. seeds records and builds descriptor index', () => {
    for (const { uri, cid, record } of seedRecords) {
      const keys = deriveDescriptors(record)
      for (const key of keys) {
        if (!descriptorIndex.has(key)) descriptorIndex.set(key, new Set())
        descriptorIndex.get(key)!.add(`${uri}::${cid}`)
      }
    }
    expect(descriptorIndex.has('tag:food')).toBe(true)
    expect(descriptorIndex.has('tag:mutual-aid')).toBe(true)
    expect(descriptorIndex.has('token:fridge')).toBe(true)
    expect(descriptorIndex.has('geo:c2b2n')).toBe(true)
  })

  it('2. query resolves correct descriptor keys', () => {
    const keys = descriptorToQueryKeys('fridge mutual aid vancouver')
    expect(keys).toContain('token:fridge')
    expect(keys).toContain('token:mutual')
    expect(keys).toContain('token:vancouver')
    expect(keys).toContain('tag:fridge')
  })

  it('3. descriptor index returns candidates for search query', () => {
    const queryKeys = descriptorToQueryKeys('fridge vancouver')
    const candidates = new Set<string>()
    for (const key of queryKeys) {
      for (const ref of descriptorIndex.get(key) ?? []) {
        candidates.add(ref)
      }
    }
    // r001 and r003 both match "fridge" and "vancouver"
    expect([...candidates].some((c) => c.startsWith('at://did:plc:inttest01'))).toBe(true)
    expect([...candidates].some((c) => c.startsWith('at://did:plc:inttest03'))).toBe(true)
  })

  it('4. same-CID different-URI candidates are NOT deduped', () => {
    const tag = 'tag:food'
    const refs = [...(descriptorIndex.get(tag) ?? [])]
    const uris = refs.map((r) => r.split('::')[0])
    expect(uris).toContain('at://did:plc:inttest01/com.example.thing/r001')
    expect(uris).toContain('at://did:plc:inttest03/com.example.thing/r003')
    // Different URIs even though same CID — deduplication must not apply
    const cids = refs.map((r) => r.split('::')[1])
    expect(cids[0]).toBe(cids[1]) // same CID
    const uriSet = new Set(uris)
    expect(uriSet.size).toBe(2) // but different URIs
  })

  it('5. pointer records are signed and verifiable', async () => {
    const { uri, cid } = seedRecords[0]
    const base: Omit<PointerRecord, 'signature'> = {
      version: 1,
      descriptorKey: 'tag:food',
      ref: { uri, cid },
      providerPeerId: 'QmIntegrationTestPeer',
      indexedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }
    const signed = await signPointer(base, privateKey)
    expect(signed.signature).toBeTruthy()
    const valid = await verifyPointerSignature(signed, publicKey)
    expect(valid).toBe(true)
  })

  it('6. tampered pointer fails verification', async () => {
    const { uri, cid } = seedRecords[0]
    const base: Omit<PointerRecord, 'signature'> = {
      version: 1,
      descriptorKey: 'tag:food',
      ref: { uri, cid },
      providerPeerId: 'QmIntegrationTestPeer',
      indexedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }
    const signed = await signPointer(base, privateKey)
    const tampered = { ...signed, ref: { uri, cid: 'bafyreiFAKECID' } }
    const valid = await verifyPointerSignature(tampered, publicKey)
    expect(valid).toBe(false)
  })

  it('7. stale pointer detection', () => {
    const past = new Date(Date.now() - 1000).toISOString()
    const future = new Date(Date.now() + 86_400_000).toISOString()
    expect(new Date(past) < new Date()).toBe(true)
    expect(new Date(future) > new Date()).toBe(true)
  })

  it('8. AT URI parsing is correct', () => {
    const { uri } = seedRecords[0]
    const parsed = parseAtUri(uri)
    expect(parsed.did).toBe('did:plc:inttest01')
    expect(parsed.collection).toBe('com.example.thing')
    expect(parsed.rkey).toBe('r001')
  })

  it('9. descriptor key hashing is stable across runs', () => {
    const h = hashDescriptorKey('tag:mutual-aid')
    expect(h).toBe(hashDescriptorKey('tag:mutual-aid'))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toBe(hashDescriptorKey('tag:food'))
  })

  it('10. same URI different CID = different version, both indexed', () => {
    // Simulate record update: same URI, new CID
    const uri = seedRecords[0].uri
    const newCid = fakeCid('fridge-vancouver-v2')
    const updatedRecord: ThingRecord = {
      ...seedRecords[0].record,
      title: 'Community Fridge Vancouver (Updated)',
      createdAt: '2024-06-01T00:00:00.000Z',
    }
    const keys = deriveDescriptors(updatedRecord)
    for (const key of keys) {
      if (!descriptorIndex.has(key)) descriptorIndex.set(key, new Set())
      descriptorIndex.get(key)!.add(`${uri}::${newCid}`)
    }

    const foodRefs = [...(descriptorIndex.get('tag:food') ?? [])]
    const r1Versions = foodRefs.filter((r) => r.startsWith(uri))
    // Both old and new CID should be present for the same URI
    expect(r1Versions.length).toBeGreaterThanOrEqual(2)
    const cidSet = new Set(r1Versions.map((r) => r.split('::')[1]))
    expect(cidSet.has(fakeCid('fridge-vancouver'))).toBe(true)
    expect(cidSet.has(newCid)).toBe(true)
  })
})
