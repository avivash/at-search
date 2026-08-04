import { LexiconPlanCache } from '../services/lexiconPlans'

const plan = (nsid: string) => ({
  nsid,
  indexable: true,
  title: [['title']],
  body: [['steps']],
  tags: [['tags']],
  createdAt: [['createdAt']],
  langs: [],
  url: [],
})

const respond = (body: unknown) =>
  ({ ok: true, json: async () => body }) as unknown as Response

describe('LexiconPlanCache', () => {
  it('serves plans fetched from the indexer', async () => {
    const cache = new LexiconPlanCache(['http://indexer:3001'], {
      fetchImpl: async () =>
        respond({ lexicons: [{ nsid: 'com.example.recipe', plan: plan('com.example.recipe') }] }),
    })
    await cache.refresh()
    expect(cache.get('com.example.recipe')?.body).toEqual([['steps']])
    expect(cache.get('com.example.unknown')).toBeUndefined()
  })

  it('skips entries without a plan (no-text / unresolvable lexicons)', async () => {
    const cache = new LexiconPlanCache(['http://indexer:3001'], {
      fetchImpl: async () =>
        respond({
          lexicons: [
            { nsid: 'xyz.app.like', status: 'no-text' },
            { nsid: 'com.example.recipe', plan: plan('com.example.recipe') },
          ],
        }),
    })
    await cache.refresh()
    expect(cache.get('xyz.app.like')).toBeUndefined()
    expect(cache.get('com.example.recipe')).toBeDefined()
  })

  it('merges across indexers and survives one being unreachable', async () => {
    const cache = new LexiconPlanCache(['http://a:3001', 'http://b:3001'], {
      fetchImpl: async (url) => {
        if (String(url).includes('//a:')) throw new Error('connection refused')
        return respond({ lexicons: [{ nsid: 'com.example.b', plan: plan('com.example.b') }] })
      },
    })
    await cache.refresh()
    expect(cache.get('com.example.b')).toBeDefined()
  })

  it('does not refetch inside the TTL, and refetches after it', async () => {
    let calls = 0
    let now = 1_000_000
    const cache = new LexiconPlanCache(['http://indexer:3001'], {
      ttlMs: 60_000,
      now: () => now,
      fetchImpl: async () => {
        calls++
        return respond({ lexicons: [{ nsid: 'com.example.recipe', plan: plan('com.example.recipe') }] })
      },
    })

    await cache.refresh()
    await cache.refresh()
    expect(calls).toBe(1)

    now += 60_001
    await cache.refresh()
    expect(calls).toBe(2)
  })

  it('tolerates malformed payloads without throwing or clearing what it has', async () => {
    let payload: unknown = { lexicons: [{ nsid: 'com.example.recipe', plan: plan('com.example.recipe') }] }
    const cache = new LexiconPlanCache(['http://indexer:3001'], {
      ttlMs: 0,
      fetchImpl: async () => respond(payload),
    })
    await cache.refresh()
    expect(cache.get('com.example.recipe')).toBeDefined()

    payload = { nonsense: true }
    await expect(cache.refresh()).resolves.toBeUndefined()
    expect(cache.get('com.example.recipe')).toBeDefined()
  })

  it('lookup() is a bound sync function usable as a plan provider', async () => {
    const cache = new LexiconPlanCache(['http://indexer:3001'], {
      fetchImpl: async () =>
        respond({ lexicons: [{ nsid: 'com.example.recipe', plan: plan('com.example.recipe') }] }),
    })
    await cache.refresh()
    const lookup = cache.lookup
    expect(lookup('com.example.recipe')?.nsid).toBe('com.example.recipe')
  })
})

describe('LexiconPlanCache retry behaviour', () => {
  it('retries soon after a failed fetch instead of waiting out the full TTL', async () => {
    let calls = 0
    let now = 1_000_000
    let failing = true
    const cache = new LexiconPlanCache(['http://indexer:3001'], {
      ttlMs: 600_000,
      now: () => now,
      fetchImpl: async () => {
        calls++
        if (failing) throw new Error('ECONNREFUSED — indexer still starting')
        return respond({ lexicons: [{ nsid: 'com.example.recipe', plan: plan('com.example.recipe') }] })
      },
    })

    await cache.refresh() // fails at boot
    expect(calls).toBe(1)
    expect(cache.get('com.example.recipe')).toBeUndefined()

    now += 20_000 // past the short failure retry, still far inside the 10-minute TTL
    failing = false
    await cache.refresh()

    expect(calls).toBe(2)
    expect(cache.get('com.example.recipe')).toBeDefined()
  })

  it('reports a failed/empty refresh so an empty cache is never silent', async () => {
    const seen: number[] = []
    const cache = new LexiconPlanCache(['http://indexer:3001'], {
      onRefresh: (n) => seen.push(n),
      fetchImpl: async () => {
        throw new Error('unreachable')
      },
    })
    await cache.refresh()
    expect(seen).toEqual([0])
  })
})
