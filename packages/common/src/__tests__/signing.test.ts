import { generateKeypair, signPointer, verifyPointerSignature, privateKeyToHex, hexToKey } from '../signing'
import type { PointerRecord } from '../types'

const makePointer = (overrides: Partial<PointerRecord> = {}): Omit<PointerRecord, 'signature'> => ({
  version: 1,
  descriptorKey: 'tag:food',
  ref: { uri: 'at://did:plc:abc/com.example.thing/123', cid: 'bafyreiabcdef' },
  providerPeerId: 'QmTestPeer',
  indexedAt: '2024-01-01T00:00:00.000Z',
  expiresAt: '2024-12-31T00:00:00.000Z',
  ...overrides,
})

describe('signing', () => {
  it('signs and verifies a pointer record', async () => {
    const { privateKey, publicKey } = generateKeypair()
    const pointer = makePointer()
    const signed = await signPointer(pointer, privateKey)
    expect(signed.signature).toBeTruthy()
    const valid = await verifyPointerSignature(signed, publicKey)
    expect(valid).toBe(true)
  })

  it('rejects tampered records', async () => {
    const { privateKey, publicKey } = generateKeypair()
    const pointer = makePointer()
    const signed = await signPointer(pointer, privateKey)
    const tampered = { ...signed, descriptorKey: 'tag:tampered' }
    const valid = await verifyPointerSignature(tampered, publicKey)
    expect(valid).toBe(false)
  })

  it('rejects wrong public key', async () => {
    const { privateKey } = generateKeypair()
    const { publicKey: wrongKey } = generateKeypair()
    const pointer = makePointer()
    const signed = await signPointer(pointer, privateKey)
    const valid = await verifyPointerSignature(signed, wrongKey)
    expect(valid).toBe(false)
  })

  it('round-trips private key through hex', async () => {
    const { privateKey, publicKey } = generateKeypair()
    const hex = privateKeyToHex(privateKey)
    const recovered = hexToKey(hex)
    const pointer = makePointer()
    const signed = await signPointer(pointer, recovered)
    const valid = await verifyPointerSignature(signed, publicKey)
    expect(valid).toBe(true)
  })
})
