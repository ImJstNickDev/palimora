#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Called by verify.sh: isolated OpenSearch, no published ports or Docker volumes.
search_name="palimora-search-test-${RANDOM}-$$"
search_root="$(mktemp -d "${PALIMORA_TEST_ROOT:-${TMPDIR:-/tmp}}/palimora-search-XXXXXX")"
chmod 777 "$search_root"
cleanup_search() { docker rm -f "$search_name" >/dev/null 2>&1 || true; rm -rf -- "$search_root"; }
trap cleanup_search EXIT
docker run -d --name "$search_name" --label palimora.test=true --mount "type=bind,source=$search_root,destination=/usr/share/opensearch/data" -e discovery.type=single-node -e node.store.allow_mmap=false -e DISABLE_INSTALL_DEMO_CONFIG=true -e DISABLE_SECURITY_PLUGIN=true -e 'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m' opensearchproject/opensearch:2.19.4 >/dev/null
search_address="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$search_name")"
export OPENSEARCH_URL="http://${search_address}:9200"
for attempt in {1..90}; do
 if curl -fsS "$OPENSEARCH_URL/_cluster/health?wait_for_status=yellow&timeout=1s" >/dev/null 2>&1; then break; fi
 sleep 1
done
curl -fsS "$OPENSEARCH_URL/_cluster/health" >/dev/null
if [[ "${PALIMORA_VERIFY_BROWSER_ONLY:-0}" != 1 ]]; then npm test; fi
node scripts/verify-browser.cjs
