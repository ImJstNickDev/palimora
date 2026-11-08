#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
release_root="${RELEASE_BENCH_ROOT:?Set a new private directory on the benchmark disk}"
[[ "$release_root" == /* ]] || { echo "Use an absolute benchmark root" >&2; exit 1; }
[[ ! -e "$release_root" ]] || { echo 'Benchmark root must not exist' >&2; exit 1; }
case "${P0_SCENARIO:-A}" in A|B) ;; *) echo 'P0_SCENARIO must be A or B' >&2; exit 1;; esac
case "${P0_PARSERS:-2}/${P0_COMMITS:-2}" in 1/1|2/2|6/4) ;; *) echo 'Use profile 1/1, 2/2 or 6/4' >&2; exit 1;; esac
mkdir -m 700 "$release_root"
release_name="palimora-release-test-$$"
release_dump="${AO3_DUMP_ROOT:-/mnt/teratron_data/AO3_dumper/ao3_dump/data/ao3_stories}"
mkdir "$release_root"/{postgres,search,redis,storage,results}
chmod 777 "$release_root/search"
chmod 777 "$release_root/storage" "$release_root/results"
release_sampler=''
cleanup() {
 if [[ -n "$release_sampler" ]]; then kill "$release_sampler" 2>/dev/null || true; wait "$release_sampler" 2>/dev/null || true; fi
 if [[ "${RELEASE_KEEP:-0}" != 1 ]]; then
  docker rm -f "$release_name-worker" "$release_name-api" "$release_name-web" "$release_name-pg" "$release_name-redis" "$release_name-search" >/dev/null 2>&1 || true
  docker network rm "$release_name" >/dev/null 2>&1 || true
 fi
}
trap cleanup EXIT
# No CPU/RAM limits: this run measures unconstrained throughput on a shared host.
docker network create --internal "$release_name" >/dev/null
docker run -d --name "$release_name-pg" --network "$release_name" --network-alias postgres --label palimora.test=true --mount "type=bind,source=$release_root/postgres,destination=/var/lib/postgresql/data" -e POSTGRES_PASSWORD=release-test -e POSTGRES_DB=palimora_release_test postgres:17.6-bookworm postgres -c shared_preload_libraries=pg_stat_statements -c track_io_timing=on >/dev/null
docker run -d --name "$release_name-redis" --network "$release_name" --network-alias redis --label palimora.test=true --mount "type=bind,source=$release_root/redis,destination=/data" redis:7.4.6-alpine redis-server --appendonly yes >/dev/null
docker run -d --name "$release_name-search" --network "$release_name" --network-alias opensearch --label palimora.test=true --mount "type=bind,source=$release_root/search,destination=/usr/share/opensearch/data" -e discovery.type=single-node -e node.store.allow_mmap=false -e DISABLE_INSTALL_DEMO_CONFIG=true -e DISABLE_SECURITY_PLUGIN=true -e 'OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g' opensearchproject/opensearch:2.19.4 >/dev/null
for attempt in {1..90}; do if docker exec "$release_name-search" curl -fsS localhost:9200/_cluster/health >/dev/null 2>&1 && docker exec "$release_name-pg" pg_isready -U postgres >/dev/null 2>&1; then break; fi; sleep 1; done
docker exec "$release_name-search" curl -fsS localhost:9200/_cluster/health >/dev/null
docker exec "$release_name-pg" pg_isready -U postgres >/dev/null
docker run -d --name "$release_name-worker" --network "$release_name" --label palimora.test=true --mount "type=bind,source=$release_root/storage,destination=/benchmark" --mount "type=bind,source=$release_root/results,destination=/results" --mount "type=bind,source=$release_dump,destination=/dumps/ao3_stories,readonly" --mount "type=bind,source=$PWD/scripts,destination=/app/scripts,readonly" -e DATABASE_URL=postgresql://postgres:release-test@postgres/palimora_release_test -e ARCHIVE_ROOT=/benchmark/main -e AUTH_KEY="$(printf 'ab%.0s' {1..32})" -e APP_ORIGIN=https://release.invalid -e REDIS_HOST=redis -e INGEST_GROUP_RECORDS=256 -e INGEST_PARSER_WORKERS=${P0_PARSERS:-2} -e INGEST_COMMIT_CONCURRENCY=${P0_COMMITS:-2} -e UV_THREADPOOL_SIZE=8 -e ARCHIVE_ZSTD_LEVEL=3 "${RELEASE_IMAGE:-palimora-release-api:1.0.0}" sleep infinity >/dev/null
printf '%s\n' "$release_name" > "$release_root/name"
git rev-parse HEAD > "$release_root/results/source-commit.txt"
docker image inspect --format '{{.Id}}' "${RELEASE_IMAGE:-palimora-release-api:1.0.0}" > "$release_root/results/image-id.txt"
sha256sum scripts/benchmark-p0.sh scripts/performance-*.cjs scripts/benchmark-performance*.cjs > "$release_root/results/script-checksums.txt"
python3 - "$release_root" <<'PY'
import os,json,platform,subprocess,sys,zipfile,hashlib
root=sys.argv[1];source=os.path.join(os.environ.get('AO3_DUMP_ROOT','/mnt/teratron_data/AO3_dumper/ao3_dump/data/ao3_stories'),'queue119_archive05.zip')
with zipfile.ZipFile(source) as z: entries=z.infolist();corpus={'zip_bytes':os.stat(source).st_size,'uncompressed_bytes':sum(x.file_size for x in entries),'members':len(entries),'epub_members':sum(x.filename.endswith('.epub') for x in entries)}
with open(source,'rb') as f:corpus['sha256']=hashlib.file_digest(f,'sha256').hexdigest()
assert corpus['epub_members']==11032 and corpus['sha256']=='fd8e01e155c1a668c91bd86bc67cfc9b2ac3ad9da1322a35925a74c226e85429', 'Reference corpus mismatch'
with open(root+'/results/environment.json','w') as f:json.dump({'date':subprocess.check_output(['date','--iso-8601=seconds'],text=True).strip(),'cpu':subprocess.check_output(['lscpu'],text=True),'memory':open('/proc/meminfo').read(),'platform':platform.platform(),'corpus':corpus,'docker_limits':False},f,indent=2)
PY
run_measure() {
 local label="$1" mode="$2"; shift 2
 python3 scripts/benchmark-resources.py "$release_root/results/$label-resources.jsonl" "$release_name-worker" "$release_name-pg" "$release_name-search" "$release_name-redis" & release_sampler=$!
 docker exec -e "BENCH_LABEL=$label" "$@" "$release_name-worker" node scripts/benchmark-release.cjs "$mode"
 kill "$release_sampler"; wait "$release_sampler"; release_sampler=''
}
docker exec "$release_name-pg" psql -U postgres -d palimora_release_test -c 'CREATE EXTENSION pg_stat_statements' >/dev/null
docker exec "$release_name-worker" node -e 'require("./apps/api/dist/db").migrate().then(()=>require("./apps/api/dist/db").pool.end())'
docker exec "$release_name-worker" node scripts/performance-snapshot.cjs before
if [[ "${P0_SCENARIO:-A}" == B ]]; then
 python3 scripts/benchmark-resources.py "$release_root/results/operational-resources.jsonl" "$release_name-worker" "$release_name-pg" "$release_name-search" "$release_name-redis" & release_sampler=$!
 docker exec "$release_name-worker" node scripts/benchmark-performance-operational.cjs
 kill "$release_sampler"; wait "$release_sampler"; release_sampler=''
else
 docker exec -d "$release_name-worker" node scripts/performance-queues.cjs
 python3 -c 'import time; print(time.monotonic_ns())' > "$release_root/results/start-monotonic.txt"
 run_measure ingest-default ingest
 docker exec "$release_name-worker" node scripts/performance-snapshot.cjs after-ingest
 run_measure projection project -e P0_SNAPSHOTS=1 -e P0_PROFILE=/results/projection-profile.json -e NODE_OPTIONS=--require=/app/scripts/performance-profiler.cjs
 ./scripts/benchmark-performance-api.sh "$release_root"
fi
python3 scripts/summarize-resources.py "$release_root/results"
