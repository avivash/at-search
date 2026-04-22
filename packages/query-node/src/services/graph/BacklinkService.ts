import type { StrongRef } from '@atsearch/common'
import type { MicrocosmEnv } from '../env.js'
import { logFetch } from '../fetchLog.js'
import { ConstellationProvider, ConstellationSources } from '../providers/constellation.js'
import type { RecordService } from '../atproto/RecordService.js'

export interface HydratedBacklink {
  ref: StrongRef
  /** Present when record normalisation succeeded */
  titleHint?: string
}

export interface PostInteractions {
  subjectUri: string
  likesTotal?: number
  repliesTotal?: number
  likeSamples: HydratedBacklink[]
  replySamples: HydratedBacklink[]
  partialErrors: string[]
}

/**
 * Constellation-backed relationship queries (likes, replies).
 * Does not replace full-text search — only link-derived lookups.
 *
 * TODO: Optional Spacedust subscription could refresh interaction counts without
 * per-row HTTP if we need nearer-to-live behaviour again.
 */
export class BacklinkService {
  private constellation: ConstellationProvider | null

  constructor(
    private env: MicrocosmEnv,
    private records: RecordService,
  ) {
    this.constellation = env.constellationBaseUrl
      ? new ConstellationProvider(env.constellationBaseUrl, env.appUserAgent)
      : null
  }

  async getPostInteractions(subjectPostUri: string, sampleLimit = 5): Promise<PostInteractions> {
    const partialErrors: string[] = []
    const likeSamples: HydratedBacklink[] = []
    const replySamples: HydratedBacklink[] = []
    let likesTotal: number | undefined
    let repliesTotal: number | undefined

    if (!this.constellation) {
      partialErrors.push('Constellation base URL not configured (MICROCOSM_CONSTELLATION_BASE_URL)')
      return {
        subjectUri: subjectPostUri,
        likeSamples,
        replySamples,
        partialErrors,
      }
    }

    const likesResp = await this.constellation.getBacklinks({
      subject: subjectPostUri,
      source: ConstellationSources.likeSubjectUri,
      limit: sampleLimit,
    })
    if (!likesResp) {
      partialErrors.push('likes: Constellation request failed')
    } else {
      likesTotal = likesResp.total
      logFetch('backlinks', 'constellation', `likes subject=${subjectPostUri}`)
      for (const row of likesResp.records ?? []) {
        const h = await this.hydrateRow(row)
        if (h) likeSamples.push(h)
      }
    }

    const repliesResp = await this.constellation.getBacklinks({
      subject: subjectPostUri,
      source: ConstellationSources.replyParentUri,
      limit: sampleLimit,
    })
    if (!repliesResp) {
      partialErrors.push('replies: Constellation request failed')
    } else {
      repliesTotal = repliesResp.total
      logFetch('backlinks', 'constellation', `replies subject=${subjectPostUri}`)
      for (const row of repliesResp.records ?? []) {
        const h = await this.hydrateRow(row)
        if (h) replySamples.push(h)
      }
    }

    return {
      subjectUri: subjectPostUri,
      likesTotal,
      repliesTotal,
      likeSamples,
      replySamples,
      partialErrors,
    }
  }

  private async hydrateRow(row: { did: string; collection: string; rkey: string }): Promise<HydratedBacklink | null> {
    const resolved = await this.records.resolveLatestAtLocation(row.did, row.collection, row.rkey)
    if (!resolved) return null
    return {
      ref: resolved.ref,
      titleHint: resolved.record.title,
    }
  }
}
