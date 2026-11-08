#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="${1:?Private fixture root}"
name=$(cat "$root/name")
[[ "$name" == palimora-release-test-* ]] || exit 1
[[ "$(docker inspect -f '{{index .Config.Labels "palimora.test"}}' "$name-worker")" == true ]] || exit 1
for repeat in 1 2; do
 for profile in single default parallel; do
  case "$profile" in single) parsers=1; commits=1;; default) parsers=2; commits=2;; parallel) parsers=6; commits=4;; esac
  label="p0-$profile-$repeat"
  db="palimora_p0_${profile}_${repeat}_test"
  docker exec "$name-pg" createdb -U postgres "$db"
  python3 scripts/benchmark-resources.py "$root/results/$label-resources.jsonl" "$name-worker" "$name-pg" "$name-search" "$name-redis" & sampler=$!
  trap 'kill "$sampler" 2>/dev/null || true' EXIT
  docker exec -e "DATABASE_URL=postgresql://postgres:release-test@postgres/$db" -e "ARCHIVE_ROOT=/benchmark/$label" -e "INGEST_PARSER_WORKERS=$parsers" -e "INGEST_COMMIT_CONCURRENCY=$commits" -e "BENCH_LABEL=$label" "$name-worker" node scripts/benchmark-release.cjs ingest
  kill "$sampler"; wait "$sampler"; trap - EXIT
 done
done
python3 scripts/summarize-resources.py "$root/results"
