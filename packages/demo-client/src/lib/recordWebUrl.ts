/**
 * Bluesky web expects `profile/<handle-or-did>` where DIDs keep literal `:`.
 * `encodeURIComponent("did:plc:…")` breaks routing ("Invalid DID or handle").
 */
function bskyProfilePathSegment(did: string, handle?: string): string {
  const h = handle?.replace(/^@/, '').trim()
  if (h && !h.startsWith('did:')) {
    return encodeURIComponent(h)
  }
  return did
}

/**
 * Best-effort URL to open the indexed record in a public viewer.
 * Bluesky app URLs for known collections; otherwise `record.url` when present.
 */
export function recordWebUrl(uri: string, recordUrl?: string, authorHandle?: string): string | null {
  const m = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/)
  if (m) {
    const [, did, collection, rkey] = m
    const profileSeg = bskyProfilePathSegment(did, authorHandle)
    if (collection === 'app.bsky.feed.post') {
      return `https://bsky.app/profile/${profileSeg}/post/${rkey}`
    }
    if (collection === 'app.bsky.actor.profile') {
      return `https://bsky.app/profile/${profileSeg}`
    }
  }
  if (recordUrl?.trim()) return recordUrl.trim()
  return null
}
