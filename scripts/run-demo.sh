#!/usr/bin/env bash
# Run the full AT Search demo stack locally (Bun + bash).
# Ctrl+C stops all processes.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export ATSEARCH_DB_PATH="${ATSEARCH_DB_PATH:-$ROOT/data/indexer.db}"
INDEXER_HTTP_PORT="${INDEXER_PORT:-3001}"
export ATSEARCH_HTTP_PORT="$INDEXER_HTTP_PORT"
export ATSEARCH_DHT_PORT="${ATSEARCH_DHT_PORT:-8001}"
export ATSEARCH_LIBP2P_LISTEN_HOST="${ATSEARCH_LIBP2P_LISTEN_HOST:-127.0.0.1}"

QUERY_PORT="${QUERY_PORT:-3002}"
QUERY_DHT_PORT="${QUERY_DHT_PORT:-8002}"
DEMO_PORT="${DEMO_PORT:-5173}"

export ATSEARCH_MODE="${ATSEARCH_MODE:-local}"

export USE_MICROCOSM="${USE_MICROCOSM:-true}"
export MICROCOSM_SLINGSHOT_BASE_URL="${MICROCOSM_SLINGSHOT_BASE_URL:-https://slingshot.microcosm.blue}"
export MICROCOSM_CONSTELLATION_BASE_URL="${MICROCOSM_CONSTELLATION_BASE_URL:-https://constellation.microcosm.blue}"
export FALLBACK_ATPROTO_XRPC_BASE_URL="${FALLBACK_ATPROTO_XRPC_BASE_URL:-https://public.api.bsky.app}"
export APP_USER_AGENT="${APP_USER_AGENT:-at-search-demo/0.1 (run-demo.sh)}"

# better-sqlite3 ships prebuilt / native bindings for Node, not Bun's runtime ABI.
# Run the compiled indexer with Node; Bun still drives install/build/seed in this script.
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: \`node\` not found on PATH. The indexer needs Node to load better-sqlite3."
  echo "       Install Node 20+ or set NODE_BIN to your node executable."
  exit 1
fi

INDEXER_PID=""
QUERY_PID=""
CLIENT_PID=""

port_in_use() {
  local port="$1"
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1
    return $?
  fi
  (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1
}

require_free_port() {
  local name="$1" port="$2"
  if port_in_use "$port"; then
    echo "ERROR: $name port $port is already in use."
    echo "       Stop the other process or set a different port, e.g.:"
    echo "         INDEXER_PORT=3011 QUERY_PORT=3012 DEMO_PORT=5180 bash scripts/run-demo.sh"
    exit 1
  fi
}

echo "=== AT Search Demo ==="
echo ""
echo "Indexer:    http://localhost:${INDEXER_HTTP_PORT}"
echo "Query node: http://localhost:${QUERY_PORT}"
echo "Demo UI:    http://localhost:${DEMO_PORT}"
echo ""

require_free_port "Indexer HTTP" "$INDEXER_HTTP_PORT"
require_free_port "Indexer DHT (libp2p)" "$ATSEARCH_DHT_PORT"
require_free_port "Query node HTTP" "$QUERY_PORT"
require_free_port "Query node DHT" "$QUERY_DHT_PORT"
require_free_port "Demo (Vite)" "$DEMO_PORT"

mkdir -p "$ROOT/data"

echo "Building @atsearch/common..."
bun run --filter @atsearch/common build

echo "Building @atsearch/indexer..."
bun run --filter @atsearch/indexer build

echo "Building @atsearch/query-node..."
bun run --filter @atsearch/query-node build

echo ""
echo "Seeding database..."
ATSEARCH_DB_PATH="$ATSEARCH_DB_PATH" bun run --filter @atsearch/indexer seed || true

echo ""
echo "Starting services..."

cleanup() {
  echo ""
  echo "Stopping all services..."
  [ -n "${INDEXER_PID:-}" ] && kill "$INDEXER_PID" 2>/dev/null || true
  [ -n "${QUERY_PID:-}" ] && kill "$QUERY_PID" 2>/dev/null || true
  [ -n "${CLIENT_PID:-}" ] && kill "$CLIENT_PID" 2>/dev/null || true
  [ -n "${INDEXER_PID:-}" ] && wait "$INDEXER_PID" 2>/dev/null || true
  [ -n "${QUERY_PID:-}" ] && wait "$QUERY_PID" 2>/dev/null || true
  [ -n "${CLIENT_PID:-}" ] && wait "$CLIENT_PID" 2>/dev/null || true
  echo "Done."
}
trap cleanup EXIT INT TERM

ATSEARCH_HTTP_PORT="$ATSEARCH_HTTP_PORT" \
ATSEARCH_DHT_PORT="$ATSEARCH_DHT_PORT" \
ATSEARCH_DB_PATH="$ATSEARCH_DB_PATH" \
ATSEARCH_MODE="$ATSEARCH_MODE" \
ATSEARCH_LIBP2P_LISTEN_HOST="$ATSEARCH_LIBP2P_LISTEN_HOST" \
  "$NODE_BIN" packages/indexer/dist/index.js &
INDEXER_PID=$!
echo "Indexer started (PID $INDEXER_PID, runtime: $NODE_BIN)"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "http://localhost:${INDEXER_HTTP_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$INDEXER_PID" 2>/dev/null; then
    echo ""
    echo "ERROR: Indexer exited before HTTP came up. Common causes:"
    echo "  - better-sqlite3 / native module ABI (indexer must run with Node, not Bun — see script header)"
    echo "  - libp2p cannot bind DHT port ${ATSEARCH_DHT_PORT} (try another ATSEARCH_DHT_PORT)"
    echo "  - ATSEARCH_LIBP2P_LISTEN_HOST (default 127.0.0.1) — see README"
    exit 1
  fi
  sleep 0.4
done

if ! curl -sf "http://localhost:${INDEXER_HTTP_PORT}/health" >/dev/null 2>&1; then
  echo "ERROR: Indexer HTTP not reachable on port ${INDEXER_HTTP_PORT}"
  exit 1
fi

_HEALTH_JSON=$(curl -sf "http://localhost:${INDEXER_HTTP_PORT}/health" || true)
INDEXER_MULTIADDR=$(H="$_HEALTH_JSON" bun -e 'try{console.log(JSON.parse(process.env.H||"{}").peerId||"")}catch{console.log("")}')

if [ -n "$INDEXER_MULTIADDR" ]; then
  echo "Indexer peer ID: $INDEXER_MULTIADDR"
fi

ATSEARCH_HTTP_PORT="$QUERY_PORT" \
ATSEARCH_DHT_PORT="$QUERY_DHT_PORT" \
ATSEARCH_INDEXER_URLS="http://localhost:${INDEXER_HTTP_PORT}" \
ATSEARCH_LIBP2P_LISTEN_HOST="$ATSEARCH_LIBP2P_LISTEN_HOST" \
USE_MICROCOSM="$USE_MICROCOSM" \
MICROCOSM_SLINGSHOT_BASE_URL="$MICROCOSM_SLINGSHOT_BASE_URL" \
MICROCOSM_CONSTELLATION_BASE_URL="$MICROCOSM_CONSTELLATION_BASE_URL" \
FALLBACK_ATPROTO_XRPC_BASE_URL="$FALLBACK_ATPROTO_XRPC_BASE_URL" \
APP_USER_AGENT="$APP_USER_AGENT" \
  bun packages/query-node/dist/index.js &
QUERY_PID=$!
echo "Query node started (PID $QUERY_PID)"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "http://localhost:${QUERY_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$QUERY_PID" 2>/dev/null; then
    echo "ERROR: Query node exited before HTTP came up (port ${QUERY_PORT} in use?)."
    exit 1
  fi
  sleep 0.4
done

if ! curl -sf "http://localhost:${QUERY_PORT}/health" | grep -q microcosm; then
  echo "WARNING: Query /health response does not look like this repo's query-node (missing microcosm field)."
  echo "         You may have an old binary on port ${QUERY_PORT}; stop it and re-run."
fi

VITE_QUERY_PROXY_TARGET="http://127.0.0.1:${QUERY_PORT}" \
  bun run --filter @atsearch/demo-client dev -- --port "$DEMO_PORT" &
CLIENT_PID=$!
echo "Demo client started (PID $CLIENT_PID)"

echo ""
echo "Open http://localhost:${DEMO_PORT}"
echo "Press Ctrl+C to stop."
echo ""

wait "$INDEXER_PID" "$QUERY_PID" "$CLIENT_PID"
