import type Database from 'better-sqlite3'
import { resolveLexicon } from '@atproto/lexicon-resolver'
import type { NsidString } from '@atproto/lexicon-resolver'
import { compileExtractionPlan, hasAdapter } from '@atsearch/common'
import type { ExtractionPlan } from '@atsearch/common'
import { getLexicon, upsertLexicon } from './db.js'

export type TriageDecision =
  | { action: 'ingest'; plan?: ExtractionPlan }
  | {
      action: 'drop'
      reason: 'no-text' | 'denied' | 'not-allowlisted' | 'unresolvable' | 'pending' | 'invalid-nsid'
    }

export interface LexiconRegistryOptions {
  /** Injected for tests; production uses defaultResolveLexiconDoc. null = not found. */
  resolveLexiconDoc: (nsid: string) => Promise<{ doc: unknown } | null>
  /** Exact NSIDs or `prefix.*`. When set, only matching collections are ingested. */
  allowlist?: string[]
  /** Exact NSIDs or `prefix.*`. Always dropped. Wins over allowlist and adapters. */
  denylist?: string[]
  /** Max resolutions running at once (default 6). */
  maxConcurrentResolutions?: number
  /** Max resolutions waiting behind the cap; excess is dropped and re-seen later (default 64). */
  maxResolutionQueue?: number
  now?: () => number
  onResolved?: (nsid: string, status: string) => void
}

const RETRY_DELAYS_MS = [3_600_000, 21_600_000, 86_400_000] // 1h, 6h, 24h
const RETRY_MAX_MS = 604_800_000 // 7d
const RESOLVED_TTL_MS = 604_800_000 // 7d

export function nextRetryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[attempts - 1] ?? RETRY_MAX_MS
}

const MAX_NSID_LENGTH = 317
const AUTHORITY_SEGMENT_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/
const NAME_SEGMENT_RE = /^[a-zA-Z][a-zA-Z0-9]*$/

/**
 * Cheap syntactic NSID validation (AT Proto NSID spec) so junk collection
 * names off the firehose never reach DNS/network resolution or the registry.
 */
export function isValidNsid(nsid: string): boolean {
  if (nsid.length === 0 || nsid.length > MAX_NSID_LENGTH) return false
  const segments = nsid.split('.')
  if (segments.length < 3) return false
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    if (seg.length === 0 || seg.length > 63) return false
    if (!AUTHORITY_SEGMENT_RE.test(seg)) return false
    if (i === 0 && /^[0-9]/.test(seg)) return false
  }
  const name = segments[segments.length - 1]
  if (name.length === 0 || name.length > 63) return false
  return NAME_SEGMENT_RE.test(name)
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
  private activeResolves = 0
  private resolveQueue: string[] = []
  private readonly maxConcurrent: number
  private readonly maxQueue: number

  constructor(
    private db: Database.Database,
    private opts: LexiconRegistryOptions,
  ) {
    this.maxConcurrent = opts.maxConcurrentResolutions ?? 6
    this.maxQueue = opts.maxResolutionQueue ?? 64
  }

  decide(nsid: string): TriageDecision {
    const cached = this.cache.get(nsid)
    if (cached) return cached

    // Deliberately NOT cached: junk collection names must stay out of the
    // cache map too, or generated names could grow it without bound.
    if (!isValidNsid(nsid)) {
      return { action: 'drop', reason: 'invalid-nsid' }
    }

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
      if (row.resolved_at && now - Date.parse(row.resolved_at) > RESOLVED_TTL_MS) {
        this.scheduleResolve(nsid) // stale: re-check in background — schemas evolve
      }
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
    if (this.activeResolves >= this.maxConcurrent) {
      // Bounded FIFO overflow; beyond it, drop — the NSID is re-seen on the
      // live stream and a later decide() reschedules it.
      if (this.resolveQueue.length >= this.maxQueue) return
      this.inFlight.add(nsid)
      this.resolveQueue.push(nsid)
      return
    }
    this.inFlight.add(nsid)
    this.runResolve(nsid)
  }

  private runResolve(nsid: string): void {
    this.activeResolves++
    void this.resolveNow(nsid)
      .finally(() => {
        this.activeResolves--
        this.inFlight.delete(nsid)
        const next = this.resolveQueue.shift()
        if (next) this.runResolve(next)
      })
      .catch(() => { /* background resolution must never crash ingestion */ })
  }
}
