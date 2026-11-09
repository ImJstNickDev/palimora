#!/usr/bin/env bash
# Same image/dependencies; only the sequential reference worker is restored.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RELEASE_IMAGE:?Build the current API image first}"
: "${P3A_BASELINE_IMAGE:?Choose a local benchmark image name}"
fixture_build=$(mktemp -d)
trap 'rm -rf -- "$fixture_build"' EXIT
git show 6928e8844345f5b28ddddfb556c908aa32f4d897:apps/api/src/ingest-worker.ts > "$fixture_build/ingest-worker.ts"
node - "$fixture_build" <<'JS'
const fs=require('node:fs'),ts=require('typescript'),path=require('node:path');
const dir=process.argv[2];
fs.writeFileSync(path.join(dir,'ingest-worker.js'),ts.transpileModule(fs.readFileSync(path.join(dir,'ingest-worker.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText);
JS
cat > "$fixture_build/Dockerfile" <<'DOCKER'
ARG API_IMAGE
FROM ${API_IMAGE}
COPY --chown=node:node ingest-worker.js /app/apps/api/dist/ingest-worker.js
DOCKER
docker build --build-arg "API_IMAGE=$RELEASE_IMAGE" -t "$P3A_BASELINE_IMAGE" "$fixture_build"
