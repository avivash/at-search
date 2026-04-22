interface Entry<T> {
  value: T
  expires: number
}

/**
 * Small in-process TTL cache for record/profile fetches (Slingshot is already a cache;
 * this avoids duplicate work within a single query-node process).
 */
export class TtlCache<T> {
  private map = new Map<string, Entry<T>>()

  constructor(private ttlMs: number) {}

  get(key: string): T | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (Date.now() > e.expires) {
      this.map.delete(key)
      return undefined
    }
    return e.value
  }

  set(key: string, value: T): void {
    this.map.set(key, { value, expires: Date.now() + this.ttlMs })
  }
}
