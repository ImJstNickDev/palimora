#!/usr/bin/env bash
set -euo pipefail
app_password="$(cat /run/secrets/database)"
psql --username "$POSTGRES_USER" --dbname postgres --set=app_password="$app_password" <<'SQL'
CREATE ROLE palimora LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE palimora OWNER palimora;
SQL
