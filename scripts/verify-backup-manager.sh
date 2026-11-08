#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
backup_manager_name="palimora-backup-manager-$RANDOM-$$"
backup_manager_root="$(mktemp -d -t palimora-backup-manager-XXXXXX)"
cleanup(){ docker rm -f "$backup_manager_name" "$backup_manager_name-redis" >/dev/null 2>&1 || true; rm -rf -- "$backup_manager_root"; }
trap cleanup EXIT
docker run -d --name "$backup_manager_name" --label palimora.test=true --mount type=tmpfs,destination=/var/lib/postgresql/data -e POSTGRES_PASSWORD=fixture -e POSTGRES_DB=palimora_manager_test postgres:17-alpine >/dev/null
for attempt in {1..40}; do if docker exec "$backup_manager_name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi; sleep 1; done
backup_manager_host="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$backup_manager_name")"
export TEST_DATABASE_URL="postgresql://postgres:fixture@$backup_manager_host:5432/palimora_manager_test"
docker exec "$backup_manager_name" createdb -h 127.0.0.1 -U postgres palimora_restore_test
docker exec "$backup_manager_name" createdb -h 127.0.0.1 -U postgres palimora_corpus_test
docker run -d --name "$backup_manager_name-redis" --label palimora.test=true --mount type=tmpfs,destination=/data redis:7.4.6-alpine >/dev/null
export REDIS_HOST="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$backup_manager_name-redis")"
export ARCHIVE_ROOT="$backup_manager_root/storage"
export BACKUP_CONFIG_FILE="$backup_manager_root/config.json"
export BACKUP_VOLUME_BYTES=4096
export BACKUP_MANAGER_ROOT="$backup_manager_root"
export BACKUP_TEST_RESTORE_URL="postgresql://postgres:fixture@$backup_manager_host:5432/palimora_restore_test"
export BACKUP_TEST_CORPUS_URL="postgresql://postgres:fixture@$backup_manager_host:5432/palimora_corpus_test"
python3 - <<'PY'
import os,json
from pathlib import Path
root=Path(os.environ['BACKUP_MANAGER_ROOT']);(root/'storage').mkdir();(root/'disk').mkdir();(root/'disk'/'.palimora-backup-target').write_text('browser-fixture')
st=(root/'disk').stat();device=f'{os.major(st.st_dev)}:{os.minor(st.st_dev)}'
(root/'restore-url').write_text(os.environ['BACKUP_TEST_RESTORE_URL'])
(root/'corpus-url').write_text(os.environ['BACKUP_TEST_CORPUS_URL'])
config={'destinations':[{'name':'disk','label':'Disco di verifica','path':str(root/'disk'),'marker':'browser-fixture','device':device,'reserveBytes':0},{'name':'missing','label':'NAS non montato','path':str(root/'disk'),'marker':'missing','device':'9999:9999','reserveBytes':0}], 'restores':[{'name':'isolated','label':'Istanza isolata','databaseUrlFile':str(root/'restore-url'),'storage':str(root/'restored')},{'name':'platform','label':'Corpus isolato','databaseUrlFile':str(root/'corpus-url'),'storage':str(root/'imported')}]}
(root/'config.json').write_text(json.dumps(config))
PY
browser_libs="$PWD/.local/browser-libs/root/usr/lib/$(uname -m)-linux-gnu"
if [[ -d "$browser_libs" ]]; then export LD_LIBRARY_PATH="$browser_libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; fi
node node_modules/@playwright/test/cli.js test --config playwright.backups.config.ts
