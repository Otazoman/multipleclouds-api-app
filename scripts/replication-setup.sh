#!/usr/bin/env bash
# Sets up bidirectional logical replication between every pair of nodes in
# NODES. Safe to run again: existing objects are kept, and the publication and
# subscriptions are refreshed so that new tables in schema "app" (added by
# migrations) start replicating.
#
# For each node:
#   1. the replication role (NODE_<N>_REPL_USER) exists and may replicate
#   2. publication "mc_pub" covers every table in schema "app"
#   3. one subscription per other node: mc_sub_<publisher>_to_<subscriber>,
#      with origin = none (changes received from a node are not sent on, so
#      they do not loop) and copy_data = false
#
# Run scripts/migrate.sh first: the tables must exist on every node.
#
# Adding a node to existing data: set SEED_FROM=<existing node> to copy the
# existing rows to nodes that have no subscriptions yet. Stop writes on all
# nodes while doing this (docs/operations.md).
#
# Usage: [SEED_FROM=<node>] scripts/replication-setup.sh

source "$(dirname "$0")/lib.sh"
require_psql_major 15 # \getenv

PUBLICATION=mc_pub
read -r -a nodes <<< "$NODES"
if (( ${#nodes[@]} < 2 )); then
  echo "NODES must list at least two nodes" >&2
  exit 1
fi

# Quotes a value for a libpq connection string.
conninfo_quote() {
  local value="${1//\\/\\\\}"
  printf "'%s'" "${value//\'/\\\'}"
}

# Platform of a node: aws | google | azure | postgres (default: the node name).
node_platform() {
  local platform
  platform="$(node_var "$1" PLATFORM)"
  printf '%s' "${platform:-$1}"
}

echo "-- 1. replication roles"
for node in "${nodes[@]}"; do
  case "$(node_platform "$node")" in
    aws) grant="GRANT rds_replication TO %I" ;;          # RDS / Aurora
    google | azure | postgres) grant="ALTER ROLE %I WITH REPLICATION" ;;
    *) echo "Unknown platform for $node; set NODE_${node^^}_PLATFORM" >&2; exit 1 ;;
  esac
  echo "   $node"
  REPL_PASSWORD="$(require_node_var "$node" REPL_PASSWORD)" \
    psql_admin "$node" -v repl_user="$(require_node_var "$node" REPL_USER)" \
      -v grant="$grant" <<'SQL'
\getenv repl_password REPL_PASSWORD
SELECT format('CREATE ROLE %I LOGIN', :'repl_user')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'repl_user') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'repl_user', :'repl_password') \gexec
SELECT format(:'grant', :'repl_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA app TO %I', :'repl_user') \gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA app TO %I', :'repl_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO %I', :'repl_user') \gexec
SQL
done

echo "-- 2. publications"
for node in "${nodes[@]}"; do
  echo "   $node"
  psql_admin "$node" -v pub="$PUBLICATION" <<'SQL'
SELECT count(*) = 0 AS no_tables FROM pg_tables WHERE schemaname = 'app' \gset
\if :no_tables
  \echo 'No tables in schema app; run scripts/migrate.sh first'
  \quit 3
\endif
SELECT format('CREATE PUBLICATION %I FOR TABLE %s', :'pub',
              string_agg(format('%I.%I', schemaname, tablename), ', '))
  FROM pg_tables
 WHERE schemaname = 'app'
HAVING NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = :'pub') \gexec
SELECT format('ALTER PUBLICATION %I ADD TABLE %I.%I', :'pub', t.schemaname, t.tablename)
  FROM pg_tables t
 WHERE t.schemaname = 'app'
   AND NOT EXISTS (SELECT 1 FROM pg_publication_tables p
                    WHERE p.pubname = :'pub'
                      AND p.schemaname = t.schemaname
                      AND p.tablename = t.tablename) \gexec
SQL
done

echo "-- 3. subscriptions"
for subscriber in "${nodes[@]}"; do
  sub_count="$(psql_admin "$subscriber" -At <<'SQL'
SELECT count(subname) FROM pg_subscription WHERE subname LIKE 'mc\_sub\_%';
SQL
)"
  for publisher in "${nodes[@]}"; do
    [[ "$publisher" == "$subscriber" ]] && continue
    sub="mc_sub_${publisher}_to_${subscriber}"
    exists="$(psql_admin "$subscriber" -At -v sub="$sub" <<'SQL'
SELECT count(subname) FROM pg_subscription WHERE subname = :'sub';
SQL
)"
    if [[ "$exists" == "1" ]]; then
      echo "   $sub: refresh"
      psql_admin "$subscriber" -v sub="$sub" <<'SQL'
SELECT format('ALTER SUBSCRIPTION %I REFRESH PUBLICATION WITH (copy_data = false)', :'sub') \gexec
SQL
      continue
    fi

    # Copy existing rows only into a new node (no subscriptions yet), and
    # only from the seed node.
    copy_data=false
    if [[ "${SEED_FROM:-}" == "$publisher" && "$sub_count" == "0" ]]; then
      copy_data=true
    fi
    echo "   $sub: create (copy_data = $copy_data)"

    host="$(node_var "$publisher" REPL_HOST)"
    port="$(node_var "$publisher" PORT)"
    sslmode="$(node_var "$publisher" SSLMODE)"
    conninfo="host=$(conninfo_quote "${host:-$(require_node_var "$publisher" HOST)}")"
    conninfo+=" port=$(conninfo_quote "${port:-5432}")"
    conninfo+=" dbname=$(conninfo_quote "$DB_NAME")"
    conninfo+=" user=$(conninfo_quote "$(require_node_var "$publisher" REPL_USER)")"
    conninfo+=" password=$(conninfo_quote "$(require_node_var "$publisher" REPL_PASSWORD)")"
    conninfo+=" sslmode=$(conninfo_quote "${sslmode:-require}")"

    SUB_CONNINFO="$conninfo" psql_admin "$subscriber" -v sub="$sub" \
      -v pub="$PUBLICATION" -v copy_data="$copy_data" <<'SQL'
\getenv conninfo SUB_CONNINFO
SELECT format('CREATE SUBSCRIPTION %I CONNECTION %L PUBLICATION %I WITH (origin = none, copy_data = %s)',
              :'sub', :'conninfo', :'pub', :'copy_data') \gexec
SQL
  done
done

echo "Done. Check with scripts/replication-status.sh"
