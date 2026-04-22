function truthyEnv(v: string | undefined): boolean {
  return v === '1' || v?.toLowerCase() === 'true'
}

export interface MicrocosmEnv {
  useMicrocosm: boolean
  slingshotBaseUrl: string | null
  constellationBaseUrl: string | null
  fallbackAtprotoXrpcBaseUrl: string
  appUserAgent: string
  indexerUrls: string[]
}

export function readMicrocosmEnv(): MicrocosmEnv {
  const slingshotBaseUrl = (process.env.MICROCOSM_SLINGSHOT_BASE_URL ?? '').trim() || null
  const constellationBaseUrl = (process.env.MICROCOSM_CONSTELLATION_BASE_URL ?? '').trim() || null
  const useMicrocosm =
    process.env.USE_MICROCOSM === undefined
      ? Boolean(slingshotBaseUrl)
      : truthyEnv(process.env.USE_MICROCOSM)

  return {
    useMicrocosm,
    slingshotBaseUrl,
    constellationBaseUrl,
    fallbackAtprotoXrpcBaseUrl:
      (process.env.FALLBACK_ATPROTO_XRPC_BASE_URL ?? 'https://public.api.bsky.app').replace(/\/$/, ''),
    appUserAgent: (process.env.APP_USER_AGENT ?? 'at-search-demo/0.1 (local dev)').trim(),
    indexerUrls: (process.env.ATSEARCH_INDEXER_URLS ?? 'http://localhost:3001')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}
