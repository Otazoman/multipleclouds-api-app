# Getting started

[日本語](getting-started.ja.md)

This guide covers the first deployment to the clouds. For the development
environment and local testing, see the [README](../README.md).

## Overview

| # | Step | Where | Details |
| --- | --- | --- | --- |
| 1 | Build the infrastructure with the API flags off (`azureSecretReady`, `readinessProbe`, `journalPrune.enabled`) | Infrastructure repository: `cdktn diff`, `cdktn deploy` | Infrastructure getting-started and operations ("Deploy", "Deploy again after a destroy") |
| 2 | Set the passwords on every cloud (the same values): `scripts/secrets-set.sh <cloud>` | Each cloud's Cloud Shell or VM; Azure only from its VM (the Key Vault is in the VNet) | Section 2 below |
| 3 | Azure: `azureSecretReady: true`, `cdktn deploy` | Infrastructure repository | Infrastructure operations, "Secrets" |
| 4 | Set up the databases | Clouds alone: each cloud's VM. A cluster: one VM of any cloud (the databases are private) | Sections 2–3 below |
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

## 2. Passwords and node settings

### Passwords

Choose two passwords once and keep them (e.g. in a password manager):

- **API (`app_api`): one password for every node.** Every API connects to
  every node (writes go to the primary, which can be any of them), so each
  cloud's containers hold every node's password anyway; one value keeps the
  secret stores simple. The containers read `DB_PASSWORD` and every
  `DB_<NODE>_PASSWORD` from their own cloud's secret `db-api-password`.
- **Replication (`app_repl`): one password for every node too** (a cluster
  only). Only the scripts use it; with one value, the scripts can run on any
  one VM and read every password from that cloud's own secret store.

```bash
openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32; echo   # run twice: API, replication
```

Set them in **every** cloud's secret store, one command per cloud, signed in
to that cloud's CLI (infrastructure operations, "Secrets"): AWS and Google
Cloud from Cloud Shell or their VM, Azure from its VM (the Key Vault is
reachable only from the Azure VNet):

```bash
git clone https://github.com/Otazoman/multipleclouds-api-app.git   # or git pull
cd multipleclouds-api-app
scripts/secrets-set.sh aws        # google / azure on the other clouds
```

| Prompt | Answer |
| --- | --- |
| `API password` | The API password (pasted, not echoed) |
| `Replication password` | The replication password; Enter leaves it unchanged (clouds alone do not use it) |

It checks the sign-in, sets `db-api-password` and `db-repl-password` of that
cloud, reads them back to check them and ends with `Done`. The values do not
appear on the screen, in the shell history or in the process list. Safe to
run again (e.g. to change a password; then also run the role setup again,
[operations.md](operations.md#passwords)). The secret names default to the
infrastructure's dev environment; override them in the environment
(`AWS_API_SECRET`, `AWS_REPL_SECRET`, `GOOGLE_API_SECRET`,
`GOOGLE_REPL_SECRET`, `AZURE_KEY_VAULT`, `AZURE_API_SECRET`,
`AZURE_REPL_SECRET`, `AWS_REGION`).

### Node settings (by hand)

**Clouds alone**: run `scripts/node-setup.sh <cloud>` on each cloud's VM
(section 3). **A cluster**: run `scripts/cluster-setup.sh` on one VM
(section 3). Neither needs a node settings file.

To run the scripts of section 3 by hand instead (e.g. other names or
another infrastructure), create the node settings and export the passwords
in the shell; do not write passwords in the file (it is ignored by git):

```bash
cp replication/nodes.env.sample replication/nodes.env
export NODE_<N>_ADMIN_PASSWORD=... NODE_<N>_API_PASSWORD=... NODE_<N>_REPL_PASSWORD=...   # for each node
```

| Setting | Value |
| --- | --- |
| `NODE_<N>_HOST` | Database address reachable from this host |
| `NODE_<N>_REPL_HOST` | Address the other databases use to reach this one (only if different from `HOST`) |
| `NODE_<N>_ADMIN_USER` | Database admin user created by the infrastructure |
| `NODE_<N>_REPL_USER`, `NODE_<N>_API_USER` | Keep `app_repl` / `app_api` unless you have a reason to change them |

## 3. Set up the databases

### A cluster: `scripts/cluster-setup.sh`

Run on **one** VM of any cloud of the cluster, signed in to that cloud's
CLI only, after the passwords are set on every cloud (section 2):

```bash
git clone https://github.com/Otazoman/multipleclouds-api-app.git   # or git pull
cd multipleclouds-api-app
git switch <branch to release>           # e.g. dev
scripts/cluster-setup.sh aws             # the cloud of this VM: aws / google / azure
```

| Prompt | Answer |
| --- | --- |
| `Database admin password of <node> (<user>)` | The node's admin password (`.env.<env>` of the infrastructure; not echoed). Enter repeats the previous node's |
| `Set up the cluster ... ? [y/N]` | Check the settings and answer `y` |

What it does:

| Step | Details |
| --- | --- |
| Connect | Every database by its private DNS name (`aurora-postgres.aws.inner`, `cloudsql-postgres.google.inner`, `postgres-prod.azure.inner`); admin users `root`, `root`, `azuredbadmin`. The databases reach each other by the same names (Cloud SQL through the infrastructure's peered DNS domains). Stops at once, naming the database, when one is not reachable |
| Passwords | API and replication passwords from this cloud's secret store; the admin passwords are asked. Nothing is written to a file |
| Scripts | `database-create.sh`, `migrate.sh`, `api-role-setup.sh`, `replication-setup.sh`, `switchover.sh <first primary>`, `replication-status.sh` |
| Primary | First setup: the cloud of this VM, or `--primary <node>`. Later runs keep the current primary unless `--primary` names another node (a planned switchover) |

Check the status it prints at the end: on every node the same primary and
epoch, every subscription enabled, every slot active, no errors. Safe to run
again (e.g. a release's migrations). The names default to the
infrastructure's dev environment; override them in the environment
(`NODES`, `NODE_<NODE>_HOST`, `NODE_<NODE>_ADMIN_USER`,
`NODE_<NODE>_REPL_HOST`, and the secret names as for `secrets-set.sh`).

**Admin users.** The defaults are those of the infrastructure's dev
environment (`AWSDB_ROOT_USER`, `GOOGLEDB_ROOT_USER`, `AZUREDB_ROOT_USER` in
its `.env.<env>`: `root`, `root`, `azuredbadmin`; Azure does not accept
`root`). When the databases were created with other names, give them when
running the script (the settings shown before the confirmation include
them):

```bash
NODE_AZURE_ADMIN_USER=<admin user> scripts/cluster-setup.sh aws
```

Give the name the database was created with: changing `.env.<env>` later
does not rename an existing admin. A wrong name stops `database-create.sh`
with `password authentication failed for user "..."`; nothing is changed,
so run again with the right name.

### By hand

With `replication/nodes.env` and the passwords exported (section 2), run in
this order. Every script is safe to run again.

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
