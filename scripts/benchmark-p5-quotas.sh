#!/usr/bin/env bash
# Short quota comparison only: does not certify sustained dump throughput.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${P5_BENCH_PREFIX:?Use a new /mnt/sdb/palimora-p3-final-* prefix}"
: "${AO3_DUMP_ROOT:?Use the verified P3 partition fixture}"
: "${RELEASE_IMAGE:?Use the immutable P4 runtime image}"
: "${P5_SUBNET_OCTET:?First of three free 10.231.x.0/24 subnets}"
for run in A B C; do
 profile=C
 if [[ "$run" == A ]]; then profile=B; fi
 BENCH_SUBNET="10.231.$P5_SUBNET_OCTET.0/24" BENCH_QUOTAS=1 \
 P3_PROFILE_NAME="$profile" RELEASE_BENCH_ROOT="$P5_BENCH_PREFIX-$run-final" \
 P2D_DIAGNOSTICS=1 P2C_EVENT_LOOP=1 ./scripts/benchmark-p3-final.sh
 P5_SUBNET_OCTET=$((P5_SUBNET_OCTET+1))
done
python3 scripts/summarize-p5.py "$P5_BENCH_PREFIX"
