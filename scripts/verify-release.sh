#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Domain integration once, then the three operational flows with their own fixtures.
./scripts/verify.sh
./scripts/verify-backup-manager.sh
./scripts/verify-operations.sh
OPERATIONS_SPEC=maintenance.spec.ts ./scripts/verify-operations.sh
