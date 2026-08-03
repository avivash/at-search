import { openDb, getLexicon } from '../db'
import { LexiconRegistry, nextRetryDelayMs, nsidMatches } from '../lexiconRegistry'

const FOO_LEXICON = {
  lexicon: 1,
  id: 'com.example.foo',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      description: 'A foo',
      record: { type: 'object', properties: { title: { type: 'string', maxLength: 100 } } },
    },
  },
}

const LIKE_LEXICON = {
  lexicon: 1,
  id: 'xyz.app.like',
  defs: {
    main: {
      type: 'record',
      key: 'tid',
      record: {
        type: 'object',
        properties: {
          subject: { type: 'string', format: 'at-uri' },
          createdAt: { type: 'string', format: 'datetime' },
        },
      },
    },
  },
}

describe('nextRetryDelayMs / nsidMatches', () => {
  it('backs off 1h, 6h, 24h, then 7d', () => {
    expect(nextRetryDelayMs(1)).toBe(3_600_000)
    expect(nextRetryDelayMs(2)).toBe(21_600_000)
    expect(nextRetryDelayMs(3)).toBe(86_400_000)
    expect(nextRetryDelayMs(4)).toBe(604_800_000)
    expect(nextRetryDelayMs(99)).toBe(604_800_000)
  })

  it('matches exact nsids and prefix wildcards', () => {
    expect(nsidMatches(['com.example.foo'], 'com.example.foo')).toBe(true)
    expect(nsidMatches(['com.example.*'], 'com.example.foo')).toBe(true)
    expect(nsidMatches(['com.example.*'], 'org.other.foo')).toBe(false)
    expect(nsidMatches([], 'com.example.foo')).toBe(false)
  })
})

describe('LexiconRegistry.decide', () => {
  const mkRegistry = (
    docs: Record<string, unknown>,
    opts: { allowlist?: string[]; denylist?: string[]; now?: () => number; fail?: boolean } = {},
  ) => {
    const db = openDb(':memory:')
    const calls: string[] = []
    const registry = new LexiconRegistry(db, {
      resolveLexiconDoc: async (nsid) => {
        calls.push(nsid)
        if (opts.fail) throw new Error('dns boom')
        return nsid in docs ? { doc: docs[nsid] } : null
      },
      allowlist: opts.allowlist,
      denylist: opts.denylist,
      now: opts.now,
    })
    return { db, registry, calls }
  }

  it('adapters always ingest without a plan', () => {
    const { registry, calls } = mkRegistry({})
    expect(registry.decide('app.bsky.feed.post')).toEqual({ action: 'ingest' })
    expect(calls).toEqual([]) // no resolution scheduled for adapter lexicons
  })

  it('denylist wins over everything', () => {
    const { registry } = mkRegistry({}, { denylist: ['app.bsky.*'] })
    expect(registry.decide('app.bsky.feed.post')).toEqual({ action: 'drop', reason: 'denied' })
  })

  it('unknown collection: drop pending, then ingest with plan after resolution', async () => {
    const { registry } = mkRegistry({ 'com.example.foo': FOO_LEXICON })
    expect(registry.decide('com.example.foo')).toEqual({ action: 'drop', reason: 'pending' })
    await registry.resolveNow('com.example.foo')
    const decision = registry.decide('com.example.foo')
    expect(decision.action).toBe('ingest')
    expect((decision as { plan?: { nsid: string } }).plan?.nsid).toBe('com.example.foo')
  })

  it('text-free lexicons resolve to no-text and drop', async () => {
    const { registry } = mkRegistry({ 'xyz.app.like': LIKE_LEXICON })
    registry.decide('xyz.app.like')
    await registry.resolveNow('xyz.app.like')
    expect(registry.decide('xyz.app.like')).toEqual({ action: 'drop', reason: 'no-text' })
  })

  it('failed resolution → unresolvable with retry backoff recorded', async () => {
    const { db, registry } = mkRegistry({}, { fail: true, now: () => 1_000_000 })
    // Call resolveNow directly (a decide() first would also schedule a background
    // resolution and race the attempts counter).
    await registry.resolveNow('com.example.gone')
    expect(registry.decide('com.example.gone')).toEqual({ action: 'drop', reason: 'unresolvable' })
    const row = getLexicon(db, 'com.example.gone')!
    expect(row.attempts).toBe(1)
    expect(Date.parse(row.next_retry_at!)).toBe(1_000_000 + 3_600_000)
  })

  it('allowlisted collections ingest generically while pending/unresolvable', async () => {
    const { registry } = mkRegistry({}, { fail: true, allowlist: ['com.example.*'] })
    expect(registry.decide('com.example.legacy')).toEqual({ action: 'ingest' })
    await registry.resolveNow('com.example.legacy')
    expect(registry.decide('com.example.legacy')).toEqual({ action: 'ingest' })
    expect(registry.decide('org.other.thing')).toEqual({ action: 'drop', reason: 'not-allowlisted' })
  })
})
