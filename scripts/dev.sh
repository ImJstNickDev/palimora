#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose -p palimora-dev --env-file .local/dev.env -f infra/compose.yaml -f infra/compose.dev.yaml)
# Rebuild the compiled API/worker alongside the frontend dependencies. Existing bind data stays in place.
"${compose[@]}" up -d --build --wait api web redis ingest projection gateway
"${compose[@]}" restart gateway
