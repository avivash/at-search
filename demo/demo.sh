#!/usr/bin/env bash
# AT Search — cross-lexicon demo (asciinema)
#
# Four beats:
#   1. what it taught itself      — lexicons compiled with no code written
#   2. what it refused to index   — text-free collections, auto-detected
#   3. one query, many apps       — a single result list spanning lexicons
#   4. invent one live            — publish a schema, watch a record index
#
# Requires ATPROTO_IDENTIFIER + ATPROTO_PASSWORD. See demo/README.md.

set -e
export TERM=xterm-256color

HERE="$(cd "$(dirname "$0")" && pwd)"
ATSEARCH_URL="${ATSEARCH_URL:-https://atsearch.network/api}"
NSID="at.functions.recipe"
RKEY="${DEMO_RKEY:-gnocchi}"

for envfile in "$HERE/.env" "$HERE/../../at-functions/.env"; do
  if [ -f "$envfile" ]; then set -a; source "$envfile"; set +a; break; fi
done
if [ -z "${ATPROTO_IDENTIFIER:-}" ] || [ -z "${ATPROTO_PASSWORD:-}" ]; then
  echo "Set ATPROTO_IDENTIFIER and ATPROTO_PASSWORD (see demo/README.md)" >&2
  exit 1
fi

type() { local t="$1"; for ((i=0;i<${#t};i++)); do printf '%s' "${t:$i:1}"; sleep 0.03; done; }
pause() { sleep "${1:-1.5}"; }
search() { curl -s "$ATSEARCH_URL/search?q=$(printf '%s' "$1" | sed 's/ /+/g')"; }
lexicons() { curl -s "$ATSEARCH_URL/lexicons"; }
recipeHits() { search "type:$NSID" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).results||[]).length))}catch{process.stdout.write("0")}})'; }

clear
pause 1

type "# AT Search — one index for every app on AT Protocol."
echo; pause 1
type "# Every app invents its own record type. Nobody coordinates."
echo; pause 2
echo

# ── 1. what it taught itself ────────────────────────────────────────────────
type "# Record types this index compiled itself, by reading published schemas:"
echo; pause 1
type "curl -s \$ATSEARCH/lexicons"
echo; pause 0.5
lexicons | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const l=JSON.parse(s).lexicons||[];
  const plan=l.filter(x=>x.status==="plan");
  const foreign=plan.filter(x=>!x.nsid.startsWith("app.bsky")&&!x.nsid.startsWith("com.atproto"));
  const pick=["app.rocksky.scrobble","app.gainforest.dwc.occurrence","buzz.bookhive.catalogBook",
              "social.grain.gallery","app.lexidraw.scene","actor.rpg.master","app.racethesky.run",
              "ai.rizom.brain.note","social.coves.community.post"]
             .filter(n=>foreign.some(f=>f.nsid===n));
  for(const n of pick.slice(0,7)) console.log("  " + n);
  console.log("\n  " + plan.length + " compiled — " + foreign.length + " of them nothing to do with Bluesky.");
  console.log("  Lines of code written for any of them: 0");
})'
pause 5
echo

# ── 2. what it refused ──────────────────────────────────────────────────────
type "# It also worked out which record types hold no readable text at all:"
echo; pause 1
lexicons | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const l=JSON.parse(s).lexicons||[];
  const nt=l.filter(x=>x.status==="no-text");
  for(const x of nt.filter(x=>/like|follow|block|repost|stats/.test(x.nsid)).slice(0,6))
    console.log("  " + x.nsid);
  console.log("\n  " + nt.length + " dropped before indexing — likes, follows, and other apps stats too.");
  console.log("  That is what makes reading the entire firehose affordable.");
})'
pause 5
echo

# ── 3. one query, many apps ─────────────────────────────────────────────────
type "# So one search crosses all of them at once:"
echo; pause 1
type "curl -s \$ATSEARCH/search?q=garden"
echo; pause 0.5
search "garden" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const rs=JSON.parse(s).results||[];
  const seen=new Set(); const rows=[];
  for(const r of rs){ if(seen.has(r.record.$type)) continue; seen.add(r.record.$type); rows.push(r); if(rows.length>=5) break }
  for(const r of rows) console.log("  " + r.record.$type.padEnd(28) + " " + (r.record.title||"").replace(/\n/g," ").slice(0,40));
  console.log("\n  " + rs.length + " results across " + new Set(rs.map(r=>r.record.$type)).size + " different apps.");
})'
pause 5
echo

# ── 4. invent one live ──────────────────────────────────────────────────────
type "# And an app that does not exist yet? Invent one now."
echo; pause 1.5
type "cat demo/lexicons/$NSID.json   # written 30 seconds ago"
echo; pause 0.5
head -22 "$HERE/lexicons/$NSID.json"
pause 3
echo

type "# Publish the schema. Anyone can now resolve it from the NSID alone:"
echo; pause 1
node "$HERE/put-record.mjs" --collection com.atproto.lexicon.schema \
  --rkey "$NSID" --file "$HERE/lexicons/$NSID.json"
pause 1.5
echo

# First sight of an unknown collection schedules resolution and is dropped;
# prime so the demo record indexes immediately.
node "$HERE/put-record.mjs" --collection "$NSID" --rkey "_priming" \
  --data '{"title":"priming","steps":"teaches the indexer this type exists"}' > /dev/null
sleep 4

type "# Write a record of a type this search engine has never been coded for:"
echo; pause 1
node "$HERE/put-record.mjs" --collection "$NSID" --rkey "$RKEY" --data '{
  "title": "Potato gnocchi",
  "steps": "Bake the potatoes whole, rice them warm, fold in flour and egg, cut into pillows and boil until they float.",
  "ingredients": ["potatoes", "00 flour", "egg", "nutmeg"],
  "tags": ["pasta", "italian"],
  "createdAt": "'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'"
}'
pause 1
echo

type "# …and wait for it to come back round the firehose."
echo
for i in $(seq 1 40); do [ "$(recipeHits)" != "0" ] && break; printf '.'; sleep 2; done
echo; echo
pause 0.5

search "type:$NSID" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const r=(JSON.parse(s).results||[]).find(x=>x.ref.uri.includes("/gnocchi"))||(JSON.parse(s).results||[])[0];
  if(!r){console.log("  (not indexed yet — see demo/README.md)");return}
  console.log("  type   " + r.record.$type);
  console.log("  title  " + r.record.title);
  console.log("  tags   " + (r.record.tags||[]).join(", "));
  console.log("  uri    " + r.ref.uri);
})'
pause 4
echo

type "# It read the schema and worked out which fields held searchable text."
echo; pause 1
type "# 'nutmeg' appears only inside the ingredients array — ask for both words:"
echo; pause 1
type "curl -s \$ATSEARCH/search?q=gnocchi+nutmeg+type:$NSID"
echo; pause 0.5
search "gnocchi nutmeg type:$NSID" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const rs=JSON.parse(s).results||[];
  if(!rs.length){console.log("  (none)");return}
  for(const r of rs.slice(0,3))
    console.log("  " + String(r.score).padStart(3) + "  " + r.record.title + "   " + (r.scoreBreakdown||[]).map(b=>b.label).slice(0,3).join(" · "));
})'
pause 4
echo

type "# No code was written for recipes. Or for any of the other 187."
echo; pause 1.5
type "# Publish your lexicon and AT Search indexes you too."
echo; pause 3
