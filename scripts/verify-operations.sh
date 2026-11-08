#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ops_name="palimora-ops-test-$RANDOM-$$"
ops_root="$(mktemp -d -t palimora-ops-XXXXXX)"
cleanup(){
if [[ $? -ne 0 ]]; then
  cp "$ops_root/api.log" .local/operations-failure.log 2>/dev/null || true
  docker inspect -f '{{.Name}} {{json .NetworkSettings.Networks}}' "$ops_name-collector" "$ops_name-proxy" >&2 || true
  docker logs --tail 20 "$ops_name-collector" >&2 || true
  curl --max-time 5 -sS "$OPERATIONS_COLLECTOR_URL/snapshot" >&2 || true
fi
docker rm -f "$ops_name-pg" "$ops_name-redis" "$ops_name-search" "$ops_name-proxy" "$ops_name-collector" "$ops_name-foreign" >/dev/null 2>&1 || true; docker network rm "$ops_name-metrics" >/dev/null 2>&1 || true; rm -rf -- "$ops_root"; }
trap cleanup EXIT
mkdir -p "$ops_root/storage" "$ops_root/search"
chmod 777 "$ops_root/search"
docker run -d --name "$ops_name-pg" --label palimora.test=true --label "com.docker.compose.project=$ops_name" --label com.docker.compose.service=postgres --mount type=tmpfs,destination=/var/lib/postgresql/data -e POSTGRES_PASSWORD=fixture -e POSTGRES_DB=palimora_ops_test postgres:17-alpine >/dev/null
docker run -d --name "$ops_name-redis" --label palimora.test=true --label "com.docker.compose.project=$ops_name" --label com.docker.compose.service=redis --mount type=tmpfs,destination=/data redis:7.4.6-alpine >/dev/null
docker run -d --name "$ops_name-foreign" --label palimora.test=true --label "com.docker.compose.project=$ops_name-foreign" --label com.docker.compose.service=redis --mount type=tmpfs,destination=/data redis:7.4.6-alpine >/dev/null
docker run -d --name "$ops_name-search" --label palimora.test=true --label "com.docker.compose.project=$ops_name" --label com.docker.compose.service=opensearch --mount "type=bind,source=$ops_root/search,destination=/usr/share/opensearch/data" -e discovery.type=single-node -e node.store.allow_mmap=false -e DISABLE_INSTALL_DEMO_CONFIG=true -e DISABLE_SECURITY_PLUGIN=true -e 'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m' opensearchproject/opensearch:2.19.4 >/dev/null
docker network create --internal "$ops_name-metrics" >/dev/null
docker run -d --name "$ops_name-proxy" --label palimora.test=true --label "com.docker.compose.project=$ops_name" --label com.docker.compose.service=metrics-proxy --network "$ops_name-metrics" --network-alias metrics-proxy --read-only --cap-drop ALL --security-opt no-new-privileges --mount type=bind,source=/var/run/docker.sock,destination=/var/run/docker.sock,readonly --mount "type=bind,source=$PWD/apps/ops-collector,destination=/app,readonly" -e "PALIMORA_PROJECT=$ops_name" node:22.21.1-bookworm-slim node /app/proxy.cjs >/dev/null
docker run -d --name "$ops_name-collector" --label palimora.test=true --label "com.docker.compose.project=$ops_name" --label com.docker.compose.service=collector --network "$ops_name-metrics" --read-only --user node --cap-drop ALL --security-opt no-new-privileges --mount "type=bind,source=$PWD/apps/ops-collector,destination=/app,readonly" node:22.21.1-bookworm-slim node /app/collector.cjs >/dev/null
docker network connect bridge "$ops_name-collector"
ops_host="$(docker inspect -f '{{.NetworkSettings.Networks.bridge.IPAddress}}' "$ops_name-pg")"
export TEST_DATABASE_URL="postgresql://postgres:fixture@$ops_host:5432/palimora_ops_test"
export REDIS_HOST="$(docker inspect -f '{{.NetworkSettings.Networks.bridge.IPAddress}}' "$ops_name-redis")"
export OPENSEARCH_URL="http://$(docker inspect -f '{{.NetworkSettings.Networks.bridge.IPAddress}}' "$ops_name-search"):9200"
export OPERATIONS_COLLECTOR_URL="http://$(docker inspect -f "{{(index .NetworkSettings.Networks \"$ops_name-metrics\").IPAddress}}" "$ops_name-collector"):9100"
export OPERATIONS_PROXY_URL="http://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$ops_name-proxy"):9101"
export OPERATIONS_TEST_PREFIX="$ops_name"
export OPERATIONS_TEST_ROOT="$ops_root"
export ARCHIVE_ROOT="$ops_root/storage"
for attempt in {1..90}; do if curl -fsS "$OPENSEARCH_URL/_cluster/health?wait_for_status=yellow&timeout=1s" >/dev/null 2>&1; then break; fi; sleep 1; done
curl -fsS "$OPENSEARCH_URL/_cluster/health" >/dev/null
browser_libs="$PWD/.local/browser-libs/root/usr/lib/$(uname -m)-linux-gnu"
if [[ -d "$browser_libs" ]]; then export LD_LIBRARY_PATH="$browser_libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; fi
node node_modules/@playwright/test/cli.js test --config playwright.operations.config.ts
