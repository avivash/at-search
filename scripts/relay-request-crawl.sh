#!/usr/bin/env bash
set -euo pipefail

# Request that the local Indigo relay crawl a PDS host.
#
# Usage:
#   RELAY_ADMIN_PASSWORD=dummy ./scripts/relay-request-crawl.sh shiitake.us-east.host.bsky.network
#
# If you mapped ports per docker-compose.yml, the relay admin endpoint is on localhost:12470.

HOSTNAME="${1:-}"
if [[ -z "$HOSTNAME" ]]; then
  echo "Usage: RELAY_ADMIN_PASSWORD=... $0 <pds-hostname>"
  exit 1
fi

: "${RELAY_ADMIN_PASSWORD:?RELAY_ADMIN_PASSWORD must be set}"

curl -sS -u "admin:${RELAY_ADMIN_PASSWORD}" \
  -H 'content-type: application/json' \
  --data "{\"hostname\":\"${HOSTNAME}\"}" \
  "http://127.0.0.1:12470/admin/pds/requestCrawl" \
  | sed 's/.*/RELAY RESPONSE: &/'

