#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="${1:?Private fixture root}"
name=$(cat "$root/name")
[[ "$name" == palimora-release-test-* ]] || exit 1
[[ "$(docker inspect -f '{{index .Config.Labels "palimora.test"}}' "$name-worker")" == true ]] || exit 1
for mode in off node python; do
 db="palimora_p0_${mode}_test"
 docker exec "$name-pg" createdb -U postgres "$db"
 extra=()
 if [[ "$mode" == node ]]; then extra=(-e BENCH_DETAIL=1 -e BENCH_CPU_PROFILE=/results/ingest.cpuprofile -e NODE_OPTIONS=--require=/app/scripts/performance-json.cjs -e P0_JSON_PROFILE=/results/node-json.json); fi
 if [[ "$mode" == python ]]; then extra=(-e PYTHONPATH=/app/scripts/p0-python -e P0_PYTHON_PROFILE=/results/python); fi
 docker exec -e "DATABASE_URL=postgresql://postgres:release-test@postgres/$db" -e "ARCHIVE_ROOT=/benchmark/$mode" -e BENCH_DETAIL=0 -e "BENCH_LABEL=overhead-$mode" "${extra[@]}" "$name-worker" node scripts/benchmark-release.cjs ingest
done
