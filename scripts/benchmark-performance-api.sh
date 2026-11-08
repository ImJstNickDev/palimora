#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="${1:?Private fixture root}"
name=$(cat "$root/name")
[[ "$name" == palimora-release-test-* ]] || exit 1
[[ "$(docker inspect -f '{{index .Config.Labels "palimora.test"}}' "$name-worker")" == true ]] || exit 1
docker exec "$name-worker" node scripts/performance-snapshot.cjs after-projection
docker exec -d "$name-worker" sh -c 'node apps/api/dist/main.js > /results/api.log 2>&1'
for attempt in {1..60}; do
 if docker exec "$name-worker" node -e 'fetch("http://localhost:3000/api/v1/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then break; fi
 sleep 1
done
docker exec "$name-worker" node scripts/benchmark-performance-verify.cjs
python3 - "$root" <<'PY'
import json,sys,datetime,os
root=sys.argv[1]+'/results/'
i=json.load(open(root+'ingest-default.json'));p=json.load(open(root+'projection.json'));v=json.load(open(root+'verification.json'))
start=datetime.datetime.fromisoformat(i['started_at'].replace('Z','+00:00')).timestamp()
seconds=(int(v['monotonic_ns'])-int(open(root+'start-monotonic.txt').read()))/1e9 if os.path.exists(root+'start-monotonic.txt') else v['verified_at']/1000-start
r={'scenario':'A','seconds':seconds,'works_per_second':11032/seconds,'ingest_seconds':i['engine_seconds'],'catalog_seconds':p['catalog_seconds'],'text_seconds':p['index_seconds'],'verification_seconds':v['refresh_and_verify_seconds'],'note':'Wall clock includes process startup, API startup and verification; no queue scheduler in A.'}
open(root+'end-to-end.json','w').write(json.dumps(r,indent=2));print(json.dumps(r))
PY
