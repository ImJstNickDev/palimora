#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
name="palimora-test-${RANDOM}-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Disposable test data is in RAM; no host ports or Docker volumes are created.
docker run -d --name "$name" --label palimora.test=true --mount type=tmpfs,destination=/var/lib/postgresql/data -e POSTGRES_PASSWORD=palimora-test -e POSTGRES_DB=palimora_test postgres:17-alpine >/dev/null
for attempt in {1..40}; do
 if docker exec "$name" pg_isready -U postgres -d palimora_test >/dev/null 2>&1; then break; fi
 sleep 1
done
address="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")"
export TEST_DATABASE_URL="postgresql://postgres:palimora-test@${address}:5432/palimora_test"
npm run build
npm test
npm run test:browser
npm audit --audit-level=moderate
APP_ORIGIN=https://palimora.example.test docker compose -f infra/compose.yaml config --quiet
