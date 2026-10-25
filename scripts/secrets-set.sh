#!/usr/bin/env bash
# Sets the database passwords in one cloud's secret store, in one command:
#   db-api-password   password of app_api (the same value on every cloud)
#   db-repl-password  password of app_repl (logical replication; a cluster
#                     only: press Enter to leave it unchanged)
#
# Run it once per cloud, signed in to that cloud's CLI: AWS and Google Cloud
# from Cloud Shell or their VM, Azure from its VM (the Key Vault is reachable
# from the VNet only). It asks for the values (paste them; they are not
# shown), writes them through a file readable only by you (not the shell
# history or the process list), deletes the file and reads the values back
# to check them.
#
# Usage: scripts/secrets-set.sh aws|google|azure
#
# The names default to the dev environment of the infrastructure repository;
# override them in the environment if needed:
#   AWS_REGION (ap-northeast-1), AWS_API_SECRET
#   (multicloud-aws-secret-db-api-password), AWS_REPL_SECRET
#   (multicloud-aws-secret-db-repl-password), GOOGLE_API_SECRET
#   (multicloud-google-secret-db-api-password), GOOGLE_REPL_SECRET
#   (multicloud-google-secret-db-repl-password), AZURE_KEY_VAULT
#   (multicloud-kv-001), AZURE_API_SECRET (db-api-password),
#   AZURE_REPL_SECRET (db-repl-password)

set -euo pipefail

cloud="${1:-}"
case "$cloud" in
  aws | google | azure) ;;
  *)
    echo "Usage: scripts/secrets-set.sh aws|google|azure" >&2
    exit 1
    ;;
esac

AWS_REGION="${AWS_REGION:-ap-northeast-1}"
case "$cloud" in
  aws)
    api_secret="${AWS_API_SECRET:-multicloud-aws-secret-db-api-password}"
    repl_secret="${AWS_REPL_SECRET:-multicloud-aws-secret-db-repl-password}"
    ;;
  google)
    api_secret="${GOOGLE_API_SECRET:-multicloud-google-secret-db-api-password}"
    repl_secret="${GOOGLE_REPL_SECRET:-multicloud-google-secret-db-repl-password}"
    ;;
  azure)
    vault="${AZURE_KEY_VAULT:-multicloud-kv-001}"
    api_secret="${AZURE_API_SECRET:-db-api-password}"
    repl_secret="${AZURE_REPL_SECRET:-db-repl-password}"
    ;;
esac

# Signed in to the cloud's CLI (with your account, not a VM's identity)
echo "== Checking the $cloud CLI sign-in"
case "$cloud" in
  aws)
    account="$(aws sts get-caller-identity --query Arn --output text 2> /dev/null || true)"
    hint="aws login --remote --region $AWS_REGION"
    ;;
  google)
    account="$(gcloud config get-value account 2> /dev/null || true)"
    # The VM's default service account cannot use Secret Manager
    [[ "$account" == *-compute@developer.gserviceaccount.com ]] && account=""
    hint="gcloud auth login --no-launch-browser"
    ;;
  azure)
    account="$(az account show --query user.name -o tsv 2> /dev/null || true)"
    hint="az login --use-device-code"
    ;;
esac
if [[ -z "$account" ]]; then
  echo "   Not signed in: run \"$hint\" first" >&2
  exit 1
fi
echo "   $account"

read -r -s -p "API password (db-api-password, the same on every cloud): " api_password
echo
if [[ -z "$api_password" ]]; then
  echo "The API password is required" >&2
  exit 1
fi
read -r -s -p "Replication password (db-repl-password; Enter: leave unchanged): " repl_password
echo

# The value goes through a file readable only by you
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

put() {
  local name="$1" file="$TMP_DIR/value"
  (umask 077 && printf %s "$2" > "$file")
  case "$cloud" in
    aws)
      aws secretsmanager put-secret-value --region "$AWS_REGION" --secret-id "$name" \
        --secret-string "file://$file" --output text --query VersionId > /dev/null
      ;;
    google)
      gcloud secrets versions add "$name" --data-file="$file" --quiet > /dev/null
      ;;
    azure)
      az keyvault secret set --vault-name "$vault" --name "$name" \
        --file "$file" --encoding utf-8 --output none
      ;;
  esac
  rm -f "$file"
}

get() {
  case "$cloud" in
    aws)
      aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$1" \
        --query SecretString --output text
      ;;
    google) gcloud secrets versions access latest --secret="$1" ;;
    azure) az keyvault secret show --vault-name "$vault" --name "$1" --query value -o tsv ;;
  esac
}

set_secret() {
  local name="$1" value="$2"
  echo "== $name"
  put "$name" "$value"
  if [[ "$(get "$name")" == "$value" ]]; then
    echo "   set (read back: matches)"
  else
    echo "   the value read back does not match" >&2
    exit 1
  fi
}

set_secret "$api_secret" "$api_password"
if [[ -n "$repl_password" ]]; then
  set_secret "$repl_secret" "$repl_password"
else
  echo "== $repl_secret: unchanged"
fi
unset api_password repl_password

echo
echo "Done: the $cloud secrets are set. Sign out of the CLI on a shared VM."
