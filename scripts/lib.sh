#!/usr/bin/env bash
# Shared helpers for the database scripts. Source this file; do not run it.
#
# Node settings come from the file in NODES_FILE (default:
# replication/nodes.env, see replication/nodes.env.sample). Passwords may be
# left out of the file and exported in the environment instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
NODES_FILE="${NODES_FILE:-$REPO_DIR/replication/nodes.env}"

if [[ ! -f "$NODES_FILE" ]]; then
  echo "Node settings not found: $NODES_FILE (copy replication/nodes.env.sample)" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$NODES_FILE"

# Fail fast when a database is unreachable (psql waits indefinitely otherwise)
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"

: "${NODES:?NODES must list the participating nodes, e.g. \"aws google azure\"}"
: "${DB_NAME:?DB_NAME is required}"

# Prints the value of NODE_<NODE>_<FIELD> (e.g. node_var aws HOST).
node_var() {
  local name="NODE_${1^^}_$2"
  printf '%s' "${!name:-}"
}

# Like node_var, but fails when the value is empty.
require_node_var() {
  local value
  value="$(node_var "$1" "$2")"
  if [[ -z "$value" ]]; then
    echo "NODE_${1^^}_$2 is required" >&2
    exit 1
  fi
  printf '%s' "$value"
}

# Runs psql on a node as its admin user. Extra arguments go to psql.
# The password is passed through PGPASSWORD, never on the command line.
psql_admin() {
  local node="$1" sslmode port
  shift
  sslmode="$(node_var "$node" SSLMODE)"
  port="$(node_var "$node" PORT)"
  PGPASSWORD="$(require_node_var "$node" ADMIN_PASSWORD)" \
  PGSSLMODE="${sslmode:-require}" \
    psql --no-psqlrc -v ON_ERROR_STOP=1 -X -q \
      -h "$(require_node_var "$node" HOST)" \
      -p "${port:-5432}" \
      -U "$(require_node_var "$node" ADMIN_USER)" \
      -d "$DB_NAME" "$@"
}

# Fails when the client is older than the given major version.
require_psql_major() {
  local major
  major="$(psql --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
  if (( major < $1 )); then
    echo "psql $1 or later is required (found $major)" >&2
    exit 1
  fi
}
