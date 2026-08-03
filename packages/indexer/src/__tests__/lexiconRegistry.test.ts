import { openDb, getLexicon } from '../db'
import { LexiconRegistry, nextRetryDelayMs, nsidMatches, isValidNsid } from '../lexiconRegistry'

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

  it('stale no-text rows are refreshed in the background, same as plan rows', async () => {
    let now = 1_000_000
    const docs: Record<string, unknown> = { 'xyz.app.like': LIKE_LEXICON }
    const { db, registry } = mkRegistry(docs, { now: () => now })

    // Resolve once while the schema is text-free.
    registry.decide('xyz.app.like')
    await registry.resolveNow('xyz.app.like')
    expect(getLexicon(db, 'xyz.app.like')!.status).toBe('no-text')

    // Age past the TTL and swap in a schema that now compiles indexable, then
    // clear the in-memory cache (fresh-process-start equivalent) so decide()
    // re-reads the row from SQLite instead of serving the memoized decision.
    now += 604_800_000 + 1
    docs['xyz.app.like'] = FOO_LEXICON
    ;(registry as unknown as { cache: Map<string, unknown> }).cache.clear()

    const decision = registry.decide('xyz.app.like')
    expect(decision).toEqual({ action: 'drop', reason: 'no-text' })

    await registry.resolveNow('xyz.app.like')
    expect(getLexicon(db, 'xyz.app.like')!.status).toBe('plan')
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

describe('isValidNsid', () => {
  it('accepts well-formed NSIDs', () => {
    expect(isValidNsid('app.bsky.feed.post')).toBe(true)
    expect(isValidNsid('com.example.fooBar')).toBe(true)
    expect(isValidNsid('a-b.c-d.name')).toBe(true)
    expect(isValidNsid('org.4chan.thing')).toBe(true) // non-first authority segment may start with a digit
  })

  it('rejects malformed NSIDs', () => {
    expect(isValidNsid('')).toBe(false)
    expect(isValidNsid('two.segments')).toBe(false) // fewer than 3 segments
    expect(isValidNsid('com.example..thing')).toBe(false) // empty segment
    expect(isValidNsid('com.example.po$t')).toBe(false) // bad charset
    expect(isValidNsid('com.example.9thing')).toBe(false) // name starts with a digit
    expect(isValidNsid('9com.example.thing')).toBe(false) // first authority segment starts with a digit
    expect(isValidNsid('-com.example.thing')).toBe(false) // leading hyphen
    expect(isValidNsid('com-.example.thing')).toBe(false) // trailing hyphen
    expect(isValidNsid('com.example.thing-name')).toBe(false) // hyphen in name segment
    expect(isValidNsid(`com.${'a'.repeat(64)}.thing`)).toBe(false) // segment over 63 chars
    const longNsid = `${Array(6).fill('a'.repeat(60)).join('.')}.name` // 370 chars total
    expect(isValidNsid(longNsid)).toBe(false) // over 317 chars total
  })
})

describe('LexiconRegistry NSID validation', () => {
  it('drops invalid NSIDs without scheduling resolution or touching the DB', () => {
    const db = openDb(':memory:')
    const calls: string[] = []
    const registry = new LexiconRegistry(db, {
      resolveLexiconDoc: async (nsid) => {
        calls.push(nsid)
        return null
      },
    })
    expect(registry.decide('not-an-nsid')).toEqual({ action: 'drop', reason: 'invalid-nsid' })
    expect(registry.decide('bad..double.dot')).toEqual({ action: 'drop', reason: 'invalid-nsid' })
    expect(calls).toEqual([])
    expect(getLexicon(db, 'not-an-nsid')).toBeUndefined()
  })
})

describe('LexiconRegistry resolution limiter', () => {
  const planDoc = (id: string) => ({
    lexicon: 1,
    id,
    defs: {
      main: {
        type: 'record',
        key: 'tid',
        record: { type: 'object', properties: { title: { type: 'string', maxLength: 100 } } },
      },
    },
  })
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('caps concurrent resolutions, queues overflow FIFO, drops beyond the queue bound', async () => {
    const db = openDb(':memory:')
    const started: string[] = []
    const gates = new Map<string, () => void>()
    const registry = new LexiconRegistry(db, {
      resolveLexiconDoc: (nsid) =>
        new Promise((resolve) => {
          started.push(nsid)
          gates.set(nsid, () => resolve({ doc: planDoc(nsid) }))
        }),
      maxConcurrentResolutions: 2,
      maxResolutionQueue: 1,
    })

    registry.decide('aaa.example.one')
    registry.decide('aaa.example.two')
    registry.decide('aaa.example.three')
    registry.decide('aaa.example.four')

    // Cap 2: only the first two actually start; three is queued; four is dropped.
    expect(started).toEqual(['aaa.example.one', 'aaa.example.two'])

    gates.get('aaa.example.one')!()
    await flush()
    // A slot freed: the queued NSID starts next (FIFO).
    expect(started).toEqual(['aaa.example.one', 'aaa.example.two', 'aaa.example.three'])

    // The dropped NSID was forgotten entirely, so a later decide() can requeue it.
    registry.decide('aaa.example.four')
    expect(started).toHaveLength(3) // still at cap (two + three running); four is queued

    gates.get('aaa.example.two')!()
    await flush()
    expect(started).toEqual([
      'aaa.example.one',
      'aaa.example.two',
      'aaa.example.three',
      'aaa.example.four',
    ])

    gates.get('aaa.example.three')!()
    gates.get('aaa.example.four')!()
    await flush()
    expect(getLexicon(db, 'aaa.example.four')?.status).toBe('plan')
  })
})
