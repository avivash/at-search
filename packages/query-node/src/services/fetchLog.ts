export type FetchBackend = 'slingshot' | 'constellation' | 'atproto-fallback' | 'indexer-cache'

export function logFetch(scope: string, backend: FetchBackend, detail: string): void {
  console.log(`[atsearch-fetch] ${scope} backend=${backend} ${detail}`)
}
