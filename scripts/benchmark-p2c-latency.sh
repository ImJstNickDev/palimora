#!/usr/bin/env bash
# Each invocation clones the same stopped, verified B1 database and search index.
set -euo pipefail
cd "$(dirname "$0")/.."
source_root="${P2C_SOURCE:?Set the stopped B1 fixture root}"
root="${P2C_ROOT:?Set a fresh private latency root}"
image="${P2C_IMAGE:?Set P1B.1 or P2 API image}"
[[ "$root" == /* && "$source_root" == /* && ! -e "$root" ]] || exit 1
source_name=$(cat "$source_root/name")
for service in pg search; do
 [[ "$(docker inspect --format '{{.State.Running}}' "$source_name-$service" 2>/dev/null || true)" != true ]] || { echo 'Source fixture must be stopped' >&2; exit 1; }
done
name="palimora-release-test-p2c-c-$$"
mkdir -m 700 "$root"
mkdir "$root"/{postgres,search,redis,results}
chmod 777 "$root/results"
sampler=''
cleanup() {
 if [[ -n "$sampler" ]]; then kill "$sampler" 2>/dev/null || true; wait "$sampler" || true; fi
 docker stop -t 30 "$name-worker" "$name-pg" "$name-search" "$name-redis" >/dev/null 2>&1 || true
 docker rm -f "$name-worker" "$name-pg" "$name-search" "$name-redis" >/dev/null 2>&1 || true
 docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
for data in postgres search; do
 docker run --rm --user root --entrypoint bash \
  --mount "type=bind,source=$source_root/$data,destination=/source,readonly" \
  --mount "type=bind,source=$root/$data,destination=/target" postgres:17.6-bookworm \
  -c 'test ! -e /source/postmaster.pid && cp -a /source/. /target/'
done
docker network create --internal "$name" >/dev/null
docker run -d --name "$name-pg" --network "$name" --network-alias postgres --label palimora.test=true \
 --mount "type=bind,source=$root/postgres,destination=/var/lib/postgresql/data" \
 postgres:17.6-bookworm postgres -c shared_preload_libraries=pg_stat_statements -c track_io_timing=on >/dev/null
docker run -d --name "$name-redis" --network "$name" --network-alias redis --label palimora.test=true \
 --mount "type=bind,source=$root/redis,destination=/data" redis:7.4.6-alpine redis-server --appendonly yes >/dev/null
docker run -d --name "$name-search" --network "$name" --network-alias opensearch --label palimora.test=true \
 --mount "type=bind,source=$root/search,destination=/usr/share/opensearch/data" \
 -e discovery.type=single-node -e node.store.allow_mmap=false -e DISABLE_INSTALL_DEMO_CONFIG=true \
 -e DISABLE_SECURITY_PLUGIN=true -e 'OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g' opensearchproject/opensearch:2.19.4 >/dev/null
for attempt in {1..90}; do
 if docker exec "$name-search" curl -fsS localhost:9200/_cluster/health >/dev/null 2>&1 && docker exec "$name-pg" pg_isready -U postgres >/dev/null 2>&1; then break; fi
 sleep 1
done
docker run -d --name "$name-worker" --network "$name" --label palimora.test=true \
 --mount "type=bind,source=$source_root/storage,destination=/benchmark,readonly" \
 --mount "type=bind,source=$root/results,destination=/results" \
 --mount "type=bind,source=$PWD/scripts,destination=/app/scripts,readonly" \
 --mount "type=bind,source=$PWD/apps/api/migrations,destination=/app/apps/api/migrations,readonly" \
 -e DATABASE_URL=postgresql://postgres:release-test@postgres/palimora_release_test \
 -e ARCHIVE_ROOT=/benchmark/main -e AUTH_KEY="$(printf 'ab%.0s' {1..32})" \
 -e APP_ORIGIN=https://release.invalid -e REDIS_HOST=redis -e UV_THREADPOOL_SIZE=8 \
 -e PROJECTION_TEXT_BATCH=${PROJECTION_TEXT_BATCH:-16} \
 -e PROJECTION_TEXT_PREPARE_LANES=1 -e PROJECTION_TEXT_PUBLISH_LANES=${PROJECTION_TEXT_PUBLISH_LANES:-1} \
 -e NODE_OPTIONS=--require=/app/scripts/performance-p2c.cjs \
 -e P2C_EVENT_LOOP=${P2C_EVENT_LOOP:-0} \
 -e P2C_LATENCY_PROFILE=/results/latency-api-profile.json -e P2C_HTTP_QUEUES=1 -e P2C_IDLE_SECONDS=30 \
 -e BENCH_LATENCY_WORKS=${BENCH_LATENCY_WORKS:-5000} \
 -e BENCH_LATENCY_TEXT_ONLY=${BENCH_LATENCY_TEXT_ONLY:-0} \
 -e BENCH_REGENERATE_HISTORY=${BENCH_REGENERATE_HISTORY:-1} \
 -e BENCH_REQUIRE_BIBLIOGRAPHY_BACKLOG=${BENCH_REQUIRE_BIBLIOGRAPHY_BACKLOG:-1} \
 "$image" sleep infinity >/dev/null
printf '%s\n' "$name" > "$root/name"
docker image inspect --format '{{.Id}}' "$image" > "$root/results/image-id.txt"
python3 scripts/benchmark-resources.py "$root/results/latency-resources.jsonl" "$name-worker" "$name-pg" "$name-search" "$name-redis" & sampler=$!
docker exec "$name-worker" node scripts/benchmark-projection-latency.cjs > "$root/results/latency.log" 2>&1
kill "$sampler"; wait "$sampler"; sampler=''
python3 scripts/summarize-resources.py "$root/results"
# Optional critical regressions, strictly after the timed latency/resource probe.
if [[ "${P2C_RECOVERY:-0}" == 1 ]]; then
 : "${P2C_REFERENCE_DIST:?Set the compiled P2A reference for final equivalence}"
 for probe in verify-text-concurrency verify-text-retry verify-p2c-integration; do
  docker exec -e NODE_OPTIONS= "$name-worker" node "scripts/$probe.cjs" > "$root/results/$probe.log" 2>&1
 done
 docker exec -e NODE_OPTIONS= "$name-worker" node scripts/benchmark-release.cjs verify > "$root/results/verify-objects.log" 2>&1
 docker cp "$P2C_REFERENCE_DIST" "$name-worker:/app/apps/api/p2a-dist"
 docker cp "$source_root/results/p2c-equivalence.json" "$name-worker:/results/source-checkpoint.json"
 docker exec -e NODE_OPTIONS= -e P2C_REFERENCE_REPORT=/results/source-checkpoint.json "$name-worker" node scripts/verify-p2c-documents.cjs > "$root/results/equivalence.log" 2>&1
fi
