/**
 * Seed script: ingest synthetic com.example.thing records directly into the
 * indexer's SQLite database.
 *
 * Usage: bun run seed  (or: tsx src/seed.ts)
 */
import path from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import { deriveDescriptors } from '@atsearch/common'
import type { ThingRecord } from '@atsearch/common'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.ATSEARCH_DB_PATH ?? path.join(__dirname, '../data/indexer.db')

function fakeCid(content: string): string {
  return `bafyrei${createHash('sha256').update(content).digest('hex').slice(0, 32)}`
}

interface SeedRecord {
  did: string
  rkey: string
  record: ThingRecord
}

const seeds: SeedRecord[] = [
  // 1. Vancouver community fridge
  {
    did: 'did:plc:seed0000001',
    rkey: 'rkeyaaa001',
    record: {
      $type: 'com.example.thing',
      title: 'Community Fridge in Vancouver',
      description: 'A mutual aid fridge for sharing food in East Vancouver. Open 24/7.',
      tags: ['food', 'mutual-aid', 'community', 'vancouver'],
      location: { lat: 49.2827, lon: -123.1207, geohash: 'c2b2n' },
      createdAt: '2024-01-10T08:00:00.000Z',
    },
  },
  // 2. East Van Tool Library — overlapping tags
  {
    did: 'did:plc:seed0000002',
    rkey: 'rkeyaaa002',
    record: {
      $type: 'com.example.thing',
      title: 'East Van Tool Library',
      description: 'Borrow tools for free. Community-run, mutual aid model.',
      tags: ['tools', 'mutual-aid', 'community', 'vancouver'],
      location: { lat: 49.2769, lon: -123.0690, geohash: 'c2b2p' },
      createdAt: '2024-01-12T09:00:00.000Z',
    },
  },
  // 3. Seattle fridge — overlapping token "fridge"
  {
    did: 'did:plc:seed0000003',
    rkey: 'rkeyaaa003',
    record: {
      $type: 'com.example.thing',
      title: 'Capitol Hill Community Fridge',
      description: 'Neighborhood fridge in Seattle. Please keep it stocked.',
      tags: ['food', 'community', 'seattle'],
      location: { lat: 47.6253, lon: -122.3222, geohash: 'c23nb' },
      createdAt: '2024-01-15T10:00:00.000Z',
    },
  },
  // 4. Toronto food pantry — overlapping tag "food"
  {
    did: 'did:plc:seed0000004',
    rkey: 'rkeyaaa004',
    record: {
      $type: 'com.example.thing',
      title: 'Kensington Market Food Pantry',
      description: 'Weekly food distribution. Donations welcome.',
      tags: ['food', 'pantry', 'toronto'],
      location: { lat: 43.6548, lon: -79.4006, geohash: 'dpz83' },
      createdAt: '2024-01-18T07:00:00.000Z',
    },
  },
  // 5. London bike repair — different geography
  {
    did: 'did:plc:seed0000005',
    rkey: 'rkeyaaa005',
    record: {
      $type: 'com.example.thing',
      title: 'Hackney Bike Repair Collective',
      description: 'Free bike repairs every Saturday morning in Hackney.',
      tags: ['bikes', 'repair', 'community', 'hackney'],
      location: { lat: 51.5450, lon: -0.0553, geohash: 'gcpvh' },
      createdAt: '2024-02-01T08:00:00.000Z',
    },
  },
  // 6. Berlin free shop — different geography
  {
    did: 'did:plc:seed0000006',
    rkey: 'rkeyaaa006',
    record: {
      $type: 'com.example.thing',
      title: 'Kreuzberg Free Shop',
      description: 'Take what you need, leave what you can. Open daily.',
      tags: ['freeshop', 'mutual-aid', 'berlin'],
      location: { lat: 52.4988, lon: 13.4085, geohash: 'u33db' },
      createdAt: '2024-02-05T09:30:00.000Z',
    },
  },
  // 7. Identical content to #1 but different URI — must NOT dedupe on CID alone
  {
    did: 'did:plc:seed0000007',
    rkey: 'rkeyaaa007',
    record: {
      $type: 'com.example.thing',
      title: 'Community Fridge in Vancouver',
      description: 'A mutual aid fridge for sharing food in East Vancouver. Open 24/7.',
      tags: ['food', 'mutual-aid', 'community', 'vancouver'],
      location: { lat: 49.2827, lon: -123.1207, geohash: 'c2b2n' },
      createdAt: '2024-01-10T08:00:00.000Z',
    },
  },
  // 8. Updated version of #1 — same URI, new CID (treated as new version)
  {
    did: 'did:plc:seed0000001',
    rkey: 'rkeyaaa001',
    record: {
      $type: 'com.example.thing',
      title: 'Community Fridge in Vancouver (Updated)',
      description: 'A mutual aid fridge for sharing food in East Vancouver. Open 24/7. Now with a second fridge!',
      tags: ['food', 'mutual-aid', 'community', 'vancouver'],
      location: { lat: 49.2827, lon: -123.1207, geohash: 'c2b2n' },
      createdAt: '2024-03-01T08:00:00.000Z',
    },
  },
  // 9. Stale pointer — old record with no active PDS
  {
    did: 'did:plc:seed0000009',
    rkey: 'rkeyaaa009',
    record: {
      $type: 'com.example.thing',
      title: 'Old Community Garden (STALE)',
      description: 'This record has a stale pointer. The garden closed.',
      tags: ['garden', 'community'],
      location: { lat: 49.2500, lon: -123.1000, geohash: 'c2b2j' },
      createdAt: '2022-01-01T00:00:00.000Z',
    },
  },
  // 10. Auckland repair cafe
  {
    did: 'did:plc:seed0000010',
    rkey: 'rkeyaaa010',
    record: {
      $type: 'com.example.thing',
      title: 'Grey Lynn Repair Cafe',
      description: 'Bring your broken things. Volunteers help you fix them.',
      tags: ['repair', 'community', 'auckland'],
      location: { lat: -36.8667, lon: 174.7333, geohash: 'rbh2q' },
      createdAt: '2024-02-20T10:00:00.000Z',
    },
  },
  // 11. Sydney tool library
  {
    did: 'did:plc:seed0000011',
    rkey: 'rkeyaaa011',
    record: {
      $type: 'com.example.thing',
      title: 'Newtown Community Tool Library',
      description: 'Free tool lending. Drills, saws, ladders and more.',
      tags: ['tools', 'community', 'sydney'],
      location: { lat: -33.8978, lon: 151.1794, geohash: 'r3gr2' },
      createdAt: '2024-03-05T08:00:00.000Z',
    },
  },
  // 12. Vancouver seed library — overlapping geo with #1 and #2
  {
    did: 'did:plc:seed0000012',
    rkey: 'rkeyaaa012',
    record: {
      $type: 'com.example.thing',
      title: 'Vancouver Seed Library',
      description: 'Borrow seeds, grow food, return seeds. Community-run.',
      tags: ['seeds', 'food', 'community', 'vancouver'],
      location: { lat: 49.2600, lon: -123.1150, geohash: 'c2b25' },
      createdAt: '2024-03-10T07:00:00.000Z',
    },
  },
]

async function seed() {
  const { mkdirSync } = await import('fs')
  mkdirSync(path.dirname(DB_PATH), { recursive: true })

  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
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
      PRIMARY KEY (descriptor_key, uri, cid)
    );
    CREATE INDEX IF NOT EXISTS idx_descriptors_key ON descriptors(descriptor_key);
    CREATE TABLE IF NOT EXISTS providers (
      descriptor_key TEXT NOT NULL,
      provider_peer_id TEXT NOT NULL,
      last_advertised_at TEXT NOT NULL,
      PRIMARY KEY (descriptor_key, provider_peer_id)
    );
  `)

  console.log(`Seeding database at ${DB_PATH}`)
  console.log(`Inserting ${seeds.length} seed records...\n`)

  const upsertRecord = db.prepare(`
    INSERT INTO records (uri, cid, did, collection, rkey, json, indexed_at)
    VALUES (@uri, @cid, @did, @collection, @rkey, @json, @indexed_at)
    ON CONFLICT(uri) DO UPDATE SET
      cid = excluded.cid, json = excluded.json, indexed_at = excluded.indexed_at
  `)
  const upsertDescriptor = db.prepare(`
    INSERT OR IGNORE INTO descriptors (descriptor_key, uri, cid) VALUES (?, ?, ?)
  `)

  let inserted = 0
  for (const { did, rkey, record } of seeds) {
    const uri = `at://${did}/com.example.thing/${rkey}`
    const cid = fakeCid(JSON.stringify(record))
    const indexed_at = new Date().toISOString()

    upsertRecord.run({ uri, cid, did, collection: 'com.example.thing', rkey, json: JSON.stringify(record), indexed_at })

    const descriptors = deriveDescriptors(record)
    for (const key of descriptors) {
      upsertDescriptor.run(key, uri, cid)
    }

    console.log(`  [${++inserted}] ${uri}`)
    console.log(`        CID: ${cid}`)
    console.log(`        Tags: ${(record.tags ?? []).join(', ')}`)
    console.log(`        Descriptors (${descriptors.length}): ${descriptors.slice(0, 5).join(', ')}${descriptors.length > 5 ? '...' : ''}`)
    console.log()
  }

  console.log(`Done. ${inserted} records seeded into ${DB_PATH}`)
  console.log()
  console.log('Identity notes:')
  console.log('  Records #1 and #7 share a CID (same content, different owners) — NOT deduped')
  console.log('  Record #8 updates #1 (same URI, new CID) — both versions indexed')
  db.close()
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
