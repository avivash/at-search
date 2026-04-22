import type { IndexedRecord } from '@atsearch/common'
import type { MicrocosmEnv } from '../env.js'
import { logFetch } from '../fetchLog.js'
import { TtlCache } from '../ttlCache.js'
import { SlingshotProvider, type AppBskyProfileView } from '../providers/slingshot.js'
import { xrpcGet } from '../providers/xrpcClient.js'

export interface ResolvedIdentity {
  did: string
  handle?: string
  displayName?: string
  avatar?: string
  source: 'slingshot' | 'atproto-fallback'
}

export class IdentityService {
  private slingshot: SlingshotProvider | null
  private profileCache: TtlCache<ResolvedIdentity>

  constructor(private env: MicrocosmEnv) {
    this.slingshot = env.slingshotBaseUrl
      ? new SlingshotProvider(env.slingshotBaseUrl, env.appUserAgent)
      : null
    this.profileCache = new TtlCache(120_000)
  }

  async resolveHandle(handle: string): Promise<{ did: string; source: 'slingshot' | 'atproto-fallback' } | null> {
    const h = handle.replace(/^@/, '')
    if (this.env.useMicrocosm && this.slingshot) {
      const r = await this.slingshot.resolveHandle(h)
      if (r?.did) {
        logFetch('identity', 'slingshot', `handle=${h}`)
        return { did: r.did, source: 'slingshot' }
      }
    }
    try {
      const r = await xrpcGet<{ did: string }>(
        this.env.fallbackAtprotoXrpcBaseUrl,
        'com.atproto.identity.resolveHandle',
        { handle: h },
        this.env.appUserAgent,
        8_000,
      )
      if (r?.did) {
        logFetch('identity', 'atproto-fallback', this.env.fallbackAtprotoXrpcBaseUrl)
        return { did: r.did, source: 'atproto-fallback' }
      }
    } catch {
      // ignore
    }
    return null
  }

  async getProfile(actor: string): Promise<ResolvedIdentity | null> {
    const cacheKey = actor
    const hit = this.profileCache.get(cacheKey)
    if (hit) return hit

    let view: AppBskyProfileView | null = null
    let source: ResolvedIdentity['source'] = 'atproto-fallback'

    if (this.env.useMicrocosm && this.slingshot) {
      view = await this.slingshot.getProfile(actor)
      if (view) {
        source = 'slingshot'
        logFetch('identity', 'slingshot', `profile actor=${actor}`)
      }
    }

    if (!view) {
      try {
        view = await xrpcGet<AppBskyProfileView>(
          this.env.fallbackAtprotoXrpcBaseUrl,
          'app.bsky.actor.getProfile',
          { actor },
          this.env.appUserAgent,
        )
        logFetch('identity', 'atproto-fallback', this.env.fallbackAtprotoXrpcBaseUrl)
        source = 'atproto-fallback'
      } catch {
        return null
      }
    }

    if (!view?.did) return null

    const resolved: ResolvedIdentity = {
      did: view.did,
      handle: view.handle,
      displayName: view.displayName,
      avatar: view.avatar,
      source,
    }
    this.profileCache.set(cacheKey, resolved)
    return resolved
  }

  /**
   * Best-effort: attach handle (and optionally display) to record.author when only DID is present.
   */
  async enrichIndexedRecord(record: IndexedRecord): Promise<IndexedRecord> {
    const did = record.author?.did
    if (!did || record.author?.handle) return record

    const prof = await this.getProfile(did)
    if (!prof?.handle) return record

    return {
      ...record,
      author: {
        ...record.author,
        did,
        handle: prof.handle,
      },
    }
  }
}
