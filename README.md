# Multi-Cloud API App

[日本語](README.ja.md)

GraphQL CRUD API deployed **active/active** to AWS, Google Cloud and Azure.
Each cloud runs the same container with its own PostgreSQL database, and the
databases replicate to each other with bidirectional logical replication.

- Node.js 24, TypeScript, [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server), [node-postgres](https://node-postgres.com/)
- Every API reads from its own cloud's database and writes to the **primary**
  database (one node at a time, moved by `scripts/switchover.sh`)
- A write succeeds only after another cloud has flushed it, so a switchover
  never loses a confirmed write
- Optimistic locking with `version` (`VERSION_CONFLICT` on mismatch)
- Tables and the GraphQL API are defined in YAML (`models/*.yaml`):
  fields, filters, sorting, relations, bulk writes and named SQL queries;
  `npm run generate` writes the SQL migrations

## Documentation

- [Model definitions](docs/models.md) — the YAML format, generated API, migrations
- [Getting started](docs/getting-started.md) — first deployment to the clouds
- [Operations](docs/operations.md) — migrations, releases (branches per environment), replication monitoring, outages, adding / removing nodes, passwords
- [Architecture](docs/architecture.md) — components, data model, write routing, replication

## Repository layout

| Path                                                    | Description                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `models/`                                               | Model definitions: one YAML file per table ([docs/models.md](docs/models.md)) |
| `src/`                                                  | API source: `models/` (definitions, DDL), `data/` (generic repository and service), `schema.ts` (GraphQL), `cluster.ts` (write routing), `generate.ts` |
| `generated/`                                            | `schema.graphql`, written by `npm run generate` (do not edit)      |
| `__tests__/`                                            | Unit tests (Jest; no database needed)                              |
| `migrations/`                                           | SQL migrations (hand-written or generated) and `models.snapshot.json`, applied to every node by `scripts/migrate.sh` |
| `scripts/`                                              | Database scripts: migrations, API role, replication setup / status |
| `replication/`                                          | Node settings for the scripts (`nodes.local.env` is for compose)   |
| `compose.yaml`                                          | Local environment: three PostgreSQL nodes + one API per node       |
| `Dockerfile`                                            | API container image                                                |
| `buildspec.yml`, `cloudbuild.yaml`, `azure-pipelines.yml` | CI/CD for AWS, Google Cloud and Azure                            |
| `.env.sample`                                           | Environment variables read by the API                              |
| `mise.toml`                                             | Tool versions for development (Node.js)                            |
| `docs/`                                                 | Documentation (see "Documentation" above)                          |

## Development environment

Requirements:

- [mise](https://mise.jdx.dev/) (provides Node.js)
- Docker and Docker Compose v2

`psql` is not needed on the host; the database scripts run inside the
compose `tools` container.

### 1. Node.js with mise

`mise.toml` in this repository pins Node.js 24, the version the container
image uses (`Dockerfile`).

```bash
cd multicloud_api_apps
mise trust            # first time only, if mise asks to trust the config
mise install node     # installs the Node.js version in mise.toml
node --version        # v24.x
```

### 2. Dependencies

```bash
npm ci
```

### 3. Static checks and unit tests

```bash
npm run typecheck     # tsc --noEmit
npm test              # jest (__tests__/**/*.test.ts)
npm run build         # compiles src/ to dist/
npm run generate      # migrations and generated/schema.graphql from models/*.yaml
```

The unit tests do not need a database. They also fail when `models/*.yaml`
changed without `npm run generate`.

## Local testing (three nodes)

`compose.yaml` starts three PostgreSQL 18 nodes that stand in for the clouds,
and one API per node:

| Service      | Role                    | URL on the host                 |
| ------------ | ----------------------- | ------------------------------- |
| `api-aws`    | API with `CLOUD_ID=aws`    | http://localhost:8081/graphql |
| `api-google` | API with `CLOUD_ID=google` | http://localhost:8082/graphql |
| `api-azure`  | API with `CLOUD_ID=azure`  | http://localhost:8083/graphql |
| `pg-aws`, `pg-google`, `pg-azure` | PostgreSQL nodes (not published to the host) | — |

GraphiQL is enabled locally, so each URL above also opens the GraphQL IDE in
a browser. The passwords in `compose.yaml` are for these throwaway containers
only; override them with `LOCAL_ADMIN_PASSWORD`, `LOCAL_API_PASSWORD` and
`LOCAL_REPL_PASSWORD` if needed.

### 1. Start the containers

```bash
docker compose up -d --build
```

### 2. Set up the databases

Run in this order (each script is safe to run again):

```bash
docker compose run --rm tools scripts/database-create.sh     # database appdb on every node
docker compose run --rm tools scripts/migrate.sh             # tables and functions on every node
docker compose run --rm tools scripts/api-role-setup.sh      # role the API connects as
docker compose run --rm tools scripts/replication-setup.sh   # bidirectional replication
docker compose run --rm tools scripts/switchover.sh aws      # first primary
docker compose run --rm tools scripts/replication-status.sh  # check
```

In the status output, every node should show `primary_node = aws`, every
subscription `enabled = t`, every slot `active = t`, and the error counts `0`.

Until `migrate.sh` and `api-role-setup.sh` have run, `/readyz` returns `503`;
this is expected.
Until `switchover.sh` has run, writes fail with `PRIMARY_UNAVAILABLE`. The
APIs pick up the primary within 5 seconds (`PRIMARY_REFRESH_INTERVAL_MS`).

### 3. Check the APIs

Health checks:

```bash
curl localhost:8081/healthz    # liveness:  {"status":"ok","cloud":"aws","version":"unknown"}
curl localhost:8081/readyz     # readiness: database reachable and migrated
```

Create an item on `aws`:

```bash
curl -s localhost:8081/graphql -H 'content-type: application/json' \
  -d '{"query":"mutation { createItem(input: {name: \"hello\"}) { id ownerCloud version } }"}'
```

Read it from `azure` (replace `<id>`) to confirm replication:

```bash
curl -s localhost:8083/graphql -H 'content-type: application/json' \
  -d '{"query":"{ cloud item(id: \"<id>\") { name ownerCloud version } }"}'
```

Update it from any cloud (here `google`) with the version you read:

```bash
curl -s localhost:8082/graphql -H 'content-type: application/json' \
  -d '{"query":"mutation { updateItem(id: \"<id>\", version: 1, input: {name: \"updated\"}) { name version } }"}'
```

Expected behaviour to check:

- Writes sent to any API succeed; they run on the primary (`aws`).
- An update or delete with an old `version` fails with `VERSION_CONFLICT`.

### 4. Try a switchover

Planned (the primary is up):

```bash
docker compose run --rm tools scripts/switchover.sh google
```

Outage of the primary. Use `--no-deps`: otherwise `docker compose run`
starts the stopped database again.

```bash
docker compose stop pg-google                                        # writes: PRIMARY_UNAVAILABLE
docker compose run --rm --no-deps tools scripts/switchover.sh --force azure
```

Writes work again within a few seconds. The stopped node must then be reset
and added back ([operations.md](docs/operations.md#switchover)). The quickest
way back to a clean local state is "Logs and cleanup" below.

### 5. After changing code

```bash
npm run typecheck && npm test
docker compose up -d --build   # rebuilds and restarts the API containers
```

After changing `models/*.yaml`, run `npm run generate` first
([docs/models.md](docs/models.md)). After a new file in `migrations/`, run
`scripts/migrate.sh` and then `scripts/replication-setup.sh` again: logical
replication does not replicate DDL, and the publication must be refreshed to
include new tables. Then rebuild the APIs (`docker compose up -d --build`):
they read the models at startup.

To release the change (feature branch → `dev` → `staging` → `prod` →
`main`), see [Releases](docs/operations.md#releases).

### 6. Logs and cleanup

```bash
docker compose logs -f api-aws   # API logs
docker compose down -v           # stop and delete the containers and database volumes
```

The PostgreSQL data lives in anonymous volumes. After `docker compose down`
(without `-v`) the next `up` starts with empty databases anyway, and the old
volumes are left behind, so use `down -v`. To start over, run steps 1–2 again.

## Environment variables

The API reads its settings from environment variables (`src/config.ts`); see
[.env.sample](.env.sample). In the local environment, `compose.yaml` sets
them. On the clouds, the container platform sets them and the secrets come
from each cloud's secret store.

| Variable           | Description                                         |
| ------------------ | --------------------------------------------------- |
| `CLOUD_ID`         | Cloud this instance runs on (`aws`, `google`, `azure`) |
| `PORT`             | Listening port (default `8080`)                     |
| `GRAPHIQL_ENABLED` | `true` serves GraphiQL on `/graphql` (local only)   |
| `APP_VERSION`      | Commit of the image, returned by the health endpoints (set by the `Dockerfile`; default `unknown`) |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | This cloud's database |
| `DB_SSLMODE`       | `disable`, `require` (default) or `verify-full`     |
| `DB_SSL_CA_FILE`   | CA bundle for `verify-full`                         |
| `DB_POOL_MAX`      | Connection pool size for this cloud's database (default `4`) |
| `DB_PEER_POOL_MAX` | Connection pool size for each node in `PEER_NODES`, used for writes (default `3`) |
| `PEER_NODES`       | The other nodes, comma-separated (e.g. `google,azure`) |
| `DB_<NODE>_HOST`, `DB_<NODE>_PASSWORD` | Database of each node in `PEER_NODES` (required) |
| `DB_<NODE>_PORT`, `_NAME`, `_USER`, `_SSLMODE`, `_SSL_CA_FILE` | Optional; default to this cloud's `DB_*` (port `5432`) |
| `WRITE_ACK_PEERS`  | Other nodes that must confirm a write (default `1`; `0` without peers) |
| `WRITE_ACK_TIMEOUT_MS` | Wait for the confirmation (default `3000`)      |
| `PRIMARY_REFRESH_INTERVAL_MS` | How often the primary is looked up (default `5000`) |
| `JOURNAL_RETENTION_DAYS` | Journal pruning job (`node dist/prune.js`) only: days the write journal keeps a write and its idempotency key (default `30`) |

## Errors

Besides `BAD_USER_INPUT`, `NOT_FOUND` and `VERSION_CONFLICT`, writes can fail
with (`extensions.code`):

| Code | Meaning | Client action |
| --- | --- | --- |
| `PRIMARY_UNAVAILABLE` | No primary is known, it is unreachable, or it just changed. Nothing was written | Retry after a short wait |
| `COMMIT_UNCONFIRMED` | The write was sent to the primary, but whether it was committed and copied to another cloud is unknown | Retry with the same `idempotencyKey`, or read to check before retrying |
| `IDEMPOTENCY_KEY_REUSED` | The `idempotencyKey` was already used for a different write | Use a new key per write |
| `CONSTRAINT_VIOLATION` | A unique or foreign key constraint rejected the write | Fix the input |
| `TOO_MANY_ROWS` | A bulk write matched more rows than its `maxRows`; nothing was written | Narrow `where` |
| `QUERY_TIMEOUT` | A named query ran longer than its `timeoutMs` | Narrow the parameters |

### Idempotency keys

Every mutation takes an optional `idempotencyKey` (1–200 characters, e.g. a
UUID generated by the client for each write). A retry with the same key and
the same arguments returns the first result instead of writing again, even
through another cloud's API and after a switchover. This makes retries
after `COMMIT_UNCONFIRMED`, `PRIMARY_UNAVAILABLE` or a timeout safe:

```graphql
mutation {
  createItem(input: {name: "hello"}, idempotencyKey: "7f9c…") { id }
}
```

Keys are kept as long as the write journal keeps the write
(`scripts/journal-prune.sh`, 30 days by default).

## Endpoints

| Path       | Description                                  |
| ---------- | -------------------------------------------- |
| `/`, `/healthz` | Liveness (no database access)           |
| `/readyz`  | Readiness: this cloud's database answers and has every migration in the image (`503` until `scripts/migrate.sh` has run there); the primary is not checked |
| `/graphql` | GraphQL API                                  |

Every health endpoint returns `{"status", "cloud", "version"}`; `version`
is the commit the image was built from, to check that every cloud runs the
same release.

## License

[MIT](LICENSE)
