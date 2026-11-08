#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
release_root="${RELEASE_BENCH_ROOT:?Set a new private directory on the benchmark disk}"
[[ ! -e "$release_root" ]] || { echo 'Benchmark root must not exist' >&2; exit 1; }
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
docker run -d --name "$release_name-pg" --network "$release_name" --network-alias postgres --label palimora.test=true --mount "type=bind,source=$release_root/postgres,destination=/var/lib/postgresql/data" -e POSTGRES_PASSWORD=release-test -e POSTGRES_DB=palimora_release_test postgres:17.6-bookworm >/dev/null
docker run -d --name "$release_name-redis" --network "$release_name" --network-alias redis --label palimora.test=true --mount "type=bind,source=$release_root/redis,destination=/data" redis:7.4.6-alpine redis-server --appendonly yes >/dev/null
docker run -d --name "$release_name-search" --network "$release_name" --network-alias opensearch --label palimora.test=true --mount "type=bind,source=$release_root/search,destination=/usr/share/opensearch/data" -e discovery.type=single-node -e node.store.allow_mmap=false -e DISABLE_INSTALL_DEMO_CONFIG=true -e DISABLE_SECURITY_PLUGIN=true -e 'OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g' opensearchproject/opensearch:2.19.4 >/dev/null
for attempt in {1..90}; do if docker exec "$release_name-search" curl -fsS localhost:9200/_cluster/health >/dev/null 2>&1 && docker exec "$release_name-pg" pg_isready -U postgres >/dev/null 2>&1; then break; fi; sleep 1; done
docker run -d --name "$release_name-worker" --network "$release_name" --label palimora.test=true --mount "type=bind,source=$release_root/storage,destination=/benchmark" --mount "type=bind,source=$release_root/results,destination=/results" --mount "type=bind,source=$release_dump,destination=/dumps/ao3_stories,readonly" --mount "type=bind,source=$PWD/scripts,destination=/app/scripts,readonly" -e DATABASE_URL=postgresql://postgres:release-test@postgres/palimora_release_test -e ARCHIVE_ROOT=/benchmark/main -e AUTH_KEY="$(printf 'ab%.0s' {1..32})" -e APP_ORIGIN=https://release.invalid -e REDIS_HOST=redis -e INGEST_GROUP_RECORDS=256 -e INGEST_PARSER_WORKERS=2 -e INGEST_COMMIT_CONCURRENCY=2 -e UV_THREADPOOL_SIZE=8 -e ARCHIVE_ZSTD_LEVEL=3 "${RELEASE_IMAGE:-palimora-release-api:1.0.0}" sleep infinity >/dev/null
printf '%s\n' "$release_name" > "$release_root/name"
python3 - "$release_root" <<'PY'
import os,json,platform,subprocess,sys,zipfile,hashlib
root=sys.argv[1];source=os.path.join(os.environ.get('AO3_DUMP_ROOT','/mnt/teratron_data/AO3_dumper/ao3_dump/data/ao3_stories'),'queue119_archive05.zip')
with zipfile.ZipFile(source) as z: entries=z.infolist();corpus={'zip_bytes':os.stat(source).st_size,'uncompressed_bytes':sum(x.file_size for x in entries),'members':len(entries),'epub_members':sum(x.filename.endswith('.epub') for x in entries)}
with open(source,'rb') as f:corpus['sha256']=hashlib.file_digest(f,'sha256').hexdigest()
with open(root+'/results/environment.json','w') as f:json.dump({'date':subprocess.check_output(['date','--iso-8601=seconds'],text=True).strip(),'cpu':subprocess.check_output(['lscpu'],text=True),'memory':open('/proc/meminfo').read(),'platform':platform.platform(),'corpus':corpus,'docker_limits':False},f,indent=2)
PY
run_measure() {
 local label="$1" mode="$2"; shift 2
 python3 scripts/benchmark-resources.py "$release_root/results/$label-resources.jsonl" "$release_name-worker" "$release_name-pg" "$release_name-search" "$release_name-redis" & release_sampler=$!
 docker exec -e "BENCH_LABEL=$label" "$@" "$release_name-worker" node scripts/benchmark-release.cjs "$mode"
 kill "$release_sampler"; wait "$release_sampler"; release_sampler=''
}
run_measure ingest-default ingest
run_measure reingest reingest
run_measure incremental incremental
run_measure projection project
run_measure queries queries
run_measure packs packs
run_measure storage storage
for profile in single parallel; do
 docker exec "$release_name-pg" createdb -U postgres "palimora_${profile}_test"
 if [[ "$profile" == single ]]; then parsers=1; commits=1; else parsers=6; commits=4; fi
 run_measure "ingest-$profile" ingest -e "DATABASE_URL=postgresql://postgres:release-test@postgres/palimora_${profile}_test" -e "ARCHIVE_ROOT=/benchmark/$profile" -e "INGEST_PARSER_WORKERS=$parsers" -e "INGEST_COMMIT_CONCURRENCY=$commits"
done
run_measure checkpoint-stop reingest -e BENCH_STOP_AFTER=2048
run_measure checkpoint-resume resume
for probe in query index backup; do docker exec "$release_name-worker" node "scripts/benchmark-$probe-plan.cjs"; done
docker restart "$release_name-pg" "$release_name-search" "$release_name-worker" >/dev/null
for attempt in {1..60}; do if docker exec "$release_name-search" curl -fsS localhost:9200/_cluster/health >/dev/null 2>&1 && docker exec "$release_name-pg" pg_isready -U postgres >/dev/null 2>&1; then break; fi; sleep 1; done
run_measure verify-restarted verify -e AO3_DUMP_ROOT=/unavailable
python3 scripts/summarize-resources.py "$release_root/results"
printf 'Results: %s/results\n' "$release_root"

if [[ "${RELEASE_RECOVERY:-0}" == 1 ]]; then
 ./scripts/rehearse-release-recovery.sh "$release_root"
fi
