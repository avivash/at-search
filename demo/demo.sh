#!/usr/bin/env bash
# AT Search — cross-lexicon demo (asciinema)
#
# Teaches AT Search an app that did not exist when it was deployed:
# publish a brand-new lexicon, write a record, watch it become searchable —
# with no change to the search engine.
#
# Requires: ATPROTO_IDENTIFIER + ATPROTO_PASSWORD (an account whose PDS is
# carried by the firehose the indexer consumes). See demo/README.md.

set -e
export TERM=xterm-256color

HERE="$(cd "$(dirname "$0")" && pwd)"
ATSEARCH_URL="${ATSEARCH_URL:-https://atsearch.network/api}"
NSID="at.functions.recipe"
RKEY="${DEMO_RKEY:-gnocchi}"

# Credentials: demo/.env, else the sibling at-functions checkout, else the shell.
for envfile in "$HERE/.env" "$HERE/../../at-functions/.env"; do
  if [ -f "$envfile" ]; then set -a; source "$envfile"; set +a; break; fi
done

if [ -z "${ATPROTO_IDENTIFIER:-}" ] || [ -z "${ATPROTO_PASSWORD:-}" ]; then
  echo "Set ATPROTO_IDENTIFIER and ATPROTO_PASSWORD (see demo/README.md)" >&2
  exit 1
fi

type() {
  local text="$1"
  for ((i=0; i<${#text}; i++)); do
    printf '%s' "${text:$i:1}"
    sleep 0.03
  done
}
pause() { sleep "${1:-1.5}"; }

search() { curl -s "$ATSEARCH_URL/search?q=$(printf '%s' "$1" | sed 's/ /+/g')"; }
# Count only hits in the demo's own collection — the open network already has
# posts about gnocchi, and matching those would prove nothing.
hits() { search "type:$NSID" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String((JSON.parse(s).results||[]).length))}catch{process.stdout.write("0")}})'; }

# ── Demo ─────────────────────────────────────────────────────────────────────

clear
pause 1

type "# AT Search — searching lexicons nobody wrote code for"
echo; pause 2
echo

type "# AT Search has never heard of a 'recipe' on AT Proto:"
echo; pause 1
type "curl -s \$ATSEARCH/search?q=type:$NSID | jq '.results | length'"
echo
search "type:$NSID" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log((JSON.parse(s).results||[]).length))'
pause 2
echo

type "# So let's invent one. This lexicon did not exist 10 seconds ago:"
echo; pause 1
type "cat demo/lexicons/$NSID.json"
echo; pause 0.5
cat "$HERE/lexicons/$NSID.json"
pause 3
echo

type "# Publish the schema to AT Proto (rkey = the NSID):"
echo; pause 1
type "node demo/put-record.mjs --collection com.atproto.lexicon.schema \\"
echo
type "  --rkey $NSID --file demo/lexicons/$NSID.json"
echo; pause 0.5
node "$HERE/put-record.mjs" --collection com.atproto.lexicon.schema \
  --rkey "$NSID" --file "$HERE/lexicons/$NSID.json"
pause 2
echo

type "# It is now resolvable by anyone, from the NSID alone:"
echo; pause 1
type "#   DNS  _lexicon.functions.at  ->  did  ->  repo  ->  schema"
echo; pause 2
echo

type "# The first record of an unknown type teaches the indexer"
echo; pause 0.6
type "# (it resolves the schema in the background, so the firehose never blocks)."
echo; pause 1.5
node "$HERE/put-record.mjs" --collection "$NSID" --rkey "_priming" \
  --data '{"title":"priming record","steps":"teaches the indexer this lexicon exists"}' > /dev/null
sleep 4
echo

type "# Now the real one:"
echo; pause 1
type "node demo/put-record.mjs --collection $NSID --rkey $RKEY --data '{...}'"
echo; pause 0.5
node "$HERE/put-record.mjs" --collection "$NSID" --rkey "$RKEY" --data '{
  "title": "Potato gnocchi",
  "steps": "Bake the potatoes whole, rice them warm, fold in flour and egg, cut into pillows and boil until they float.",
  "ingredients": ["potatoes", "00 flour", "egg", "nutmeg"],
  "tags": ["pasta", "italian"],
  "createdAt": "'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'"
}'
pause 2
echo

type "# Wait for it to come round the firehose..."
echo
for i in $(seq 1 40); do
  if [ "$(hits)" != "0" ]; then break; fi
  printf '.'
  sleep 2
done
echo; echo
pause 0.5

type "curl -s \$ATSEARCH/search?q=type:$NSID"
echo; pause 0.5
search "type:$NSID" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const r=(JSON.parse(s).results||[]).find(x=>x.ref.uri.includes("/at.functions.recipe/gnocchi"));
  if(!r){console.log("  (not indexed yet — see demo/README.md)");return}
  console.log("  type   ", r.record.$type);
  console.log("  title  ", r.record.title);
  console.log("  tags   ", (r.record.tags||[]).join(", "));
  console.log("  uri    ", r.ref.uri);
})'
pause 4
echo

type "# It read the schema and worked out which fields hold searchable text."
echo; pause 2
echo

type "# And it sits in the same result list as everything else."
echo; pause 1
type "curl -s \$ATSEARCH/search?q=gnocchi"
echo; pause 0.5
search "gnocchi" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const rs=(JSON.parse(s).results||[]);
  const mine=rs.filter(r=>r.record.$type==="at.functions.recipe");
  const others=rs.filter(r=>r.record.$type!=="at.functions.recipe");
  for(const r of [...mine, ...others].slice(0,4))
    console.log("  " + r.record.$type.padEnd(24) + " " + (r.record.title||"").slice(0,44));
})'
pause 4
echo

type "# 'nutmeg' appears nowhere in that record except inside the"
echo; pause 0.5
type "# ingredients array. Ask for both words — no filter, whole network:"
echo; pause 1
type "curl -s \$ATSEARCH/search?q=gnocchi+nutmeg"
echo; pause 0.5
search "gnocchi nutmeg" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const rs=(JSON.parse(s).results||[]);
  if(!rs.length){console.log("  (no results — see demo/README.md)");return}
  for(const r of rs.slice(0,3))
    console.log("  " + String(r.score).padStart(3) + "  " + r.record.$type.padEnd(22) + " " + (r.record.title||"").slice(0,38));
  const i=rs.findIndex(r=>r.record.$type==="at.functions.recipe");
  console.log("\n  the recipe ranks #" + (i+1) + " of " + rs.length + " — matched on an ingredient.");
})'
pause 4
echo

type "# Zero lines of search-engine code were written for this app."
echo; pause 1.5
type "# Publish your lexicon and AT Search indexes you too."
echo; pause 3
