// In production we often serve the UI and API on the same origin and proxy `/api`.
// `VITE_QUERY_API_URL` still works for local dev (e.g. `http://localhost:3002`).
const API =
  (import.meta.env.VITE_QUERY_API_URL as string | undefined)?.trim() ||
  (typeof window !== 'undefined' ? `${window.location.origin}/api` : 'http://localhost:3002')

const SEARCH_TIMEOUT_MS = Number.parseInt(
  (import.meta.env.VITE_SEARCH_TIMEOUT_MS as string | undefined) ?? '',
  10,
)
const INTERACTIONS_TIMEOUT_MS = Number.parseInt(
  (import.meta.env.VITE_INTERACTIONS_TIMEOUT_MS as string | undefined) ?? '',
  10,
)

const DEFAULT_SEARCH_TIMEOUT_MS = 45_000
const DEFAULT_INTERACTIONS_TIMEOUT_MS = 30_000

function timeoutMs(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export interface StrongRef {
  uri: string
  cid: string
}

export interface Location {
  lat: number
  lon: number
  geohash: string
}

export interface IndexedRecord {
  $type: string
  title: string
  description?: string
  tags?: string[]
  author?: {
    did: string
    handle?: string
  }
  location?: Location
  createdAt: string
  url?: string
}

/** @deprecated use IndexedRecord */
export type ThingRecord = IndexedRecord

export interface SearchResult {
  ref: StrongRef
  record: IndexedRecord
  matchedDescriptors: string[]
  score: number
  verified: boolean
  verificationError?: string
  fetchError?: string
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
  took: number
}

export async function search(query: string): Promise<SearchResponse> {
  const res = await fetch(`${API}/search?q=${encodeURIComponent(query)}`, {
    signal: AbortSignal.timeout(timeoutMs(SEARCH_TIMEOUT_MS, DEFAULT_SEARCH_TIMEOUT_MS)),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

export interface HydratedBacklink {
  ref: StrongRef
  titleHint?: string
}

export interface PostInteractionsResponse {
  subjectUri: string
  likesTotal?: number
  repliesTotal?: number
  likeSamples: HydratedBacklink[]
  replySamples: HydratedBacklink[]
  partialErrors: string[]
}

/** Constellation-backed likes/replies for a post at-uri (request-driven, no stream). */
export async function fetchPostInteractions(subjectUri: string): Promise<PostInteractionsResponse> {
  const res = await fetch(
    `${API}/interactions?subjectUri=${encodeURIComponent(subjectUri)}`,
    { signal: AbortSignal.timeout(timeoutMs(INTERACTIONS_TIMEOUT_MS, DEFAULT_INTERACTIONS_TIMEOUT_MS)) },
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json()
}
