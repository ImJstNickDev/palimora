#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node_include="${NODE_INCLUDE_DIR:-$(node -p "require('path').resolve(require('fs').realpathSync(process.execPath),'../../include/node')")}"
codec_include="${ZSTD_INCLUDE_DIR:-/usr/include}"
if [[ ! -f "$codec_include/zstd.h" && -f .local/native-sdk/root/usr/include/zstd.h ]]; then codec_include=.local/native-sdk/root/usr/include; fi
mkdir -p apps/api/native/build
"${CXX:-c++}" -std=c++17 -O3 -shared -fPIC -DNAPI_VERSION=8 -I"$node_include" -I"$codec_include" apps/api/native/codec.cc apps/api/native/catalog.cc -Wl,-l:libcrypto.so.3 -Wl,-l:libzstd.so.1 -o apps/api/native/build/codec.node

mkdir -p apps/ingest-adapters/native/build
"${CXX:-c++}" -std=c++17 -O3 -shared -fPIC -Wall -Wextra -Werror apps/ingest-adapters/native/html_scan.cc -o apps/ingest-adapters/native/build/html_scan.so
