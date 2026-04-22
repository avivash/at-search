import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

export type IndexerDb = ReturnType<typeof openDb>

export function openDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      uri TEXT PRIMARY KEY,
      cid TEXT NOT NULL,
      did TEXT NOT NULL,
      collection TEXT NOT NULL,
      rkey TEXT NOT NULL,
      json TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS descriptors (
      descriptor_key TEXT NOT NULL,
      uri TEXT NOT NULL,
      cid TEXT NOT NULL,
      PRIMARY KEY (descriptor_key, uri, cid),
      FOREIGN KEY (uri) REFERENCES records(uri) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_descriptors_key ON descriptors(descriptor_key);

    CREATE TABLE IF NOT EXISTS providers (
      descriptor_key TEXT NOT NULL,
      provider_peer_id TEXT NOT NULL,
      last_advertised_at TEXT NOT NULL,
      PRIMARY KEY (descriptor_key, provider_peer_id)
    );
  `)

  return db
}

export function upsertRecord(
  db: Database.Database,
  params: {
    uri: string
    cid: string
    did: string
    collection: string
    rkey: string
    json: string
    indexed_at: string
  },
): void {
  db.prepare(`
    INSERT INTO records (uri, cid, did, collection, rkey, json, indexed_at)
    VALUES (@uri, @cid, @did, @collection, @rkey, @json, @indexed_at)
    ON CONFLICT(uri) DO UPDATE SET
      cid = excluded.cid,
      json = excluded.json,
      indexed_at = excluded.indexed_at
  `).run(params)
}

export function upsertDescriptor(
  db: Database.Database,
  descriptorKey: string,
  uri: string,
  cid: string,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO descriptors (descriptor_key, uri, cid)
    VALUES (?, ?, ?)
  `).run(descriptorKey, uri, cid)
}

export function getPointersByDescriptor(
  db: Database.Database,
  descriptorKey: string,
): Array<{ uri: string; cid: string; indexed_at: string }> {
  return db.prepare(`
    SELECT r.uri, d.cid, r.indexed_at
    FROM descriptors d
    JOIN records r ON r.uri = d.uri AND r.cid = d.cid
    WHERE d.descriptor_key = ?
    ORDER BY r.indexed_at DESC
    LIMIT 100
  `).all(descriptorKey) as Array<{ uri: string; cid: string; indexed_at: string }>
}

export function upsertProvider(
  db: Database.Database,
  descriptorKey: string,
  providerPeerId: string,
  lastAdvertisedAt: string,
): void {
  db.prepare(`
    INSERT INTO providers (descriptor_key, provider_peer_id, last_advertised_at)
    VALUES (?, ?, ?)
    ON CONFLICT(descriptor_key, provider_peer_id) DO UPDATE SET
      last_advertised_at = excluded.last_advertised_at
  `).run(descriptorKey, providerPeerId, lastAdvertisedAt)
}

export function getAllDescriptorKeys(db: Database.Database): string[] {
  const rows = db.prepare('SELECT DISTINCT descriptor_key FROM descriptors').all() as Array<{ descriptor_key: string }>
  return rows.map((r) => r.descriptor_key)
}
