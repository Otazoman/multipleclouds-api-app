#!/usr/bin/env bash
# Applies migrations/*.sql, in file-name order, to every node in NODES (or to
# the nodes given as arguments). Each file runs in one transaction and is
# recorded in ops.schema_migrations, so the script can be run again safely.
#
# Usage: scripts/migrate.sh [node ...]

source "$(dirname "$0")/lib.sh"

targets=("$@")
if (( ${#targets[@]} == 0 )); then
  read -r -a targets <<< "$NODES"
fi

for node in "${targets[@]}"; do
  echo "== $node"
  # ops.* is not in schema "app", so it is never replicated.
  psql_admin "$node" -c "CREATE SCHEMA IF NOT EXISTS ops" \
    -c "CREATE TABLE IF NOT EXISTS ops.schema_migrations (
          version text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now())"

  for file in "$REPO_DIR"/migrations/*.sql; do
    version="$(basename "$file" .sql)"
    applied="$(psql_admin "$node" -At -v version="$version" <<'SQL'
SELECT count(*) FROM ops.schema_migrations WHERE version = :'version';
SQL
)"
    if [[ "$applied" == "1" ]]; then
      continue
    fi
    echo "   applying $version"
    psql_admin "$node" -1 -v version="$version" -f "$file" -f - <<'SQL'
INSERT INTO ops.schema_migrations (version) VALUES (:'version');
SQL
  done
done
