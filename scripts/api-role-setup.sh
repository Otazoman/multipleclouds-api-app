#!/usr/bin/env bash
# Creates the role the API connects as (NODE_<N>_API_USER) on every node in
# NODES (or the nodes given as arguments) and grants it read/write access to
# schema "app", including tables added by later migrations, and EXECUTE on the
# write-routing functions in schema "ops" (migrations/0002_cluster_state.sql).
# Safe to run again; the password is reset to NODE_<N>_API_PASSWORD each time.
#
# Run scripts/migrate.sh first: the functions must exist.
#
# Usage: scripts/api-role-setup.sh [node ...]

source "$(dirname "$0")/lib.sh"
require_psql_major 15 # \getenv

targets=("$@")
if (( ${#targets[@]} == 0 )); then
  read -r -a targets <<< "$NODES"
fi

for node in "${targets[@]}"; do
  echo "== $node"
  API_PASSWORD="$(require_node_var "$node" API_PASSWORD)" \
    psql_admin "$node" -v api_user="$(require_node_var "$node" API_USER)" <<'SQL'
\getenv api_password API_PASSWORD
SELECT format('CREATE ROLE %I LOGIN', :'api_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'api_user') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'api_user', :'api_password') \gexec
SELECT format('GRANT USAGE ON SCHEMA app TO %I', :'api_user') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO %I', :'api_user') \gexec
-- Tables created later by the admin (migrations).
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'api_user') \gexec
-- Write routing: functions only, no access to the ops tables.
SELECT format('GRANT USAGE ON SCHEMA ops TO %I', :'api_user') \gexec
SELECT format('GRANT EXECUTE ON FUNCTION ops.get_cluster_state(), ops.assert_primary(bigint), ops.wait_for_peers(integer, integer) TO %I', :'api_user') \gexec
SQL
done
