#!/usr/bin/env bash
# Local engine-test Postgres: boot a disposable postgres:17 container,
# create Supabase parity roles, and apply the engine schema migrations.
#
# Usage:
#   tests/engine/scripts/test-db.sh up      # start + load schema (default)
#   tests/engine/scripts/test-db.sh down     # stop + remove the container
#   tests/engine/scripts/test-db.sh schema   # (re)apply schema to a running container
#
# Then run the DB tests:
#   TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test \
#     .venv/bin/python -m pytest tests/engine -q
#
# Port 5433 (not 5432) avoids colliding with a local Postgres install.
set -euo pipefail

NAME="calderyn-engine-test-db"
PORT="${TEST_DB_PORT:-5433}"
DB="calderyn_test"
PW="test"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # tests/engine
SCHEMA_DIR="$HERE/schema"

psql_run() {
  PGPASSWORD="$PW" docker exec -i "$NAME" psql -h localhost -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"
}

apply_schema() {
  echo "Creating Supabase parity roles…"
  psql_run -f - < "$SCHEMA_DIR/000_roles.sql"
  echo "Applying engine schema migrations…"
  for f in "$SCHEMA_DIR"/migrations/*.sql; do
    echo "  -> $(basename "$f")"
    psql_run -f - < "$f"
  done
  echo "Schema applied."
}

case "${1:-up}" in
  up)
    if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "Container $NAME already exists; starting it."
      docker start "$NAME" >/dev/null
    else
      docker run -d --name "$NAME" \
        -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB="$DB" \
        -p "$PORT:5432" postgres:17 >/dev/null
    fi
    echo -n "Waiting for Postgres"
    until docker exec "$NAME" pg_isready -U postgres -d "$DB" >/dev/null 2>&1; do
      echo -n "."; sleep 1
    done
    echo " ready."
    apply_schema
    echo
    echo "TEST_DATABASE_URL=postgres://postgres:$PW@localhost:$PORT/$DB"
    ;;
  schema)
    apply_schema
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "Removed $NAME."
    ;;
  *)
    echo "usage: $0 {up|down|schema}" >&2; exit 2 ;;
esac
