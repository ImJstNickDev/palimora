#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
backup_test_container="palimora-backup-test-$RANDOM-$$"
trap 'docker rm -f "$backup_test_container" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$backup_test_container" --label palimora.test=true --mount type=tmpfs,destination=/var/lib/postgresql/data -e POSTGRES_PASSWORD=palimora-test -e POSTGRES_DB=palimora_backup_test postgres:17-alpine >/dev/null
for attempt in {1..40}; do
 if docker exec "$backup_test_container" pg_isready -h 127.0.0.1 -U postgres -d palimora_backup_test >/dev/null 2>&1; then break; fi
 sleep 1
done
docker exec "$backup_test_container" psql -h 127.0.0.1 -U postgres -d palimora_backup_test -v ON_ERROR_STOP=1 -c "CREATE ROLE backup_owner LOGIN CREATEDB PASSWORD 'backup-test'; ALTER DATABASE palimora_backup_test OWNER TO backup_owner; ALTER SCHEMA public OWNER TO backup_owner;" >/dev/null
backup_test_address="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$backup_test_container")"
TEST_DATABASE_URL="postgresql://backup_owner:backup-test@${backup_test_address}:5432/palimora_backup_test" npx tsx --test --test-concurrency=1 tests/backup-engine.test.ts "$@"
