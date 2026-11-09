#!/usr/bin/env bash
# Exact P3A implementations with the same image dependencies as the candidate.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RELEASE_IMAGE:?Build the candidate API image first}"
: "${P3_BASELINE_IMAGE:?Choose a local baseline image name}"
fixture_build=$(mktemp -d)
trap 'rm -rf -- "$fixture_build"' EXIT
for module in ingest-worker ingest-sources pack; do
 git show "c8a75c0acfbd4cf1417c0d8b4fe4c2b2133be23e:apps/api/src/$module.ts" > "$fixture_build/$module.ts"
done
git show c8a75c0acfbd4cf1417c0d8b4fe4c2b2133be23e:apps/ingest-adapters/ao3.py > "$fixture_build/ao3.py"
node - "$fixture_build" <<'JS'
const fs=require('node:fs'),ts=require('typescript'),path=require('node:path');
const dir=process.argv[2];
for(const name of ['ingest-worker','ingest-sources','pack'])fs.writeFileSync(path.join(dir,name+'.js'),ts.transpileModule(fs.readFileSync(path.join(dir,name+'.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText);
JS
cat > "$fixture_build/Dockerfile" <<'DOCKER'
ARG API_IMAGE
FROM ${API_IMAGE}
COPY --chown=node:node *.js /app/apps/api/dist/
COPY --chown=node:node ao3.py /app/apps/ingest-adapters/ao3.py
DOCKER
docker build --build-arg "API_IMAGE=$RELEASE_IMAGE" -t "$P3_BASELINE_IMAGE" "$fixture_build"
