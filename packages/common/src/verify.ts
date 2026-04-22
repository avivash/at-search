import { parseAtUri } from './types.js'

export interface VerifyResult {
  verified: boolean
  error?: string
}

/**
 * Verifies that a record at (uri, cid) matches what's currently in AT Proto.
 *
 * Limitations:
 * - We rely on the PDS returning the same record JSON in the same order.
 *   AT Proto CIDs are computed by the PDS using DAG-CBOR encoding; we cannot
 *   recompute them from JSON without a DAG-CBOR encoder and the exact same
 *   schema. Instead we fetch the record's CID from the PDS using the
 *   com.atproto.repo.getRecord endpoint which returns the CID alongside the
 *   value. We compare that returned CID with our stored CID.
 */
export async function verifyRecordCid(
  uri: string,
  expectedCid: string,
  pdsUrl?: string,
): Promise<VerifyResult> {
  try {
    const { did, collection, rkey } = parseAtUri(uri)

    const base = pdsUrl ?? 'https://bsky.social'
    const url = `${base}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      if (res.status === 404) return { verified: false, error: 'Record not found' }
      return { verified: false, error: `PDS returned ${res.status}` }
    }

    const body = (await res.json()) as { cid?: string; value?: unknown }
    if (!body.cid) return { verified: false, error: 'PDS did not return CID' }

    const match = body.cid === expectedCid
    return {
      verified: match,
      error: match ? undefined : `CID mismatch: expected ${expectedCid}, got ${body.cid}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { verified: false, error: `Fetch error: ${msg}` }
  }
}
