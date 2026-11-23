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
# Usage: scripts/cluster-setup.sh aws|google|azure
#          [--primary <node> | --status | --force <node> [--allow-behind]]
#   --primary   first primary (default: the cloud of this VM). Once the
#               cluster has a primary, it is kept unless --primary names
#               another node, which then becomes the primary (a planned
#               switchover, docs/operations.md).
#   --status    only show the cluster's state (scripts/replication-status.sh),
#               e.g. after a database failover; asks for the admin passwords
#               only and changes nothing
#   --force     forced switchover to <node> when the primary is down or cut
#               off (scripts/switchover.sh --force, docs/operations.md):
#               unreachable nodes are skipped (<node> must be reachable),
#               asks for the admin passwords of the reachable nodes only and
#               runs nothing else. --allow-behind is passed on to
#               switchover.sh (only when it says so, after checking)
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
  echo "Usage: scripts/cluster-setup.sh aws|google|azure [--primary <node> | --status | --force <node> [--allow-behind]]" >&2
  exit 1
}

cloud="${1:-}"
case "$cloud" in
  aws | google | azure) ;;
  *) usage ;;
esac
shift
primary=""
status_only=""
force_target=""
allow_behind=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --primary)
      primary="${2:-}"
      [[ -n "$primary" ]] || usage
      shift 2
      ;;
    --status)
      status_only=1
      shift
      ;;
    --force)
      force_target="${2:-}"
      [[ -n "$force_target" ]] || usage
      shift 2
      ;;
    --allow-behind)
      allow_behind=1
      shift
      ;;
    *) usage ;;
  esac
done
# One mode at a time; --allow-behind only with --force
modes=0
for mode in "$primary" "$status_only" "$force_target"; do
  [[ -z "$mode" ]] || modes=$((modes + 1))
done
(( modes <= 1 )) || usage
[[ -z "$allow_behind" || -n "$force_target" ]] || usage

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
if [[ -n "$force_target" && " $NODES " != *" $force_target "* ]]; then
  echo "--force $force_target is not in NODES ($NODES)" >&2
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
if [[ -n "$force_target" ]]; then
  # A forced switchover expects the old primary (or more) to be down
  if [[ " $unreachable " == *" $force_target "* ]]; then
    echo "The target $force_target is not reachable: choose a reachable node" >&2
    exit 1
  fi
elif [[ -n "$unreachable" ]]; then
  echo "Not reachable:$unreachable. Check the VPN, the private DNS (getent hosts <name>) and the firewall / security group / NSG rules for port 5432" >&2
  exit 1
fi
reachable_nodes=()
for node in "${node_list[@]}"; do
  [[ " $unreachable " == *" $node "* ]] || reachable_nodes+=("$node")
done

# 2. API and replication passwords from this cloud's secret store
need_store=""
for node in "${node_list[@]}"; do
  [[ -n "$(node_var "$node" API_PASSWORD)" && -n "$(node_var "$node" REPL_PASSWORD)" ]] || need_store=1
done
# --status and --force use the databases as their admins only
[[ -z "$status_only" && -z "$force_target" ]] || need_store=""
if [[ -n "$need_store" ]]; then
  echo "== Reading the passwords from the $cloud secret store"
  AWS_REGION="${AWS_REGION:-ap-northeast-1}"
  # The CLI's error, shown when a password cannot be read
  CLI_ERRORS="$(mktemp)"
  trap 'rm -f "$NODES_FILE" "$CLI_ERRORS"' EXIT
  read_secret() {
    case "$cloud" in
      aws)
        aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$1" \
          --query SecretString --output text 2>> "$CLI_ERRORS" || true
        ;;
      google) gcloud secrets versions access latest --secret="$1" 2>> "$CLI_ERRORS" || true ;;
      azure)
        az keyvault secret show --vault-name "${AZURE_KEY_VAULT:-multicloud-kv-001}" --name "$1" \
          --query value -o tsv 2>> "$CLI_ERRORS" || true
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
    if [[ "$value" == "CHANGE_ME" ]]; then
      echo "   The passwords still have their dummy value: set them on every cloud with scripts/secrets-set.sh" >&2
      exit 1
    fi
    if [[ -z "$value" ]]; then
      echo "   The passwords could not be read from the $cloud secret store. The $cloud CLI said:" >&2
      awk '!seen[$0]++ { print "     " $0 }' "$CLI_ERRORS" >&2
      echo "   Sign in to the $cloud CLI (e.g. the session expired) or check its access to the secrets;" >&2
      echo "   set them on every cloud with scripts/secrets-set.sh" >&2
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

# 3. Database admin passwords (Enter: the same as the previous node), of the
#    reachable nodes (all of them unless --force)
previous=""
for node in "${reachable_nodes[@]}"; do
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

# --status: show the state and stop
if [[ -n "$status_only" ]]; then
  echo
  echo "== scripts/replication-status.sh"
  "$SCRIPT_DIR/replication-status.sh"
  exit 0
fi

# --force: forced switchover only
if [[ -n "$force_target" ]]; then
  echo
  echo "== Forced switchover to $force_target"
  echo "   reachable:${reachable_nodes[*]/#/ }"
  echo "   not reachable:${unreachable:- (none)}"
  [[ -z "$unreachable" ]] || echo "   (their admin passwords are not asked: switchover.sh lists them as unreachable, \"...ADMIN_PASSWORD is required\")"
  echo "   Use it only when the primary is down or cut off (docs/operations.md, \"Forced switchover\");"
  echo "   otherwise run --primary $force_target (a planned switchover)."
  read -r -p "Switch over by force to $force_target? [y/N] " answer
  [[ "$answer" == [yY]* ]] || exit 1
  echo
  echo "== scripts/switchover.sh --force${allow_behind:+ --allow-behind} $force_target"
  "$SCRIPT_DIR/switchover.sh" --force ${allow_behind:+--allow-behind} "$force_target"
  echo
  echo "== scripts/replication-status.sh (reachable nodes)"
  NODES="${reachable_nodes[*]}" "$SCRIPT_DIR/replication-status.sh"
  echo
  echo "Done: $force_target is the primary. The old primary must not rejoin as it is:"
  echo "follow docs/operations.md, \"After a forced switchover\"."
  echo "Sign out of the CLI on a shared VM."
  exit 0
fi

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
