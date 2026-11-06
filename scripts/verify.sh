#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# A locally extracted Chromium SDK supports hosts without system browser libraries.
browser_libs="$PWD/.local/browser-libs/root/usr/lib/$(uname -m)-linux-gnu"
if [[ -d "$browser_libs" ]]; then
 export LD_LIBRARY_PATH="$browser_libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
name="palimora-test-${RANDOM}-$$"
verify_storage="$(mktemp -d -t palimora-verify-storage-XXXXXX)"
export ARCHIVE_ROOT="$verify_storage"
cleanup() { docker rm -f "$name" "${name}-redis" >/dev/null 2>&1 || true; rm -rf -- "$verify_storage"; }
trap cleanup EXIT
# Disposable test data is in RAM; no host ports or Docker volumes are created.
docker run -d --name "$name" --label palimora.test=true --mount type=tmpfs,destination=/var/lib/postgresql/data -e POSTGRES_PASSWORD=palimora-test -e POSTGRES_DB=palimora_test postgres:17-alpine >/dev/null
for attempt in {1..40}; do
 if docker exec "$name" pg_isready -U postgres -d palimora_test >/dev/null 2>&1; then break; fi
 sleep 1
done
address="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")"
export TEST_DATABASE_URL="postgresql://postgres:palimora-test@${address}:5432/palimora_test"
docker run -d --name "${name}-redis" --label palimora.test=true --mount type=tmpfs,destination=/data redis:7.4.6-alpine >/dev/null
export REDIS_HOST="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${name}-redis")"
npm run build
npm test
npm run test:browser
npm audit --audit-level=moderate
APP_ORIGIN=https://palimora.example.test docker compose -f infra/compose.yaml config --quiet
