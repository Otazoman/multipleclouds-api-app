# Getting started

[日本語](getting-started.ja.md)

This guide covers the first deployment to the clouds. For the development
environment and local testing, see the [README](../README.md).

## 1. Prerequisites

The infrastructure repository (`cdktn_multicloud_backend`) must have
created, for every participating cloud:

- the network and the site-to-site VPN between the clouds, with private DNS
- a PostgreSQL 18 database with logical replication enabled
  (`rds.logical_replication`, `cloudsql.logical_decoding`, or
  `wal_level = logical` on Azure)
- the container service (ECS / Cloud Run / Container Apps) and its load balancer
- the CI/CD pipeline that builds this repository (`buildspec.yml`,
  `cloudbuild.yaml`, `azure-pipelines.yml`)
- secrets for the database passwords in the cloud's secret store
- network access on port 5432 from **each cloud's containers to every
  cloud's database** (writes go to the primary, which can be on any cloud),
  in addition to database-to-database access for replication

You also need a host to run the database scripts:

- reachable to every database over the private network (for example a VM
  in one of the clouds)
- bash and `psql` 15 or later
- a clone of this repository

## 2. Node settings

On that host, create the node settings for the scripts:

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
export NODE_AWS_ADMIN_PASSWORD=...   NODE_AWS_REPL_PASSWORD=...   NODE_AWS_API_PASSWORD=...
export NODE_GOOGLE_ADMIN_PASSWORD=... NODE_GOOGLE_REPL_PASSWORD=... NODE_GOOGLE_API_PASSWORD=...
export NODE_AZURE_ADMIN_PASSWORD=...  NODE_AZURE_REPL_PASSWORD=...  NODE_AZURE_API_PASSWORD=...
```

The API and replication passwords are chosen by you. Store them in each
cloud's secret store: the API containers read `DB_PASSWORD` from there.

## 3. Set up the databases

Run in this order. Every script is safe to run again.

```bash
scripts/migrate.sh             # create the tables on every node
scripts/api-role-setup.sh      # create app_api and grant access to schema "app"
scripts/replication-setup.sh   # publications and subscriptions between every pair
scripts/switchover.sh <node>   # first primary, e.g. the cloud closest to most users
scripts/replication-status.sh  # check
```

In the status output, every node should show the same primary and epoch,
every subscription should be enabled, every slot active, and the error
counts `0`. If a subscription cannot connect, check the
VPN, the firewall / security group / NSG rules for port 5432 and the
`REPL_HOST` setting.

## 4. Configure the API containers

Each cloud's container must have these environment variables (set by the
infrastructure repository; see [.env.sample](../.env.sample)):

| Variable | Value |
| --- | --- |
| `CLOUD_ID` | `aws`, `google` or `azure` — must match the node name in `NODES` |
| `DB_HOST`, `DB_PORT`, `DB_NAME` | That cloud's database |
| `DB_USER`, `DB_PASSWORD` | `app_api` and its password (from the secret store) |
| `DB_SSLMODE` | `require`, or `verify-full` with `DB_SSL_CA_FILE` |
| `GRAPHIQL_ENABLED` | `false` |
| `PEER_NODES` | The other nodes, e.g. `google,azure` on AWS |
| `DB_<NODE>_HOST`, `DB_<NODE>_PASSWORD` | For each node in `PEER_NODES`: its database address reachable from this cloud, and its `app_api` password |
| `WRITE_ACK_PEERS` | `1` (default) |

The other `DB_<NODE>_*` settings default to this cloud's values; set them
only where a node differs (e.g. `DB_<NODE>_SSLMODE`).

## 5. Deploy

Push to the branch that the pipelines watch. Each cloud builds the image and
rolls out a new revision:

- AWS: CodeBuild → ECR → ECS Blue/Green (the build fails if the service
  does not become stable)
- Google Cloud: Cloud Build → Artifact Registry → Cloud Run
- Azure: Azure Pipelines → ACR → Container Apps

## 6. Verify

For each cloud's endpoint:

```bash
curl https://<endpoint>/healthz   # {"status":"ok","cloud":"<cloud>"}
curl https://<endpoint>/readyz    # 200 when the database answers
```

Then create an item on one cloud and read it from another, as in the
README's local test, and check the API logs for `Primary: <node> (epoch N)`.
A write through an API in a cloud other than the primary's checks the
cross-cloud path: `PRIMARY_UNAVAILABLE` there usually means its container
cannot reach the primary's database (routes, firewall / security group /
NSG, private DNS). `readyz` returning `503` usually means the API cannot
reach or log in to its database: check `DB_*` and that
`scripts/api-role-setup.sh` has run on that node.

After the first deployment, schedule `scripts/journal-prune.sh` (e.g.
daily) on the scripts host: see [operations.md](operations.md#write-journal).

## Next steps

- Day-to-day procedures: [operations.md](operations.md)
- Design: [architecture.md](architecture.md)
