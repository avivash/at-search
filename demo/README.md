# AT Search — cross-lexicon demo

Teaches AT Search an app that did not exist when it was deployed. Publish a
brand-new lexicon, write a record, watch it become searchable — with no change
to the search engine and nobody telling it the app exists.

## What it shows

Four beats, roughly 100 seconds:

1. **What it taught itself.** ~190 record types compiled by reading published
   schemas — a music scrobbler, a biodiversity database, a book catalogue, an
   RPG, a drawing app. Zero lines of code written for any of them.
2. **What it refused.** ~75 collections auto-detected as holding no readable
   text — likes and follows, but also *other apps'* stats records. That triage
   is what makes reading the whole firehose affordable.
3. **One query, many apps.** A single search returning results from five
   unrelated lexicons at once.
4. **Invent one live.** A lexicon written moments earlier is published, a
   record of that type is written to a normal repo, and it turns up in search —
   with body text extracted from a custom field name nothing was told about.
   The closing search matches on a word that appears *only inside an array*,
   and the score breakdown shows why.

## Run it

```bash
export ATPROTO_IDENTIFIER=you.bsky.social
export ATPROTO_PASSWORD=your-app-password   # app password, not your login
ATSEARCH_URL=https://atsearch.network/api bash demo/demo.sh
```

Credentials are read from `demo/.env`, then `../at-functions/.env`, then the
shell — so if the sibling at-functions checkout is already configured, the
exports above are unnecessary.

Record it (matches the `.cast` convention used in at-functions):

```bash
asciinema rec -c "bash demo/demo.sh" demo/cross-lexicon.cast --overwrite
```

## What it writes to your repo

Three public records, all under your own identity:

| Record | Purpose |
|---|---|
| `com.atproto.lexicon.schema/at.functions.recipe` | the published schema — this is what makes the NSID resolvable network-wide |
| `at.functions.recipe/_priming` | teaches the indexer the lexicon exists (see below) |
| `at.functions.recipe/gnocchi` | the record the demo searches for |

Re-running is idempotent (`putRecord` upserts). To undo:

```bash
# per record: collection + rkey
curl -X POST "$ATPROTO_SERVICE/xrpc/com.atproto.repo.deleteRecord" ...
```

## Two things that will break the demo

**The first record of a new collection is dropped.** When the indexer sees an
unknown NSID it schedules schema resolution in the background and drops events
until it lands — deliberately, so the firehose never blocks on DNS. The script
handles this by writing a `_priming` record first and pausing. If you split the
demo across sessions, publish the schema and write one throwaway record *before*
the audience arrives, and the live write indexes immediately.

**The publishing account's PDS must be carried by the firehose the indexer
consumes.** In `ATSEARCH_MODE=jetstream` that means a PDS federating with
`bsky.network`. A Bluesky-hosted account always works. A self-hosted PDS works
only if it has requested crawl there — worth testing before demoing, because a
sovereign PDS that has not is exactly the gap that multi-source ingestion is
meant to close.

## Files

- `put-record.mjs` — zero-dependency AT Proto record writer (plain `fetch`
  against `createSession` + `putRecord`). Useful well beyond this demo for
  testing any new lexicon.
- `lexicons/at.functions.recipe.json` — the invented lexicon.
- `demo.sh` — the narrated end-to-end demo.

## Follow-up beat

After the recipe lands, search `type:at.functions.metadata`, pick the `greeter`
published by a **different DID**, and run it in the playground at
[functions.at](https://functions.at). Discovery *and* execution across a
decentralized network, in two clicks.
