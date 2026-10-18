# Getting started

[日本語](getting-started.ja.md)

This guide covers the first deployment to the clouds. For the development
environment and local testing, see the [README](../README.md).

## Overview

| # | Step | Where | Details |
| --- | --- | --- | --- |
| 1 | Build the infrastructure with the API flags off (`azureSecretReady`, `readinessProbe`, `journalPrune.enabled`) | Infrastructure repository: `cdktn diff`, `cdktn deploy` | Infrastructure getting-started and operations ("Deploy", "Deploy again after a destroy") |
| 2 | Set the API password secret on every cloud (the same value) | Each cloud's Cloud Shell or VM; Azure only from its VM (the Key Vault is in the VNet) | Infrastructure operations, "Secrets" |
| 3 | Azure: `azureSecretReady: true`, `cdktn deploy` | Infrastructure repository | Infrastructure operations, "Secrets" |
| 4 | Set up the databases | Each cloud's VM (the databases are private) | Sections 2–3 below |
| 5 | Deploy the API: merge into the environment's branch; right after the infrastructure is built (nothing new to merge), run each cloud's pipeline once | GitHub (pull request) or each cloud's console / CLI; each cloud's CI/CD builds and deploys | Section 5, [operations.md](operations.md#releases) |
| 6 | Verify | Your machine | Section 6 |
| 7 | `readinessProbe` and `journalPrune.enabled` `true`, `cdktn deploy` | Infrastructure repository | Infrastructure operations, "Build an environment" (step 6) |

Steps 1–3 build the infrastructure; from step 4 on it is this repository's work.
`cdktn deploy` runs three times: steps 1, 3 and 7 (the infrastructure
operations, "Build an environment", explains why). Later releases need only
the merge.

## 1. Prerequisites

The APIs run in one of two ways (set in the infrastructure repository,
`apiContainerConfig.topology`):

- **Cluster** (two or three clouds): the clouds share one set of data. Every
  API reads from its own cloud's database and writes to the primary, and the
  databases replicate. Needs the VPN and the private DNS between the clouds.
- **Clouds alone** (`independent`, or a database on one cloud only): each
  cloud's API uses only its own database and has its own data. No VPN or
  private DNS. Useful to try a cloud on its own; turning such clouds into a
  cluster later keeps the data of one of them only (the others are reset
  and copied from it: [operations.md](operations.md#adding-a-removed-node-back)).

The infrastructure repository (`cdktn_multicloud_backend`) must have
created, for every participating cloud:

- the network and, for a cluster, the site-to-site VPN between the clouds,
  with private DNS
- a PostgreSQL 18 database with logical replication enabled
  (`rds.logical_replication`, `cloudsql.logical_decoding`, or
  `wal_level = logical` on Azure)
- the container service (ECS / Cloud Run / Container Apps) and its load balancer
- the CI/CD pipeline that builds this repository (`buildspec.yml`,
  `cloudbuild.yaml`, `azure-pipelines.yml`)
- secrets for the database passwords in the cloud's secret store
- for a cluster, network access on port 5432 from **each cloud's
  containers to every cloud's database** (writes go to the primary, which
  can be on any cloud), in addition to database-to-database access for
  replication

You also need a host to run the database scripts:

- reachable to every database over the private network (for example a VM
  in one of the clouds)
- bash and `psql` 15 or later
- a clone of this repository

## 2. Node settings

**Clouds alone** (each cloud on its own database): skip this section and
run `scripts/node-setup.sh <cloud>` on each cloud's VM (section 3).

For a cluster, create the node settings for the scripts on the host:

```bash
cp replication/nodes.env.sample replication/nodes.env
```

Fill in, for each node (`aws`, `google`, `azure`):

| Setting | Value |
| --- | --- |
| `NODE_<N>_HOST` | Database address reachable from this host |
| `NODE_<N>_REPL_HOST` | Address the other databases use to reach this one (only if different from `HOST`) |
| `NODE_<N>_ADMIN_USER` | Database admin user created by the infrastructure |
| `NODE_<N>_REPL_USER`, `NODE_<N>_API_USER` | Keep `app_repl` / `app_api` unless you have a reason to change them |

`replication/nodes.env` is ignored by git. Do not write passwords in it on a
shared machine; export them in the shell instead, reading them from the
secret store just before running the scripts:

```bash
export NODE_AWS_ADMIN_PASSWORD=...   NODE_AWS_REPL_PASSWORD=...
export NODE_GOOGLE_ADMIN_PASSWORD=... NODE_GOOGLE_REPL_PASSWORD=...
export NODE_AZURE_ADMIN_PASSWORD=...  NODE_AZURE_REPL_PASSWORD=...
# One API password for every node
export NODE_AWS_API_PASSWORD=... NODE_GOOGLE_API_PASSWORD=$NODE_AWS_API_PASSWORD NODE_AZURE_API_PASSWORD=$NODE_AWS_API_PASSWORD
```

For a cluster, run the scripts on the Azure VM (the only place that can
read the Key Vault), signed in to every cloud's CLI (infrastructure
operations, "Secrets"), and read the values from the secret stores:

```bash
export NODE_AWS_API_PASSWORD="$(aws secretsmanager get-secret-value --region ap-northeast-1 \
  --secret-id multicloud-aws-secret-db-api-password --query SecretString --output text)"
export NODE_GOOGLE_API_PASSWORD="$NODE_AWS_API_PASSWORD" NODE_AZURE_API_PASSWORD="$NODE_AWS_API_PASSWORD"
export NODE_AWS_REPL_PASSWORD="$(aws secretsmanager get-secret-value --region ap-northeast-1 \
  --secret-id multicloud-aws-secret-db-repl-password --query SecretString --output text)"
export NODE_GOOGLE_REPL_PASSWORD="$(gcloud secrets versions access latest \
  --secret=multicloud-google-secret-db-repl-password)"
export NODE_AZURE_REPL_PASSWORD="$(az keyvault secret show --vault-name multicloud-kv-001 \
  --name db-repl-password --query value --output tsv)"
# Database admin passwords (.env.<env> of the infrastructure): typed, not echoed
for n in AWS GOOGLE AZURE; do
  read -rsp "NODE_${n}_ADMIN_PASSWORD: " v && echo && export "NODE_${n}_ADMIN_PASSWORD=$v"
done
```

Leave out the clouds that are not in the cluster, and sign out of the
clouds when done.

The API and replication passwords are chosen by you:

- **API (`app_api`): one password for every node.** Every API connects to
  every node (writes go to the primary, which can be any of them), so each
  cloud's containers hold every node's password anyway; one value keeps the
  secret stores simple. Store it in **every** cloud's secret
  `db-api-password`: the containers read `DB_PASSWORD` and every
  `DB_<NODE>_PASSWORD` from their own cloud's copy.
- **Replication (`app_repl`): one per node**, in that cloud's secret
  `db-repl-password`. Only the scripts use them.

The secrets are created empty (dummy value) by the infrastructure
repository; set their values from the VMs with each cloud's CLI as its
documentation describes (Azure Key Vault is reachable only from the Azure
VNet).

## 3. Set up the databases

Run in this order. Every script is safe to run again.

```bash
scripts/database-create.sh     # create the database (DB_NAME) on every node
scripts/migrate.sh             # create the tables on every node
scripts/api-role-setup.sh      # create app_api and grant access to schema "app"
scripts/replication-setup.sh   # publications and subscriptions between every pair
scripts/switchover.sh <node>   # first primary, e.g. the cloud closest to most users
scripts/replication-status.sh  # check
```

`database-create.sh` prints the collation of the database on every node
and fails when they differ: reads come from each cloud's own database, so
the same rows must sort the same everywhere. It creates the database with
PostgreSQL's builtin `C.UTF-8` locale (`DB_CREATE_OPTIONS` in
`replication/nodes.env` changes it). The infrastructure does not create
this database.

### A cloud alone: `scripts/node-setup.sh`

A cloud alone is a cluster of one node. On that cloud's VM, one command
runs the scripts above for that node (`replication-setup.sh` is not
needed) without `replication/nodes.env`:

```bash
git clone https://github.com/Otazoman/multipleclouds-api-app.git   # or git pull
cd multipleclouds-api-app
git switch <branch to be released>      # e.g. dev
scripts/node-setup.sh aws               # google / azure on those clouds' VMs
```

It asks for what it cannot find:

| Question | Answer |
| --- | --- |
| `Database address [...]` | Enter to keep the value found, otherwise the database address |
| `Database admin user [...]` | Same; otherwise the admin user of the infrastructure (`.env.<env>`) |
| `Database admin password` | The admin password (not shown) |
| `API password` | Asked only when it could not be read: the value of the `db-api-password` secret (not shown) |
| `Set up ... ? [y/N]` | `y` after checking the settings |

Sign in to the cloud's CLI on the VM first (infrastructure operations,
"Secrets") to have the address, the admin user (AWS, Azure) and the API
password read from the cloud. It prints `Done: <cloud> runs alone ...` at
the end and is safe to run again (e.g. for the migrations of a new release).

What it does:

| Step | Detail |
| --- | --- |
| Look up | AWS: the Aurora cluster endpoint and master user, the `multicloud-aws-secret-db-api-password` secret. Google Cloud: the private IP of the only PostgreSQL Cloud SQL instance, the `multicloud-google-secret-db-api-password` secret. Azure: the FQDN and admin login of the only PostgreSQL flexible server of `rg_multicloud`, the `db-api-password` secret of `multicloud-kv-001`. A value that cannot be read is asked for; a secret still at its dummy value stops it |
| Settings | A temporary node settings file without passwords (`NODES=<cloud>`, `appdb`, `app_api`, SSL `require`), deleted at the end; the passwords stay in the environment of the process |
| Scripts | `database-create.sh`, `migrate.sh`, `api-role-setup.sh`, `switchover.sh <cloud>`, `replication-status.sh` for that node |

The names default to the infrastructure's dev environment. Override them in
the environment when they differ: `AWS_REGION`, `AWS_DB_CLUSTER`,
`AWS_API_SECRET`, `GOOGLE_SQL_INSTANCE`, `GOOGLE_API_SECRET`,
`AZURE_RESOURCE_GROUP`, `AZURE_DB_SERVER`, `AZURE_KEY_VAULT`,
`AZURE_API_SECRET` (e.g. `AZURE_KEY_VAULT=multicloud-kv-001-stg
scripts/node-setup.sh azure`).

### Status

In the status output, every node should show the same primary and epoch,
every subscription should be enabled, every slot active, and the error
counts `0`. If a subscription cannot connect, check the
VPN, the firewall / security group / NSG rules for port 5432 and the
`REPL_HOST` setting.

## 4. Configure the API containers

Each cloud's container must have these environment variables. The
infrastructure repository sets them on the service its CI/CD deploys to
(`config/apicontainer.ts` there), for the clouds whose database is enabled;
see also [.env.sample](../.env.sample):

| Variable | Value |
| --- | --- |
| `CLOUD_ID` | `aws`, `google` or `azure` — must match the node name in `NODES` |
| `DB_HOST`, `DB_PORT`, `DB_NAME` | That cloud's database |
| `DB_USER`, `DB_PASSWORD` | `app_api` and its password (from the secret store) |
| `DB_SSLMODE` | `require`, or `verify-full` with `DB_SSL_CA_FILE` |
| `GRAPHIQL_ENABLED` | `false` |
| `PEER_NODES` | The other nodes, e.g. `google,azure` on AWS |
| `DB_<NODE>_HOST`, `DB_<NODE>_PASSWORD` | For each node in `PEER_NODES`: its database address reachable from this cloud (private DNS name), and the `app_api` password (the same secret as `DB_PASSWORD`) |
| `WRITE_ACK_PEERS` | `1` (default) |

The other `DB_<NODE>_*` settings default to this cloud's values; set them
only where a node differs (e.g. `DB_<NODE>_SSLMODE`).

Two settings of the infrastructure repository depend on the order of the
first deployment:

- `azureSecretReady`: an Azure Container App cannot start while the Key
  Vault secret it references does not exist. Deploy the infrastructure
  with `false`, set the secret from the Azure VM, then deploy with `true`.
- `readinessProbe`: the placeholder images answer only `/`. After the API
  has been deployed (step 5), set it to `true` and deploy the
  infrastructure: the load balancers and platforms then use `/readyz`
  (readiness, including the migrations) and `/healthz` (liveness).

## 5. Deploy

Each environment deploys its own branch: `dev`, `staging` or `prod`
([operations.md](operations.md#releases)). Merge into the environment's
branch; each cloud builds the image (the build runs the tests) and rolls out
a new revision:

- AWS: CodeBuild → ECR → ECS Blue/Green (the build fails if the service
  does not become stable)
- Google Cloud: Cloud Build → Artifact Registry → Cloud Run
- Azure: Azure Pipelines → ACR → Container Apps

Right after the infrastructure is built (also after a destroy), the
registries are empty and the containers run placeholder images, but the
branch has no new commit to merge. Run each cloud's pipeline once on the
environment's branch instead (the names are the infrastructure's dev
defaults, set in its CI/CD configuration):

```bash
# AWS (CloudShell)
aws codebuild start-build --project-name api-service-cicd --source-version dev --region ap-northeast-1
# Google Cloud (Cloud Shell)
gcloud builds triggers run github-push-trigger --region=asia-northeast1 --branch=dev
```

Azure: in Azure DevOps, open the pipeline `multicloud-api-deploy`, **Run
pipeline**, branch `dev`. Use the same commands to run one cloud's build
again (e.g. after it failed).

## 6. Verify

For each cloud's endpoint:

```bash
curl https://<endpoint>/healthz   # {"status":"ok","cloud":"<cloud>","version":"<commit>"}
curl https://<endpoint>/readyz    # 200 when the database answers and is migrated
```

Then create an item on one cloud and read it from another, as in the
README's local test, and check the API logs for `Primary: <node> (epoch N)`.
A write through an API in a cloud other than the primary's checks the
cross-cloud path: `PRIMARY_UNAVAILABLE` there usually means its container
cannot reach the primary's database (routes, firewall / security group /
NSG, private DNS). `readyz` returning `503` usually means the API cannot
reach or log in to its database, or that a migration is missing there (the
API log names it): check `DB_*` and that `scripts/migrate.sh` and
`scripts/api-role-setup.sh` have run on that node.

After the first deployment, schedule `scripts/journal-prune.sh` (e.g.
daily) on the scripts host: see [operations.md](operations.md#write-journal).

## Next steps

- Day-to-day procedures: [operations.md](operations.md)
- Design: [architecture.md](architecture.md)
