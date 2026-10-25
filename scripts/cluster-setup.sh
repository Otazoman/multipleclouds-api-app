#!/usr/bin/env bash
# Sets up the databases of a cluster (two or three clouds) from one VM of any
# of them, in one command:
#   database-create.sh -> migrate.sh -> api-role-setup.sh ->
#   replication-setup.sh -> switchover.sh <first primary> -> replication-status.sh
#
# Run it on a VM of the cloud given as the argument, signed in to that cloud's
# CLI only. Through the VPN and the private DNS it reaches every database by
# its private DNS name, and the databases reach each other by the same names
# (Cloud SQL through the infrastructure's peered DNS domains). It reads the
# API and replication passwords (the same on every node) from that cloud's
# secret store (set them first with scripts/secrets-set.sh on every cloud) and
# asks only for the database admin passwords. Passwords are never shown,
# written to a file or kept in the shell history. Nothing is written to
# replication/nodes.env. Safe to run again (e.g. for a release's migrations).
#
# Usage: scripts/cluster-setup.sh aws|google|azure [--primary <node>]
#   --primary   first primary (default: the cloud of this VM). Once the
#               cluster has a primary, it is kept unless --primary names
#               another node, which then becomes the primary (a planned
#               switchover, docs/operations.md).
#
# The settings default to the dev environment of the infrastructure
# repository; override them in the environment if needed:
#   NODES ("aws google azure"), NODE_<NODE>_HOST (aurora-postgres.aws.inner,
#   cloudsql-postgres.google.inner, postgres-prod.azure.inner),
#   NODE_<NODE>_ADMIN_USER (root, root, azuredbadmin; the infrastructure's
#   .env.<env>: the names the databases were created with; changing
#   .env.<env> later does not rename an existing admin), NODE_<NODE>_REPL_HOST, _PORT, _SSLMODE, _PLATFORM, and the
#   secret names as in scripts/secrets-set.sh (AWS_REGION, AWS_API_SECRET,
#   AWS_REPL_SECRET, GOOGLE_API_SECRET, GOOGLE_REPL_SECRET, AZURE_KEY_VAULT,
#   AZURE_API_SECRET, AZURE_REPL_SECRET). Passwords already exported as
#   NODE_<NODE>_*_PASSWORD are used as they are.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "Usage: scripts/cluster-setup.sh aws|google|azure [--primary <node>]" >&2
  exit 1
}

cloud="${1:-}"
case "$cloud" in
  aws | google | azure) ;;
  *) usage ;;
esac
shift
primary=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --primary)
      primary="${2:-}"
      [[ -n "$primary" ]] || usage
      shift 2
      ;;
    *) usage ;;
  esac
done

NODES="${NODES:-aws google azure}"
read -r -a node_list <<< "$NODES"
if [[ " $NODES " != *" $cloud "* ]]; then
  echo "This VM's cloud ($cloud) is not in NODES ($NODES)" >&2
  exit 1
fi
if [[ -n "$primary" && " $NODES " != *" $primary "* ]]; then
  echo "--primary $primary is not in NODES ($NODES)" >&2
  exit 1
fi

# Node settings for this run only, without passwords. Values exported in the
# environment win (the file is sourced by the scripts).
NODES_FILE="$(mktemp)"
trap 'rm -f "$NODES_FILE"' EXIT
default_host() {
  case "$1" in
    aws) echo aurora-postgres.aws.inner ;;
    google) echo cloudsql-postgres.google.inner ;;
    azure) echo postgres-prod.azure.inner ;;
  esac
}
default_admin() {
  case "$1" in
    azure) echo azuredbadmin ;;
    *) echo root ;;
  esac
}
{
  echo "NODES=\"\${NODES:-$NODES}\""
  echo "DB_NAME=\"\${DB_NAME:-appdb}\""
  for node in "${node_list[@]}"; do
    N="${node^^}"
    echo "NODE_${N}_HOST=\"\${NODE_${N}_HOST:-$(default_host "$node")}\""
    echo "NODE_${N}_ADMIN_USER=\"\${NODE_${N}_ADMIN_USER:-$(default_admin "$node")}\""
    echo "NODE_${N}_REPL_USER=\"\${NODE_${N}_REPL_USER:-app_repl}\""
    echo "NODE_${N}_API_USER=\"\${NODE_${N}_API_USER:-app_api}\""
  done
} > "$NODES_FILE"
export NODES NODES_FILE
# shellcheck disable=SC1090
source "$NODES_FILE"

node_var() {
  local name="NODE_${1^^}_$2"
  printf '%s' "${!name:-}"
}

# 1. Every database reachable from this VM
echo "== Checking the databases (from this VM)"
unreachable=""
for node in "${node_list[@]}"; do
  host="$(node_var "$node" HOST)"
  port="$(node_var "$node" PORT)"
  if pg_isready -q -h "$host" -p "${port:-5432}" -t 5; then
    echo "   $node: $host ok"
  else
    echo "   $node: $host not reachable" >&2
    unreachable+=" $node"
  fi
done
if [[ -n "$unreachable" ]]; then
  echo "Not reachable:$unreachable. Check the VPN, the private DNS (getent hosts <name>) and the firewall / security group / NSG rules for port 5432" >&2
  exit 1
fi

# 2. API and replication passwords from this cloud's secret store
need_store=""
for node in "${node_list[@]}"; do
  [[ -n "$(node_var "$node" API_PASSWORD)" && -n "$(node_var "$node" REPL_PASSWORD)" ]] || need_store=1
done
if [[ -n "$need_store" ]]; then
  echo "== Reading the passwords from the $cloud secret store"
  AWS_REGION="${AWS_REGION:-ap-northeast-1}"
  read_secret() {
    case "$cloud" in
      aws)
        aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$1" \
          --query SecretString --output text 2> /dev/null || true
        ;;
      google) gcloud secrets versions access latest --secret="$1" 2> /dev/null || true ;;
      azure)
        az keyvault secret show --vault-name "${AZURE_KEY_VAULT:-multicloud-kv-001}" --name "$1" \
          --query value -o tsv 2> /dev/null || true
        ;;
    esac
  }
  case "$cloud" in
    aws)
      api="$(read_secret "${AWS_API_SECRET:-multicloud-aws-secret-db-api-password}")"
      repl="$(read_secret "${AWS_REPL_SECRET:-multicloud-aws-secret-db-repl-password}")"
      ;;
    google)
      api="$(read_secret "${GOOGLE_API_SECRET:-multicloud-google-secret-db-api-password}")"
      repl="$(read_secret "${GOOGLE_REPL_SECRET:-multicloud-google-secret-db-repl-password}")"
      ;;
    azure)
      api="$(read_secret "${AZURE_API_SECRET:-db-api-password}")"
      repl="$(read_secret "${AZURE_REPL_SECRET:-db-repl-password}")"
      ;;
  esac
  for value in "$api" "$repl"; do
    if [[ -z "$value" || "$value" == "CHANGE_ME" ]]; then
      echo "   The passwords could not be read: sign in to the $cloud CLI, and set them on every cloud with scripts/secrets-set.sh" >&2
      exit 1
    fi
  done
  for node in "${node_list[@]}"; do
    N="${node^^}"
    [[ -n "$(node_var "$node" API_PASSWORD)" ]] || export "NODE_${N}_API_PASSWORD=$api"
    [[ -n "$(node_var "$node" REPL_PASSWORD)" ]] || export "NODE_${N}_REPL_PASSWORD=$repl"
  done
  unset api repl
  echo "   ok"
fi

# 3. Database admin passwords (Enter: the same as the previous node)
previous=""
for node in "${node_list[@]}"; do
  N="${node^^}"
  [[ -z "$(node_var "$node" ADMIN_PASSWORD)" ]] || continue
  prompt="Database admin password of $node ($(node_var "$node" ADMIN_USER))"
  [[ -n "$previous" ]] && prompt+=" [Enter: same as the previous]"
  read -r -s -p "$prompt: " value
  echo
  value="${value:-$previous}"
  if [[ -z "$value" ]]; then
    echo "The admin password of $node is required" >&2
    exit 1
  fi
  export "NODE_${N}_ADMIN_PASSWORD=$value"
  previous="$value"
done
unset value previous

# 4. Confirm
echo
echo "== Settings"
for node in "${node_list[@]}"; do
  repl_host="$(node_var "$node" REPL_HOST)"
  echo "   $node: $(node_var "$node" HOST) (admin $(node_var "$node" ADMIN_USER))${repl_host:+, others connect to $repl_host}"
done
echo "   database: $DB_NAME, API user app_api, replication user app_repl"
echo "   first primary: ${primary:-$cloud} (kept if the cluster already has one, unless --primary)"
read -r -p "Set up the cluster with these settings? [y/N] " answer
[[ "$answer" == [yY]* ]] || exit 1

run() {
  echo
  echo "== scripts/$*"
  "$SCRIPT_DIR/$@"
}

run database-create.sh
run migrate.sh
run api-role-setup.sh
run replication-setup.sh

# The current primary, as recorded on this VM's node (empty: first setup)
# shellcheck source=lib.sh
current="$(source "$SCRIPT_DIR/lib.sh" && psql_admin "$cloud" -At \
  -c "SELECT primary_node FROM ops.cluster_state" 2> /dev/null || true)"
if [[ -z "$current" ]]; then
  run switchover.sh "${primary:-$cloud}"
elif [[ -n "$primary" && "$primary" != "$current" ]]; then
  run switchover.sh "$primary"
else
  echo
  echo "== Primary: $current (unchanged)"
fi

run replication-status.sh

echo
echo "Done: the cluster ($NODES) runs with primary = ${primary:-${current:-$cloud}}."
echo "Check every node above: the same primary and epoch, subscriptions enabled, slots active, no errors."
echo "Sign out of the CLI on a shared VM."
