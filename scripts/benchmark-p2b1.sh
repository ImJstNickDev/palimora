#!/usr/bin/env bash
# Full-text only; SOURCE must be a retained, stopped P2A benchmark fixture.
set -euo pipefail
cd "$(dirname "$0")/.."
source_root="${P2B1_SOURCE:?Set the cold P2A fixture root}"
result_root="${P2B1_ROOT:?Set a new private directory}"
[[ "$source_root" == /* && "$result_root" == /* && ! -e "$result_root" ]] || exit 1
old_image="${P2B1_OLD_IMAGE:-palimora-p2a-api}"
pack_root="${P2B1_PACK_ROOT:-$source_root/storage}"
new_image="${P2B1_IMAGE:?Build the P2B.1 API image first}"
name="palimora-release-test-p2b1-$$"
mkdir -m 700 "$result_root"
mkdir "$result_root"/{postgres,search,results}
chmod 777 "$result_root/search" "$result_root/results"
sampler=''
cleanup() {
 if [[ -n "$sampler" ]]; then kill "$sampler" 2>/dev/null || true; wait "$sampler" || true; fi
 docker stop -t 30 "$name-old" "$name-worker" "$name-pg" "$name-search" >/dev/null 2>&1 || true
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
  --mount "type=bind,source=$pack_root,destination=/benchmark,readonly" \
  --mount "type=bind,source=$result_root/results,destination=/results" \
  --mount "type=bind,source=$PWD/scripts,destination=/app/scripts,readonly" \
  -e DATABASE_URL=postgresql://postgres:release-test@postgres/palimora_release_test \
  -e ARCHIVE_ROOT=/benchmark/main -e UV_THREADPOOL_SIZE=8 "$image" sleep infinity >/dev/null
done
# The differential fixture loads the exact old builder alongside the new one.
mkdir "$result_root/baseline-dist"
docker cp "$name-old:/app/apps/api/dist/." "$result_root/baseline-dist/"
docker cp "$result_root/baseline-dist" "$name-worker:/app/apps/api/p2a-dist"
docker exec "$name-old" node -e 'const fs=require("fs"),c=require("crypto"); console.log(JSON.stringify({node:process.version,baseline_js_sha256:Object.fromEntries(["catalog-search","catalog-text-bulk"].map(n=>[n,c.createHash("sha256").update(fs.readFileSync("apps/api/dist/"+n+".js")).digest("hex")]))}))' > "$result_root/results/environment.json"
python3 scripts/benchmark-resources.py "$result_root/results/resources.jsonl" "$name-old" "$name-worker" "$name-pg" "$name-search" & sampler=$!
docker exec -e P2B1_LABEL=p2a-16 "$name-old" node scripts/benchmark-text-preparation.cjs > "$result_root/results/p2a-16.log" 2>&1
cp "$result_root/results/p2a-16.json" "$result_root/results/p2a-16-first.json"
cp "$result_root/results/p2a-16.log" "$result_root/results/p2a-16-first.log"
for label in sql-16 batch-16 batch-64 batch-128; do
 docker exec -e P2B1_LABEL=$label "$name-worker" node scripts/benchmark-text-preparation.cjs > "$result_root/results/$label.log" 2>&1
done
docker exec -e P2B1_LABEL=p2a-16 "$name-old" node scripts/benchmark-text-preparation.cjs > "$result_root/results/p2a-16.log" 2>&1
docker exec "$name-worker" node scripts/verify-text-bulk.cjs > "$result_root/results/faults.log" 2>&1
docker exec "$name-worker" node scripts/verify-text-preparation.cjs > "$result_root/results/preparation-fixtures.log" 2>&1
for label in sql-16 batch-64 batch-128 batch-16; do
 cp "$result_root/results/$label.json" "$result_root/results/$label-preliminary.json"
 cp "$result_root/results/$label.log" "$result_root/results/$label-preliminary.log"
 docker exec -e P2B1_LABEL=$label "$name-worker" node scripts/benchmark-text-preparation.cjs > "$result_root/results/$label.log" 2>&1
done
python3 scripts/summarize-p2b1.py "$result_root/results" > "$result_root/results/performance-p2b1.json"
