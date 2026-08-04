import type { ExtractionPlan } from '@atsearch/common'

/**
 * Extraction plans, mirrored from the indexers that learned them.
 *
 * The indexer compiles a lexicon schema into a plan and uses it when indexing.
 * The query node re-normalises records it hydrates from the PDS, so without the
 * same plan it would fall back to heuristics — losing custom body fields and,
 * because ranking scores the re-normalised record, burying novel lexicons
 * beneath better-understood ones. Mirroring the plans keeps both sides equal.
 *
 * Lookup is synchronous (normalizeRecord is sync and sits on the hydration
 * path); staleness is handled by a background refresh.
 */
export interface LexiconPlanCacheOptions {
  /** How long a fetched set stays fresh (default 10 minutes). */
  ttlMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
  onRefresh?: (count: number) => void
}

interface LexiconRow {
  nsid?: unknown
  plan?: unknown
}

const DEFAULT_TTL_MS = 600_000

export class LexiconPlanCache {
  private plans = new Map<string, ExtractionPlan>()
  private lastFetchedAt = 0
  private inFlight: Promise<void> | null = null
  private readonly ttlMs: number

  constructor(
    private indexerUrls: string[],
    private opts: LexiconPlanCacheOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  }

  /** Sync plan lookup for the hydration path. Pre-bound so it can be passed as a function. */
  lookup = (nsid: string): ExtractionPlan | undefined => this.plans.get(nsid)

  get(nsid: string): ExtractionPlan | undefined {
    return this.plans.get(nsid)
  }

  /** Refresh if stale. Never throws — a stale set beats no set. */
  async refresh(): Promise<void> {
    const now = this.opts.now?.() ?? Date.now()
    if (this.lastFetchedAt && now - this.lastFetchedAt < this.ttlMs) return
    if (this.inFlight) return this.inFlight

    this.inFlight = this.fetchAll(now).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** Kick off a refresh without waiting for it (hydration must not block on HTTP). */
  refreshInBackground(): void {
    void this.refresh().catch(() => {
      /* a stale plan set is fine; never disturb request handling */
    })
  }

  private async fetchAll(now: number): Promise<void> {
    const doFetch = this.opts.fetchImpl ?? fetch
    const merged = new Map<string, ExtractionPlan>()

    await Promise.all(
      this.indexerUrls.map(async (base) => {
        try {
          const res = await doFetch(`${base.replace(/\/$/, '')}/lexicons?plans=1`, {
            signal: AbortSignal.timeout(8_000),
          })
          if (!res.ok) return
          const data = (await res.json()) as { lexicons?: LexiconRow[] }
          for (const row of data.lexicons ?? []) {
            if (typeof row?.nsid !== 'string' || !row.plan || typeof row.plan !== 'object') continue
            if (!merged.has(row.nsid)) merged.set(row.nsid, row.plan as ExtractionPlan)
          }
        } catch {
          // indexer unreachable or malformed — other indexers may still answer
        }
      }),
    )

    // Only replace the working set if we actually learned something, so a bad
    // round never blanks a good cache.
    if (merged.size > 0) {
      this.plans = merged
      this.opts.onRefresh?.(merged.size)
    }
    this.lastFetchedAt = now
  }
}
