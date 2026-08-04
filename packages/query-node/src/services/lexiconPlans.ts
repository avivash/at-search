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
/**
 * A failed round must not start the full TTL: the query node boots alongside
 * the indexer (`depends_on` waits for start, not readiness), so the first
 * attempt often lands before the indexer is listening. Waiting out the TTL
 * after that leaves the cache silently empty for ten minutes.
 */
const RETRY_MS = 15_000

export class LexiconPlanCache {
  private plans = new Map<string, ExtractionPlan>()
  private nextAttemptAt = 0
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
    if (now < this.nextAttemptAt) return
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
            signal: AbortSignal.timeout(20_000),
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
    // round never blanks a good cache — and retry soon rather than at TTL.
    if (merged.size > 0) {
      this.plans = merged
      this.nextAttemptAt = now + this.ttlMs
    } else {
      this.nextAttemptAt = now + RETRY_MS
    }
    this.opts.onRefresh?.(merged.size)
  }
}
