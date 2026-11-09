#!/usr/bin/env bash
# One of the three P3 profiles, on the authorized four-ZIP fixture only.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RELEASE_BENCH_ROOT:?Use a new /mnt/sdb/palimora-p3-final-* directory}"
: "${AO3_DUMP_ROOT:?Use the previously verified P3A partition fixture}"
case "$RELEASE_BENCH_ROOT" in /mnt/sdb/palimora-p3-final-*) ;; *) exit 1;; esac
export P0_SCENARIO=B P0_PARSERS=6 P0_COMMITS=4 BENCH_PROJECTION_MODE=isolated P3_PROFILE=1 RELEASE_KEEP=1
export BENCH_SOURCES='["part0.zip","part1.zip","part2.zip","part3.zip"]'
case "${P3_PROFILE_NAME:?Choose A, B or C}" in
 A) export RELEASE_IMAGE=${P3_BASELINE_IMAGE:-palimora-p3-baseline} INGEST_SOURCE_CONCURRENCY=4 INGEST_PRESSURE_MODE=conservative;;
 B) export RELEASE_IMAGE=${RELEASE_IMAGE:-palimora-p3-api} INGEST_SOURCE_CONCURRENCY=4 INGEST_PRESSURE_MODE=throughput-first;;
 C) export RELEASE_IMAGE=${RELEASE_IMAGE:-palimora-p3-api} INGEST_SOURCE_CONCURRENCY=2 INGEST_PRESSURE_MODE=throughput-first;;
 *) exit 1;;
esac
python3 scripts/sample-p3a-storage.py "$RELEASE_BENCH_ROOT" & sampler=$!
trap 'kill "$sampler" 2>/dev/null || true' EXIT
./scripts/benchmark-p0.sh
wait "$sampler"
name=$(cat "$RELEASE_BENCH_ROOT/name")
for script in collect-p3a-storage normalize-p3a-catalog normalize-p3a-observations; do
 docker exec "$name-worker" node "scripts/$script.cjs"
done
python3 scripts/p3a-disk-sizes.py "$RELEASE_BENCH_ROOT"
docker stop "$name-projection" "$name-worker" "$name-pg" "$name-search" "$name-redis" >/dev/null
