#!/usr/bin/env bash
# One complete, isolated A/B campaign; source dump is mounted read-only.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${P2C_REFERENCE_DIST:?Set compiled apps/api/dist at ad6f91ff16d8f66aaa36fd70025fbd096414cfc6}"
: "${RELEASE_BENCH_ROOT:?Set a fresh private root}"
: "${RELEASE_IMAGE:?Set the built P2 API image}"
[[ "$RELEASE_BENCH_ROOT" == /* && ! -e "$RELEASE_BENCH_ROOT" ]] || exit 1
cleanup() {
 [[ -f "$RELEASE_BENCH_ROOT/name" ]] || return 0
 local name
 name=$(cat "$RELEASE_BENCH_ROOT/name")
 [[ "$name" == palimora-release-test-* ]] || return 1
 docker stop -t 30 "$name-worker" "$name-pg" "$name-search" "$name-redis" >/dev/null 2>&1 || true
 docker rm "$name-worker" "$name-pg" "$name-search" "$name-redis" >/dev/null 2>&1 || true
 docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
export RELEASE_KEEP=1 BENCH_NODE_OPTIONS=--require=/app/scripts/performance-p2c.cjs
./scripts/benchmark-p0.sh
name=$(cat "$RELEASE_BENCH_ROOT/name")
# A retains its verifier API; B shuts down its two real processes itself.
docker exec -e NODE_OPTIONS= "$name-worker" node -e '
const fs=require("node:fs");for(const p of fs.readdirSync("/proc").filter(x=>/^\d+$/.test(x))){try{const a=fs.readFileSync(`/proc/${p}/cmdline`,"utf8").split("\0");if(a.some(x=>x.endsWith("/dist/main.js")))process.kill(Number(p),"SIGTERM")}catch{}}'
docker cp "$P2C_REFERENCE_DIST" "$name-worker:/app/apps/api/p2a-dist"
docker exec -e NODE_OPTIONS= "$name-worker" node scripts/collect-bibliography-integration.cjs > "$RELEASE_BENCH_ROOT/results/integration.log" 2>&1
docker exec -e NODE_OPTIONS= "$name-worker" node scripts/verify-p2c-documents.cjs > "$RELEASE_BENCH_ROOT/results/equivalence.log" 2>&1
