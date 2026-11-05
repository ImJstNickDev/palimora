#!/usr/bin/env bash
set -euo pipefail
root="${APP_DATA_ROOT:-/mnt/sdb/palimora-data}"
if [[ $root != /* ]]; then echo 'APP_DATA_ROOT must be absolute' >&2; exit 1; fi
install -d -m 750 "$root" "$root/postgres" "$root/redis" "$root/opensearch"
install -d -m 700 "$root/secrets"
for name in database auth postgres; do
 if [[ ! -e "$root/secrets/$name" ]]; then
  (umask 077; openssl rand -hex 32 > "$root/secrets/$name")
 fi
 # Containers receive individual read-only bind mounts; host directory remains private.
 chmod 644 "$root/secrets/$name"
done
chown 1000:1000 "$root/opensearch"
echo 'Persistent directories and keys prepared. Existing keys preserved.'
