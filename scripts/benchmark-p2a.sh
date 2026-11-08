#!/usr/bin/env bash
# Full-text only; SOURCE must be a retained, stopped P1B.1 benchmark fixture.
set -euo pipefail
cd "$(dirname "$0")/.."
source_root="${P2A_SOURCE:?Set the cold P1B.1 fixture root}"
result_root="${P2A_ROOT:?Set a new private directory}"
[[ "$source_root" == /* && "$result_root" == /* && ! -e "$result_root" ]] || exit 1
old_image="${P2A_OLD_IMAGE:-palimora-p1b1-api}"
new_image="${P2A_IMAGE:?Build the P2A API image first}"
name="palimora-release-test-p2a-$$"
mkdir -m 700 "$result_root"
mkdir "$result_root"/{postgres,search,results}
chmod 777 "$result_root/search" "$result_root/results"
sampler=''
cleanup() {
 if [[ -n "$sampler" ]]; then kill "$sampler" 2>/dev/null || true; wait "$sampler" || true; fi
 docker rm -f "$name-old" "$name-worker" "$name-pg" "$name-search" >/dev/null 2>&1 || true
 docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Docker helper reads the cold PG directory without changing source ownership.
docker run --rm --user root --entrypoint bash \
 --mount "type=bind,source=$source_root/postgres,destination=/source,readonly" \
 --mount "type=bind,source=$result_root/postgres,destination=/target" \
 postgres:17.6-bookworm -c 'test ! -e /source/postmaster.pid && cp -a /source/. /target/'
docker network create --internal "$name" >/dev/null
docker run -d --name "$name-pg" --network "$name" --network-alias postgres \
 --mount "type=bind,source=$result_root/postgres,destination=/var/lib/postgresql/data" \
 postgres:17.6-bookworm postgres -c shared_preload_libraries=pg_stat_statements -c track_io_timing=on >/dev/null
docker run -d --name "$name-search" --network "$name" --network-alias opensearch \
 --mount "type=bind,source=$result_root/search,destination=/usr/share/opensearch/data" \
 -e discovery.type=single-node -e node.store.allow_mmap=false -e DISABLE_INSTALL_DEMO_CONFIG=true \
 -e DISABLE_SECURITY_PLUGIN=true -e 'OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g' \
 opensearchproject/opensearch:2.19.4 >/dev/null
for attempt in {1..90}; do
 if docker exec "$name-search" curl -fsS localhost:9200/_cluster/health >/dev/null 2>&1 && docker exec "$name-pg" pg_isready -U postgres >/dev/null 2>&1; then break; fi
 sleep 1
done
for variant in old worker; do
 image="$new_image"; [[ "$variant" != old ]] || image="$old_image"
 docker run -d --name "$name-$variant" --network "$name" \
  --mount "type=bind,source=$source_root/storage,destination=/benchmark,readonly" \
  --mount "type=bind,source=$result_root/results,destination=/results" \
  --mount "type=bind,source=$PWD/scripts,destination=/app/scripts,readonly" \
  -e DATABASE_URL=postgresql://postgres:release-test@postgres/palimora_release_test \
  -e ARCHIVE_ROOT=/benchmark/main -e UV_THREADPOOL_SIZE=8 "$image" sleep infinity >/dev/null
done
python3 scripts/benchmark-resources.py "$result_root/results/resources.jsonl" "$name-old" "$name-worker" "$name-pg" "$name-search" & sampler=$!
docker exec -e P2A_LABEL=old-16 "$name-old" node scripts/benchmark-text-bulk.cjs > "$result_root/results/old-16.log" 2>&1
cp "$result_root/results/old-16.json" "$result_root/results/old-16-first.json"
for size in 16 64 128; do
 docker exec -e P2A_LABEL=bulk-$size "$name-worker" node scripts/benchmark-text-bulk.cjs > "$result_root/results/bulk-$size.log" 2>&1
done
docker exec -e P2A_LABEL=old-16 "$name-old" node scripts/benchmark-text-bulk.cjs > "$result_root/results/old-16-repeat.log" 2>&1
docker exec "$name-worker" node scripts/verify-text-bulk.cjs > "$result_root/results/faults.log" 2>&1
cp "$result_root/results/bulk-16.json" "$result_root/results/bulk-16-preliminary.json"
cp "$result_root/results/bulk-16.log" "$result_root/results/bulk-16-preliminary.log"
docker exec -e P2A_LABEL=bulk-16 "$name-worker" node scripts/benchmark-text-bulk.cjs > "$result_root/results/bulk-16.log" 2>&1
python3 scripts/summarize-p2a.py "$result_root/results" > "$result_root/results/performance-p2a.json"
