import type Database from 'better-sqlite3'

/**
 * Buffers index writes and commits them in one transaction.
 *
 * better-sqlite3 is synchronous, so a write per firehose event means a
 * transaction (and WAL churn) per event — at full-firehose volume that
 * saturates disk I/O and starves the HTTP server serving queries. Batching
 * turns thousands of tiny transactions into a handful of larger ones.
 *
 * Buffered records are lost if the process dies before a flush; the window is
 * bounded by `flushMs`, which is an acceptable trade for a search index that
 * re-sees data on the stream.
 */
export interface PendingWrite {
  record: {
    uri: string
    cid: string
    did: string
    collection: string
    rkey: string
    json: string
    indexed_at: string
  }
  descriptors: string[]
}

export interface IngestBatcherOptions {
  /** Commit once this many records are buffered. */
  maxBatch?: number
  /** Commit this long after the first buffered write, even if not full. */
  flushMs?: number
  onFlush?: (records: number) => void
}

export class IngestBatcher {
  private queue: PendingWrite[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly maxBatch: number
  private readonly flushMs: number
  private readonly commit: (items: PendingWrite[]) => void

  constructor(
    db: Database.Database,
    private opts: IngestBatcherOptions = {},
  ) {
    this.maxBatch = opts.maxBatch ?? 500
    this.flushMs = opts.flushMs ?? 2_000

    const insertRecord = db.prepare(`
      INSERT INTO records (uri, cid, did, collection, rkey, json, indexed_at)
      VALUES (@uri, @cid, @did, @collection, @rkey, @json, @indexed_at)
      ON CONFLICT(uri) DO UPDATE SET
        cid = excluded.cid,
        json = excluded.json,
        indexed_at = excluded.indexed_at
    `)
    const insertDescriptor = db.prepare(`
      INSERT OR IGNORE INTO descriptors (descriptor_key, uri, cid) VALUES (?, ?, ?)
    `)

    this.commit = db.transaction((items: PendingWrite[]) => {
      for (const item of items) {
        insertRecord.run(item.record)
        for (const key of item.descriptors) {
          insertDescriptor.run(key, item.record.uri, item.record.cid)
        }
      }
    })
  }

  add(write: PendingWrite): void {
    this.queue.push(write)
    if (this.queue.length >= this.maxBatch) {
      this.flush()
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs)
      // Never hold the process open for a pending flush.
      this.timer.unref?.()
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.queue.length === 0) return
    const items = this.queue
    this.queue = []
    this.commit(items)
    this.opts.onFlush?.(items.length)
  }

  /** Flush anything buffered and stop the timer. Safe to call more than once. */
  stop(): void {
    this.flush()
  }
}
