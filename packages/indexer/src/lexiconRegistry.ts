import type Database from 'better-sqlite3'
import { resolveLexicon } from '@atproto/lexicon-resolver'
import type { NsidString } from '@atproto/lexicon-resolver'
import { compileExtractionPlan, hasAdapter } from '@atsearch/common'
import type { ExtractionPlan } from '@atsearch/common'
import { getLexicon, upsertLexicon } from './db.js'

export type TriageDecision =
  | { action: 'ingest'; plan?: ExtractionPlan }
  | { action: 'drop'; reason: 'no-text' | 'denied' | 'not-allowlisted' | 'unresolvable' | 'pending' }

export interface LexiconRegistryOptions {
  /** Injected for tests; production uses defaultResolveLexiconDoc. null = not found. */
  resolveLexiconDoc: (nsid: string) => Promise<{ doc: unknown } | null>
  /** Exact NSIDs or `prefix.*`. When set, only matching collections are ingested. */
  allowlist?: string[]
  /** Exact NSIDs or `prefix.*`. Always dropped. Wins over allowlist and adapters. */
  denylist?: string[]
  now?: () => number
  onResolved?: (nsid: string, status: string) => void
}

const RETRY_DELAYS_MS = [3_600_000, 21_600_000, 86_400_000] // 1h, 6h, 24h
const RETRY_MAX_MS = 604_800_000 // 7d
const RESOLVED_TTL_MS = 604_800_000 // 7d

export function nextRetryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[attempts - 1] ?? RETRY_MAX_MS
}

/** Same semantics as the firehose collection filters: exact NSID or `prefix.*`. */
export function nsidMatches(patterns: string[], nsid: string): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('.*')) {
      if (nsid.startsWith(pattern.slice(0, -2))) return true
    } else if (pattern === nsid) {
      return true
    }
  }
  return false
}

export async function defaultResolveLexiconDoc(
  nsid: string,
): Promise<{ doc: unknown } | null> {
  try {
    // `resolveLexicon` types its param as `NSID | NsidString` (a template-literal
    // type); we only have a runtime-validated string here, so cast at the boundary.
    const res = await resolveLexicon(nsid as NsidString)
    return { doc: res.lexicon }
  } catch {
    return null
  }
}

function extractDescription(doc: unknown): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const desc = (doc as any)?.defs?.main?.description
  return typeof desc === 'string' ? desc : null
}

/**
 * SQLite-backed registry mapping collection NSIDs to triage decisions.
 * decide() is synchronous (hot path: one map hit or one PK lookup);
 * unknown NSIDs schedule a background resolution and drop until it lands.
 */
export class LexiconRegistry {
  /** Terminal decisions only (plan / no-text / denied / not-allowlisted / adapter). */
  private cache = new Map<string, TriageDecision>()
  private inFlight = new Set<string>()

  constructor(
    private db: Database.Database,
    private opts: LexiconRegistryOptions,
  ) {}

  decide(nsid: string): TriageDecision {
    const cached = this.cache.get(nsid)
    if (cached) return cached

    if (this.opts.denylist?.length && nsidMatches(this.opts.denylist, nsid)) {
      return this.remember(nsid, { action: 'drop', reason: 'denied' })
    }
    if (hasAdapter(nsid)) {
      return this.remember(nsid, { action: 'ingest' })
    }
    const allowlisted = this.opts.allowlist?.length
      ? nsidMatches(this.opts.allowlist, nsid)
      : undefined
    if (allowlisted === false) {
      return this.remember(nsid, { action: 'drop', reason: 'not-allowlisted' })
    }

    const now = this.opts.now?.() ?? Date.now()
    const row = getLexicon(this.db, nsid)
    if (row?.status === 'plan' && row.plan_json) {
      if (row.resolved_at && now - Date.parse(row.resolved_at) > RESOLVED_TTL_MS) {
        this.scheduleResolve(nsid) // stale: refresh in background, keep serving old plan
      }
      return this.remember(nsid, {
        action: 'ingest',
        plan: JSON.parse(row.plan_json) as ExtractionPlan,
      })
    }
    if (row?.status === 'no-text') {
      return this.remember(nsid, { action: 'drop', reason: 'no-text' })
    }
    if (row?.status === 'unresolvable') {
      if (row.next_retry_at && now >= Date.parse(row.next_retry_at)) {
        this.scheduleResolve(nsid)
      }
      return allowlisted
        ? { action: 'ingest' }
        : { action: 'drop', reason: 'unresolvable' }
    }

    this.scheduleResolve(nsid)
    return allowlisted ? { action: 'ingest' } : { action: 'drop', reason: 'pending' }
  }

  /** Run one resolution to completion. Exposed for tests and the UFOs pre-warm. */
  async resolveNow(nsid: string): Promise<void> {
    const now = this.opts.now?.() ?? Date.now()
    const prev = getLexicon(this.db, nsid)

    let resolved: { doc: unknown } | null = null
    try {
      resolved = await this.opts.resolveLexiconDoc(nsid)
    } catch {
      resolved = null
    }

    if (!resolved) {
      const attempts = (prev?.attempts ?? 0) + 1
      upsertLexicon(this.db, {
        nsid,
        status: 'unresolvable',
        doc_json: null,
        plan_json: null,
        description: null,
        resolved_at: null,
        next_retry_at: new Date(now + nextRetryDelayMs(attempts)).toISOString(),
        attempts,
      })
      this.cache.delete(nsid)
      this.opts.onResolved?.(nsid, 'unresolvable')
      return
    }

    const plan = compileExtractionPlan(resolved.doc)
    const status: 'plan' | 'no-text' = plan?.indexable ? 'plan' : 'no-text'
    upsertLexicon(this.db, {
      nsid,
      status,
      doc_json: JSON.stringify(resolved.doc),
      plan_json: plan?.indexable ? JSON.stringify(plan) : null,
      description: extractDescription(resolved.doc),
      resolved_at: new Date(now).toISOString(),
      next_retry_at: null,
      attempts: 0,
    })
    this.cache.delete(nsid)
    this.opts.onResolved?.(nsid, status)
  }

  private remember(nsid: string, decision: TriageDecision): TriageDecision {
    this.cache.set(nsid, decision)
    return decision
  }

  private scheduleResolve(nsid: string): void {
    if (this.inFlight.has(nsid)) return
    this.inFlight.add(nsid)
    void this.resolveNow(nsid).finally(() => this.inFlight.delete(nsid))
  }
}
