import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import type { PointerRecord, PointerRecordSigned } from './types.js'

// noble/ed25519 v2 requires a synchronous sha512 shim for non-async paths
ed.etc.sha512Sync = (...msgs: Uint8Array[]): Uint8Array => {
  if (msgs.length === 1) return sha512(msgs[0])
  const total = msgs.reduce((n, m) => n + m.length, 0)
  const buf = new Uint8Array(total)
  let off = 0
  for (const m of msgs) { buf.set(m, off); off += m.length }
  return sha512(buf)
}

function sortDeep(v: unknown): unknown {
  if (typeof v !== 'object' || v === null) return v
  if (Array.isArray(v)) return v.map(sortDeep)
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, val]) => [k, sortDeep(val)]),
  )
}

function encodeCanonical(record: Omit<PointerRecord, 'signature'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(sortDeep(record)))
}

export function generateKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = ed.utils.randomPrivateKey()
  const publicKey = ed.getPublicKey(privateKey)
  return { privateKey, publicKey }
}

export function privateKeyToHex(key: Uint8Array): string {
  return Buffer.from(key).toString('hex')
}

export function publicKeyToHex(key: Uint8Array): string {
  return Buffer.from(key).toString('hex')
}

export function hexToKey(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

export function derivePublicKey(privateKey: Uint8Array): Uint8Array {
  return ed.getPublicKey(privateKey)
}

export async function signPointer(
  record: Omit<PointerRecord, 'signature'>,
  privateKey: Uint8Array,
): Promise<PointerRecordSigned> {
  const payload = encodeCanonical(record)
  const sig = await ed.signAsync(payload, privateKey)
  return {
    ...record,
    signature: Buffer.from(sig).toString('base64'),
  }
}

export async function verifyPointerSignature(
  record: PointerRecordSigned,
  publicKey: Uint8Array,
): Promise<boolean> {
  try {
    const { signature, ...rest } = record
    const payload = encodeCanonical(rest)
    const sig = Uint8Array.from(Buffer.from(signature, 'base64'))
    return await ed.verifyAsync(sig, payload, publicKey)
  } catch {
    return false
  }
}
