#!/bin/sh
# Posts sample OTLP payloads to a running ingest and checks the responses.
# Usage: INGEST_URL=http://localhost:4318 INGEST_TOKEN=... sh test/smoke.sh
set -eu
url="${INGEST_URL:-http://localhost:4318}"
tok="$INGEST_TOKEN"
sample='{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"claude-code"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1762700000000000000","body":{"stringValue":"claude_code.user_prompt"},"attributes":[{"key":"event.name","value":{"stringValue":"user_prompt"}},{"key":"user.email","value":{"stringValue":"dev@example.com"}},{"key":"prompt","value":{"stringValue":"fix the failing test"}}]}]}]}]}'

check() {
  want="$1"; shift
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [ "$got" = "$want" ]; then echo "ok   $want $*" | cut -c1-90; else echo "FAIL want $want got $got: $*"; exit 1; fi
}

check 200 "$url/health"
check 200 -X POST "$url/v1/logs" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' -H 'X-Vsf-Source: smoke' -d "$sample"
check 200 -X POST "$url/v1/metrics" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' -d '{"resourceMetrics":[]}'
printf '%s' "$sample" | gzip | check 200 -X POST "$url/v1/logs" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' -H 'Content-Encoding: gzip' --data-binary @-
printf '\x0a\x00' | check 200 -X POST "$url/v1/traces" -H "Authorization: Bearer $tok" -H 'Content-Type: application/x-protobuf' --data-binary @-
check 401 -X POST "$url/v1/logs" -H 'Authorization: Bearer wrong' -H 'Content-Type: application/json' -d "$sample"
check 404 -X POST "$url/v1/nope" -H "Authorization: Bearer $tok" -d '{}'
echo "all checks passed"
