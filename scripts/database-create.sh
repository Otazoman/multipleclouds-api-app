#!/usr/bin/env bash
# Creates the database DB_NAME on every node in NODES (or the nodes given as
# arguments) when it does not exist yet, then prints the collation of the
# database on every node. Run it first, before scripts/migrate.sh.
#
# Every node needs the same collation: reads come from the API's own cloud,
# so a different collation would sort the same rows differently per cloud.
# The default, PostgreSQL's builtin C.UTF-8 locale, does not depend on the
# operating system of the managed database. DB_CREATE_OPTIONS (nodes.env)
# replaces it; it is used only when a database is created.
#
# Usage: scripts/database-create.sh [node ...]

source "$(dirname "$0")/lib.sh"

DB_CREATE_OPTIONS="${DB_CREATE_OPTIONS:-LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'}"

targets=("$@")
if (( ${#targets[@]} == 0 )); then
  read -r -a targets <<< "$NODES"
fi

for node in "${targets[@]}"; do
  echo "== $node"
  # Connect to the maintenance database "postgres": DB_NAME may not exist.
  # CREATE DATABASE cannot run in a transaction, hence \gexec.
  DB_NAME=postgres psql_admin "$node" -v db="$DB_NAME" -v options="$DB_CREATE_OPTIONS" <<'SQL'
SELECT format('CREATE DATABASE %I TEMPLATE template0 ENCODING ''UTF8'' %s', :'db', :'options')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SQL
done

# Compared: what decides the default collation (the locale with the builtin
# or ICU provider; the OS collation with libc, whose names differ between
# platforms, e.g. en_US.utf8 / en_US.UTF-8).
echo "== collation of $DB_NAME (must be the same on every node)"
read -r -a all_nodes <<< "$NODES"
collations=()
for node in "${all_nodes[@]}"; do
  line="$(DB_NAME=postgres psql_admin "$node" -At -F '|' -v db="$DB_NAME" <<'SQL'
SELECT CASE datlocprovider WHEN 'c' THEN 'libc ' || datcollate
                           WHEN 'b' THEN 'builtin ' || datlocale
                           ELSE 'icu ' || datlocale END,
       'collate=' || datcollate || ' ctype=' || datctype
  FROM pg_database WHERE datname = :'db';
SQL
)" || line="(unreachable)"
  echo "   $node: ${line/|/  (}${line:+)}"
  collations+=("${line%%|*}")
done
if (( $(printf '%s\n' "${collations[@]}" | sort -u | wc -l) > 1 )); then
  echo "WARNING: the nodes differ; recreate the database where it differs before it holds data" >&2
  exit 1
fi
