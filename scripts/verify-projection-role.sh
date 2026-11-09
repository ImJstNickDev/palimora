#!/usr/bin/env bash
# Host-side fault injection affects only containers owned by this disposable fixture.
set -euo pipefail
cd "$(dirname "$0")/.."
root="${1:?Private fixture root}"
name=$(cat "$root/name")
[[ "$name" == palimora-release-test-* ]] || exit 1
[[ "$(docker inspect -f '{{index .Config.Labels "palimora.test"}}' "$name-worker")" == true ]] || exit 1
child=''
cleanup() { if [[ -n "$child" ]]; then kill "$child" 2>/dev/null || true; fi; }
trap cleanup EXIT
docker exec -e NODE_OPTIONS= -e P2D_HOST_LIFECYCLE=1 "$name-worker" node scripts/verify-projection-role.cjs > "$root/results/projection-role.log" 2>&1 & child=$!
wait_marker() {
 local marker="$1"
 for attempt in {1..2400}; do
  [[ ! -f "$root/results/$marker" ]] || return 0
  kill -0 "$child" 2>/dev/null || { wait "$child"; return 1; }
  sleep 0.1
 done
 echo "Lifecycle marker timeout: $marker" >&2; return 1
}
wait_marker role-container-start-ready
python3 scripts/p2d-projection-container.py "$root" start
touch "$root/results/role-container-started"
wait_marker role-container-restart-ready
docker restart "$name-projection" > /dev/null
touch "$root/results/role-container-restarted"
wait_marker role-pg-stop-ready
docker stop -t 10 "$name-pg" >/dev/null
sleep 2
docker start "$name-pg" >/dev/null
for attempt in {1..60}; do
 if docker exec "$name-pg" pg_isready -U postgres >/dev/null 2>&1; then break; fi
 sleep 1
done
[[ "$(docker inspect -f '{{.State.Running}}' "$name-projection")" == true ]]
touch "$root/results/role-pg-restarted"
wait_marker role-container-stop-ready
python3 scripts/p2d-projection-container.py "$root" stop
touch "$root/results/role-container-stopped"
wait "$child"; child=''
