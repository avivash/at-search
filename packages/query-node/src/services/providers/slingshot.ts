import { xrpcGet } from './xrpcClient.js'

/**
 * Slingshot (Microcosm) — edge cache for public AT Proto reads.
 * Uses standard com.atproto XRPC shapes; HTTP details stay in this module.
 *
 * If Slingshot errors (5xx, timeout), callers fall back to direct XRPC on
 * FALLBACK_ATPROTO_XRPC_BASE_URL or repo PDS (see RecordService).
 */
export interface SlingshotGetRecordResponse {
  cid?: string
  uri?: string
  /** Slingshot / ATProto getRecord body uses `value` for the record payload */
  value?: unknown
  /** Some gateways use `record` instead */
  record?: unknown
}

export class SlingshotProvider {
  constructor(
    private baseUrl: string,
    private userAgent: string,
  ) {}

  async getRecord(repo: string, collection: string, rkey: string): Promise<SlingshotGetRecordResponse | null> {
    try {
      return await xrpcGet<SlingshotGetRecordResponse>(
        this.baseUrl,
        'com.atproto.repo.getRecord',
        { repo, collection, rkey },
        this.userAgent,
      )
    } catch {
      return null
    }
  }

  async resolveHandle(handle: string): Promise<{ did: string } | null> {
    try {
      return await xrpcGet<{ did: string }>(
        this.baseUrl,
        'com.atproto.identity.resolveHandle',
        { handle },
        this.userAgent,
        8_000,
      )
    } catch {
      return null
    }
  }

  /**
   * Optional; public Slingshot may not expose app.bsky.*. When this fails, IdentityService
   * uses the generic fallback XRPC host (e.g. public.api.bsky.app).
   */
  async getProfile(actor: string): Promise<AppBskyProfileView | null> {
    try {
      return await xrpcGet<AppBskyProfileView>(
        this.baseUrl,
        'app.bsky.actor.getProfile',
        { actor },
        this.userAgent,
      )
    } catch {
      return null
    }
  }
}

/** Minimal fields used by IdentityService */
export interface AppBskyProfileView {
  did: string
  handle?: string
  displayName?: string
  avatar?: string
}
