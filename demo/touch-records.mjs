#!/usr/bin/env node
// Re-write every record in a collection, unchanged, so it flows through the
// firehose again and gets (re-)indexed.
//
// Jetstream carries live commits only — it has no backfill. So a record written
// before an index existed (or before it was rebuilt) is invisible to that index
// until its repo emits a new commit for it. This "touches" records to do that.
//
// Usage:
//   ATPROTO_IDENTIFIER=you.bsky.social ATPROTO_PASSWORD=app-password \
//     node demo/touch-records.mjs --collection at.functions.metadata
//
//   --repo <did|handle>   whose repo to touch (default: the authed account)
//   --dry-run             list what would be touched, write nothing

const SERVICE = (process.env.ATPROTO_SERVICE ?? 'https://bsky.social').replace(/\/$/, '')
const IDENTIFIER = process.env.ATPROTO_IDENTIFIER
const PASSWORD = process.env.ATPROTO_PASSWORD

const arg = (flag) => {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}
const has = (flag) => process.argv.includes(flag)
const die = (m) => {
  console.error(`error: ${m}`)
  process.exit(1)
}

const collection = arg('--collection') ?? die('--collection is required')
const dryRun = has('--dry-run')
if (!IDENTIFIER || !PASSWORD) die('set ATPROTO_IDENTIFIER and ATPROTO_PASSWORD')

async function post(method, body, token) {
  const res = await fetch(`${SERVICE}/xrpc/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) die(`${method} failed (${res.status}): ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

const session = await post('com.atproto.server.createSession', {
  identifier: IDENTIFIER,
  password: PASSWORD,
})
const repo = arg('--repo') ?? session.did

// listRecords is a public read; page through the whole collection.
const records = []
let cursor
do {
  const url = new URL(`${SERVICE}/xrpc/com.atproto.repo.listRecords`)
  url.searchParams.set('repo', repo)
  url.searchParams.set('collection', collection)
  url.searchParams.set('limit', '100')
  if (cursor) url.searchParams.set('cursor', cursor)
  const res = await fetch(url)
  if (!res.ok) die(`listRecords failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  const page = await res.json()
  records.push(...(page.records ?? []))
  cursor = page.cursor
} while (cursor)

if (records.length === 0) {
  console.log(`no records in ${repo}/${collection}`)
  process.exit(0)
}
console.log(`${dryRun ? 'would touch' : 'touching'} ${records.length} record(s) in ${collection}:`)

/**
 * Re-writing a byte-identical record is a no-op: the PDS emits no commit, so
 * nothing reaches the firehose. Something in the value has to change. Lexicons
 * that anticipate this carry a timestamp field for exactly this purpose (see
 * at.functions.metadata's `updatedAt`: "useful for ensuring deploys produce a
 * repo commit").
 */
const TOUCH_FIELDS = ['updatedAt', 'indexedAt']
const bumpField = arg('--bump')

let touched = 0
let skipped = 0
for (const rec of records) {
  const rkey = rec.uri.split('/').pop()
  const field = bumpField ?? TOUCH_FIELDS.find((f) => f in rec.value)

  if (!field) {
    console.log(`  ${rkey} — skipped: no timestamp field to bump (pass --bump <field>)`)
    skipped++
    continue
  }
  if (dryRun) {
    console.log(`  ${rkey} (would bump ${field})`)
    continue
  }

  await post(
    'com.atproto.repo.putRecord',
    {
      repo: session.did,
      collection,
      rkey,
      record: { ...rec.value, [field]: new Date().toISOString() },
    },
    session.accessJwt,
  )
  console.log(`  ${rkey} ✓ (${field} bumped)`)
  touched++
}

if (!dryRun) {
  console.log(`\n${touched} re-emitted on the firehose; ${skipped} skipped.`)
  if (skipped > 0) {
    console.log('Skipped records are unchanged on disk but stay invisible to live-only indexers.')
  }
}
