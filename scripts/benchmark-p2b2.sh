#!/usr/bin/env bash
# Full-text only. Cold PostgreSQL fixture and canonical packs are read-only sources.
set -euo pipefail
cd "$(dirname "$0")/.."
source_root="${P2B2_SOURCE:?Set a retained, stopped P2B.1 fixture root}"
result_root="${P2B2_ROOT:?Set a new private directory}"
pack_root="${P2B2_PACK_ROOT:?Set the canonical storage root}"
old_image="${P2B2_OLD_IMAGE:?Build API image at 641755db939b629ddef39a311dcca9ab445e89ec}"
new_image="${P2B2_IMAGE:?Build the current API image}"
[[ "$source_root" == /* && "$result_root" == /* && ! -e "$result_root" ]] || exit 1
name="palimora-release-test-p2b2-$$"
mkdir -m 700 "$result_root"
mkdir "$result_root"/{postgres,search,search-reference,results}
chmod 777 "$result_root/search" "$result_root/results"
sampler=''
cleanup() {
 if [[ -n "$sampler" ]]; then kill "$sampler" 2>/dev/null || true; wait "$sampler" || true; fi
 docker stop -t 30 "$name-old" "$name-worker" "$name-pg" "$name-search" >/dev/null 2>&1 || true
 docker rm -f "$name-old" "$name-worker" "$name-pg" "$name-search" >/dev/null 2>&1 || true
 docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
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
wait_search() {
 for attempt in {1..90}; do
  if docker exec "$name-search" curl -fsS localhost:9200/_cluster/health >/dev/null 2>&1; then return; fi
  sleep 1
 done
 return 1
}
wait_search
until docker exec "$name-pg" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
for variant in old worker; do
 image="$new_image"; [[ "$variant" != old ]] || image="$old_image"
 docker run -d --name "$name-$variant" --network "$name" \
  --mount "type=bind,source=$pack_root,destination=/benchmark,readonly" \
  --mount "type=bind,source=$result_root/results,destination=/results" \
  --mount "type=bind,source=$PWD/scripts,destination=/app/scripts,readonly" \
  -e DATABASE_URL=postgresql://postgres:release-test@postgres/palimora_release_test \
  -e ARCHIVE_ROOT=/benchmark/main -e UV_THREADPOOL_SIZE=8 "$image" sleep infinity >/dev/null
done
python3 scripts/benchmark-resources.py "$result_root/results/resources.jsonl" "$name-old" "$name-worker" "$name-pg" "$name-search" & sampler=$!
# Seed an index, then checkpoint it once. Every measured profile replaces the
# same populated segment state with a fresh JVM, never an accumulated reindex.
docker exec -e P2B2_LABEL=legacy-16 "$name-old" node scripts/benchmark-text-concurrency.cjs > "$result_root/results/legacy-16.log" 2>&1
mv "$result_root/results/legacy-16.json" "$result_root/results/seed.json"
mv "$result_root/results/legacy-16.log" "$result_root/results/seed.log"
docker exec "$name-search" curl -fsS -X DELETE localhost:9200/_search/scroll/_all >/dev/null
docker exec "$name-search" curl -fsS -X POST 'localhost:9200/_flush?wait_if_ongoing=true' >/dev/null
for attempt in {1..90}; do
 active=$(docker exec "$name-search" curl -fsS 'localhost:9200/_nodes/stats/indices?filter_path=nodes.*.indices.merges.current,nodes.*.indices.indexing.index_current')
 if python3 -c 'import json,sys; n=json.load(sys.stdin)["nodes"].values(); sys.exit(any(v["indices"]["merges"]["current"] or v["indices"]["indexing"]["index_current"] for v in n))' <<< "$active"; then break; fi
 sleep 1
done
docker stop -t 30 "$name-search" >/dev/null
docker run --rm --user root --entrypoint bash \
 --mount "type=bind,source=$result_root/search,destination=/source,readonly" \
 --mount "type=bind,source=$result_root/search-reference,destination=/target" \
 postgres:17.6-bookworm -c 'cp -a /source/. /target/'
touch "$result_root/search/.p2b2-fixture"
reset_search() {
 docker stop -t 30 "$name-search" >/dev/null
 docker run --rm --user root --entrypoint bash \
  --mount "type=bind,source=$result_root/search,destination=/active" \
  --mount "type=bind,source=$result_root/search-reference,destination=/snapshot,readonly" \
  postgres:17.6-bookworm -c 'test -f /active/.p2b2-fixture && find /active -mindepth 1 -maxdepth 1 ! -name .p2b2-fixture -exec rm -rf -- {} + && cp -a /snapshot/. /active/'
 docker start "$name-search" >/dev/null
 wait_search
}
# Repeat the baseline/default and the promising two-publisher profiles. No 128:
# the bounded 16/64 comparison is enough to assess publishing saturation.
for label in legacy-16 serial-16 p11-16 p21-16 p12-16 p11-64 p12-64 legacy-16-repeat p11-16-repeat p12-16-repeat p12-64-repeat; do
 reset_search
 variant=worker; [[ "$label" != legacy* ]] || variant=old
 docker exec -e P2B2_LABEL="$label" "$name-$variant" node scripts/benchmark-text-concurrency.cjs > "$result_root/results/$label.log" 2>&1
done
python3 scripts/summarize-p2b2.py "$result_root/results" > "$result_root/results/performance-p2b2.json"
