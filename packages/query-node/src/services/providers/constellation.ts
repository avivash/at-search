import { xrpcGet } from './xrpcClient.js'

/**
 * Constellation (Microcosm) — backlink index over firehose-seen records.
 * @see https://constellation.microcosm.blue/ — method blue.microcosm.links.getBacklinks
 */
export interface ConstellationBacklinkRow {
  did: string
  collection: string
  rkey: string
}

export interface ConstellationBacklinksResponse {
  total?: number
  records?: ConstellationBacklinkRow[]
  cursor?: string
}

export class ConstellationProvider {
  constructor(
    private baseUrl: string,
    private userAgent: string,
  ) {}

  async getBacklinks(params: {
    subject: string
    source: string
    limit?: number
    cursor?: string
  }): Promise<ConstellationBacklinksResponse | null> {
    try {
      return await xrpcGet<ConstellationBacklinksResponse>(
        this.baseUrl,
        'blue.microcosm.links.getBacklinks',
        {
          subject: params.subject,
          source: params.source,
          limit: params.limit ?? 16,
          ...(params.cursor ? { cursor: params.cursor } : {}),
        },
        this.userAgent,
        15_000,
      )
    } catch (err) {
      console.warn('[atsearch-fetch] constellation getBacklinks failed:', (err as Error).message)
      return null
    }
  }
}

/** Source strings follow collection:dot.path (Constellation docs). */
export const ConstellationSources = {
  likeSubjectUri: 'app.bsky.feed.like:subject.uri',
  replyParentUri: 'app.bsky.feed.post:reply.parent.uri',
  /** Follow records whose subject is a DID */
  graphFollowSubject: 'app.bsky.graph.follow:subject',
} as const
