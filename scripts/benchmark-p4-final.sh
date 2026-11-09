#!/usr/bin/env bash
# Same four-source fixture and profiler as P3, paired A/B then B/A.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${P4_BENCH_PREFIX:?Use a new /mnt/sdb/palimora-p3-final-* prefix}"
: "${AO3_DUMP_ROOT:?Use the verified four-source P3 fixture}"
: "${P4_BASELINE_IMAGE:?Build b23b9e0 before running}"
: "${P4_CANDIDATE_IMAGE:?Build the candidate before running}"
: "${P4_SUBNET_OCTET:?First of four free 10.231.x.0/24 subnets}"
for run in A1 B1 B2 A2; do
 case "$run" in A*) image=$P4_BASELINE_IMAGE;; B*) image=$P4_CANDIDATE_IMAGE;; esac
 BENCH_SUBNET="10.231.$P4_SUBNET_OCTET.0/24" P3_PROFILE_NAME=B \
 RELEASE_IMAGE="$image" RELEASE_BENCH_ROOT="$P4_BENCH_PREFIX-$run-final" \
 P2D_DIAGNOSTICS=1 P2C_EVENT_LOOP=1 ./scripts/benchmark-p3-final.sh
 P4_SUBNET_OCTET=$((P4_SUBNET_OCTET + 1))
done
python3 scripts/summarize-p4-final.py "$P4_BENCH_PREFIX"
