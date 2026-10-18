#!/usr/bin/env bash
# Sets up the database of one cloud that runs alone (a cluster of one node),
# from that cloud's VM, in one command:
#   database-create.sh -> migrate.sh -> api-role-setup.sh ->
#   switchover.sh <cloud> -> replication-status.sh
#
# It asks only for what it cannot find. When the cloud's CLI is signed in on
# the VM, it reads the database address (and, where the cloud reports it, the
# admin user) and the API password (the cloud's db-api-password secret) from
# the cloud; otherwise it asks. Passwords are never shown, written to a file
# or kept in the shell history. Nothing is written to replication/nodes.env.
#
# For a cluster of several clouds, fill in replication/nodes.env and run the
# scripts as in docs/getting-started.md.
#
# Usage: scripts/node-setup.sh aws|google|azure
#
# The names of the infrastructure default to the dev environment of the
# infrastructure repository; override them in the environment if needed:
#   AWS_REGION (ap-northeast-1), AWS_DB_CLUSTER (aurora-postgres-cluster),
#   AWS_API_SECRET (multicloud-aws-secret-db-api-password),
#   GOOGLE_SQL_INSTANCE (the only PostgreSQL instance of the project),
#   GOOGLE_API_SECRET (multicloud-google-secret-db-api-password),
#   AZURE_RESOURCE_GROUP (rg_multicloud), AZURE_DB_SERVER (the only
#   PostgreSQL flexible server of the group), AZURE_KEY_VAULT
#   (multicloud-kv-001), AZURE_API_SECRET (db-api-password)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cloud="${1:-}"
case "$cloud" in
  aws | google | azure) ;;
  *)
    echo "Usage: scripts/node-setup.sh aws|google|azure" >&2
    exit 1
    ;;
esac
NODE="${cloud^^}"

host=""
admin_user=""
api_password=""

# Each lookup prints nothing (and fails quietly) when the CLI is missing or
# not signed in; the value is then asked for.
has() { command -v "$1" > /dev/null 2>&1; }

lookup_aws() {
  has aws || return 0
  local region="${AWS_REGION:-ap-northeast-1}" cluster="${AWS_DB_CLUSTER:-aurora-postgres-cluster}"
  host="$(aws rds describe-db-clusters --region "$region" --db-cluster-identifier "$cluster" \
    --query 'DBClusters[0].Endpoint' --output text 2> /dev/null || true)"
  admin_user="$(aws rds describe-db-clusters --region "$region" --db-cluster-identifier "$cluster" \
    --query 'DBClusters[0].MasterUsername' --output text 2> /dev/null || true)"
  api_password="$(aws secretsmanager get-secret-value --region "$region" \
    --secret-id "${AWS_API_SECRET:-multicloud-aws-secret-db-api-password}" \
    --query SecretString --output text 2> /dev/null || true)"
}

lookup_google() {
  has gcloud || return 0
  local instance="${GOOGLE_SQL_INSTANCE:-}"
  if [[ -z "$instance" ]]; then
    instance="$(gcloud sql instances list --filter='databaseVersion~^POSTGRES' \
      --format='value(name)' 2> /dev/null || true)"
    # Only when there is exactly one
    [[ "$(grep -c . <<< "$instance")" == 1 ]] || instance=""
  fi
  if [[ -n "$instance" ]]; then
    host="$(gcloud sql instances describe "$instance" \
      --format='value(ipAddresses[0].ipAddress)' 2> /dev/null || true)"
  fi
  api_password="$(gcloud secrets versions access latest \
    --secret="${GOOGLE_API_SECRET:-multicloud-google-secret-db-api-password}" 2> /dev/null || true)"
}

lookup_azure() {
  has az || return 0
  local group="${AZURE_RESOURCE_GROUP:-rg_multicloud}" server="${AZURE_DB_SERVER:-}"
  if [[ -z "$server" ]]; then
    server="$(az postgres flexible-server list -g "$group" --query '[].name' -o tsv 2> /dev/null || true)"
    [[ "$(grep -c . <<< "$server")" == 1 ]] || server=""
  fi
  if [[ -n "$server" ]]; then
    host="$(az postgres flexible-server show -g "$group" -n "$server" \
      --query fullyQualifiedDomainName -o tsv 2> /dev/null || true)"
    admin_user="$(az postgres flexible-server show -g "$group" -n "$server" \
      --query administratorLogin -o tsv 2> /dev/null || true)"
  fi
  api_password="$(az keyvault secret show --vault-name "${AZURE_KEY_VAULT:-multicloud-kv-001}" \
    --name "${AZURE_API_SECRET:-db-api-password}" --query value -o tsv 2> /dev/null || true)"
}

echo "== Looking up the $cloud database and the API password (the $cloud CLI, if signed in)"
"lookup_$cloud"
[[ "$host" == "None" ]] && host=""
[[ "$admin_user" == "None" ]] && admin_user=""
if [[ "$api_password" == "CHANGE_ME" ]]; then
  echo "   The API password secret still has its dummy value: set it first (infrastructure docs/operations.md, \"Secrets\")" >&2
  exit 1
fi
api_source="password from the $cloud secret store"
[[ -n "$api_password" ]] || api_source="password typed in"

# Ask for what was not found (the found value is the default)
read -r -p "Database address [${host}]: " answer
host="${answer:-$host}"
read -r -p "Database admin user [${admin_user}]: " answer
admin_user="${answer:-$admin_user}"
read -r -s -p "Database admin password: " admin_password
echo
if [[ -z "$api_password" ]]; then
  read -r -s -p "API password (the same on every cloud): " api_password
  echo
fi
for name in host admin_user admin_password api_password; do
  if [[ -z "${!name}" ]]; then
    echo "$name is required" >&2
    exit 1
  fi
done

echo
echo "== Settings"
echo "   node:           $cloud (alone)"
echo "   database:       $host / appdb"
echo "   admin user:     $admin_user"
echo "   API user:       app_api ($api_source)"
read -r -p "Set up the database with these settings? [y/N] " answer
[[ "$answer" == [yY]* ]] || exit 1

# Node settings for this run only, without passwords (they stay in the
# environment of this process)
NODES_FILE="$(mktemp)"
trap 'rm -f "$NODES_FILE"' EXIT
cat > "$NODES_FILE" << EOF
NODES=$cloud
DB_NAME=appdb
NODE_${NODE}_HOST=$host
NODE_${NODE}_ADMIN_USER=$admin_user
NODE_${NODE}_API_USER=app_api
NODE_${NODE}_REPL_USER=app_repl
EOF
export NODES_FILE NODES="$cloud"
export "NODE_${NODE}_ADMIN_PASSWORD=$admin_password" "NODE_${NODE}_API_PASSWORD=$api_password"
unset admin_password api_password

for step in database-create.sh migrate.sh api-role-setup.sh "switchover.sh $cloud" replication-status.sh; do
  echo
  echo "== scripts/$step"
  # shellcheck disable=SC2086
  "$SCRIPT_DIR"/$step
done

echo
echo "Done: $cloud runs alone on its database (primary = $cloud). Next: deploy the API"
echo "(merge to the environment's branch) and check /readyz (docs/getting-started.md)."
