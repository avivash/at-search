#!/usr/bin/env node
// Write any record into an AT Proto repo. Zero dependencies — plain fetch
// against com.atproto.server.createSession + com.atproto.repo.putRecord, so
// the demo runs with nothing installed.
//
// Usage:
//   ATPROTO_IDENTIFIER=you.bsky.social ATPROTO_PASSWORD=app-password \
//     node demo/put-record.mjs \
//       --collection at.functions.recipe \
//       --rkey gnocchi \
//       --data '{"title":"Potato gnocchi","steps":"Boil the potatoes…"}'
//
//   # Publish a lexicon schema (rkey must be the NSID):
//   node demo/put-record.mjs --collection com.atproto.lexicon.schema \
//     --rkey at.functions.recipe --file demo/lexicons/at.functions.recipe.json

import { readFileSync } from 'node:fs'

const SERVICE = (process.env.ATPROTO_SERVICE ?? 'https://bsky.social').replace(/\/$/, '')
const IDENTIFIER = process.env.ATPROTO_IDENTIFIER
const PASSWORD = process.env.ATPROTO_PASSWORD

function arg(flag) {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}

function die(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

if (!IDENTIFIER || !PASSWORD) die('set ATPROTO_IDENTIFIER and ATPROTO_PASSWORD')

const collection = arg('--collection') ?? die('--collection is required')
const rkey = arg('--rkey') ?? die('--rkey is required')
const dataJson = arg('--data')
const file = arg('--file')
if (!dataJson && !file) die('pass --data <json> or --file <path>')

let record
try {
  record = JSON.parse(dataJson ?? readFileSync(file, 'utf8'))
} catch (err) {
  die(`record body is not valid JSON: ${err.message}`)
}
// A record's $type must match its collection; fill it in so callers don't have to.
record.$type ??= collection

async function xrpc(method, body, token) {
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

const session = await xrpc('com.atproto.server.createSession', {
  identifier: IDENTIFIER,
  password: PASSWORD,
})

const out = await xrpc(
  'com.atproto.repo.putRecord',
  { repo: session.did, collection, rkey, record },
  session.accessJwt,
)

console.log(out.uri)
