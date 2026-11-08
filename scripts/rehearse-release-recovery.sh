#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
release_root="${1:?Pass the private root of a running benchmark-release.sh fixture}"
release_name=$(cat "$release_root/name")
[[ "$release_name" == palimora-release-test-* ]] || exit 1
[[ "$(docker inspect -f '{{index .Config.Labels "palimora.test"}}' "$release_name-worker")" == true ]] || exit 1
mkdir -p "$release_root/tls"
# TLS terminates only in this private test gateway; production still uses NPM.
cat > "$release_root/web.conf" <<'CONF'
server {
 listen 443 ssl;
 ssl_certificate /etc/nginx/tls/cert.pem;
 ssl_certificate_key /etc/nginx/tls/key.pem;
 root /usr/share/nginx/html;
 resolver 127.0.0.11 valid=5s ipv6=off;
 set $backend api:3000;
 add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'" always;
 location /api/ { proxy_pass http://$backend; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
 location / { try_files $uri $uri/ /index.html; }
}
CONF
# Create first, inspect its private address, then generate the matching certificate.
docker create --name "$release_name-web" --label palimora.test=true --network "$release_name" --mount "type=bind,source=$PWD/apps/web/dist,destination=/usr/share/nginx/html,readonly" --mount "type=bind,source=$release_root/web.conf,destination=/etc/nginx/conf.d/default.conf,readonly" --mount "type=bind,source=$release_root/tls,destination=/etc/nginx/tls,readonly" nginx:1.28-alpine >/dev/null
# Docker assigns the endpoint at network connection time; start after provisional TLS.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$release_root/tls/key.pem" -out "$release_root/tls/cert.pem" -days 1 -subj /CN=release.invalid >/dev/null 2>&1
docker start "$release_name-web" >/dev/null
release_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$release_name-web")
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$release_root/tls/key.pem" -out "$release_root/tls/cert.pem" -days 1 -subj /CN=release.invalid -addext "subjectAltName=IP:$release_ip" >/dev/null 2>&1
docker exec "$release_name-web" nginx -s reload >/dev/null
export RELEASE_UI_ORIGIN="https://$release_ip" RELEASE_RESULTS="$release_root/results" NODE_EXTRA_CA_CERTS="$release_root/tls/cert.pem"
export OPENSEARCH_URL="http://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$release_name-search"):9200"
docker run -d --name "$release_name-api" --label palimora.test=true --network "$release_name" --network-alias api --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --mount "type=bind,source=$release_root/storage/main,destination=/storage,readonly" -e DATABASE_URL=postgresql://postgres:release-test@postgres/palimora_release_test -e NODE_ENV=production -e "APP_ORIGIN=$RELEASE_UI_ORIGIN" -e AUTH_KEY="$(printf 'ab%.0s' {1..32})" "${RELEASE_IMAGE:-palimora-release-api:1.0.0}" >/dev/null
for attempt in {1..60}; do if curl --cacert "$NODE_EXTRA_CA_CERTS" -fsS "$RELEASE_UI_ORIGIN/api/v1/health" >/dev/null 2>&1; then break; fi; sleep 1; done
browser_libs="$PWD/.local/browser-libs/root/usr/lib/$(uname -m)-linux-gnu"
if [[ -d "$browser_libs" ]]; then export LD_LIBRARY_PATH="$browser_libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; fi
python3 scripts/benchmark-resources.py "$release_root/results/http-resources.jsonl" "$release_name-api" "$release_name-web" "$release_name-pg" "$release_name-search" "$release_name-redis" & release_sampler=$!
trap 'kill "$release_sampler" 2>/dev/null || true; wait "$release_sampler" 2>/dev/null || true' EXIT
node scripts/verify-release-ui.cjs
kill "$release_sampler"; wait "$release_sampler"; trap - EXIT
docker stop "$release_name-api" >/dev/null
docker exec "$release_name-worker" node scripts/verify-release-recovery.cjs
docker exec -e RELEASE_VOLUME_ROOT=/benchmark/volume-boundary "$release_name-worker" node scripts/verify-volume-boundary.cjs
mapfile -t release_paths < <(python3 - "$release_root" <<'PY'
import json,sys
root=sys.argv[1]
for p in json.load(open(root+'/results/recovery.json'))['paths']:print(root+'/storage'+p.removeprefix('/benchmark'))
PY
)
# The standalone CLI runs with the application services stopped, without DB credentials.
docker stop "$release_name-worker" "$release_name-pg" "$release_name-search" "$release_name-redis" >/dev/null
env -u DATABASE_URL -u TEST_DATABASE_URL -u ARCHIVE_ROOT node packages/archive-cli/cli.cjs verify "${release_paths[@]}" > "$release_root/results/cli-verification.json"
env -u DATABASE_URL -u TEST_DATABASE_URL -u ARCHIVE_ROOT node packages/archive-cli/cli.cjs import "$release_root/standalone" "${release_paths[@]}"
python3 scripts/summarize-resources.py "$release_root/results"
