# Operations

[日本語](operations.ja.md)

Procedures for the deployed environment. The scripts run from the host
described in [getting-started.md](getting-started.md) (node settings in
`replication/nodes.env`, passwords exported in the shell). Every script can
also be tried first on the local compose environment
(`docker compose run --rm tools scripts/<script>.sh`). Locally, pass
environment variables with `-e` (e.g. `-e SEED_FROM=aws`), and add
`--no-deps` while a database is stopped on purpose: otherwise
`docker compose run` starts it again.

## Schema changes (migrations)

Logical replication does not replicate DDL. Every node must get every
migration.

1. Generate the migration from the model definitions (`npm run generate`,
   [models.md](models.md)), or, for changes it does not generate, add a new
   file `migrations/NNNN_description.sql` (next number) by hand. Never edit
   a migration that may have been applied anywhere.
2. Keep changes backward compatible with the running API: add tables or
   nullable / defaulted columns first, deploy the API that uses them after.
3. Apply to every node:

   ```bash
   scripts/migrate.sh
   ```

4. If the migration added a table, include it in replication **before** the
   API writes to it:

   ```bash
   scripts/replication-setup.sh
   scripts/replication-status.sh
   ```

5. Deploy the API ([Releases](#releases)). If the migration added a
   function the API calls, run `scripts/api-role-setup.sh` first. The new
   API is not ready (`/readyz` returns `503`) on a node that lacks one of
   its migrations.

Why the order matters: if a node receives a change for a table or column it
does not have yet, applying the change fails and that subscription stops
until the migration is applied there.

Dropping or renaming a column: first deploy an API that no longer uses it,
then apply the migration to every node.

## Releases

Code moves from a local feature branch through the environments by pull
request. Each environment deploys its own branch (the triggers are set by
the infrastructure repository):

| Branch | Deploys to | Updated by |
| --- | --- | --- |
| `feature/*`, `hotfix/*` | nothing | you (push) |
| `dev` | dev environment | pull request from `feature/*` |
| `staging` | stg environment | pull request from `dev` |
| `prod` | prod environment | pull request from `staging` (or `hotfix/*`) |
| `main` | nothing: the code released to prod | pull request from `prod` |

```
feature/* --PR--> dev --PR--> staging --PR--> prod --PR--> main
 (local)          dev env     stg env         prod env    (record)
```

GitHub's branch rules require a pull request for `dev`, `staging`, `prod`
and `main`, and refuse force pushes and deletions. On `staging`, `prod` and
`main` the only merge method is **Create a merge commit**: squash or rebase
would give the branches different histories, and the next promotion would
conflict. The merge commits differ per branch, so the `version` on
`/healthz` differs between environments; within an environment, every
cloud must show the same.

The examples use the GitHub CLI (`gh`); the same can be done on github.com.

### 0. After cloning (once per clone)

The branches `dev`, `staging`, `prod` and `main` already exist on GitHub
(with their branch rules): do not create them again. A clone only needs:

```bash
git clone https://github.com/Otazoman/multipleclouds-api-app.git
cd multipleclouds-api-app
# Commits must not publish your private email (GitHub rejects such pushes)
git config user.email "<id>+<user>@users.noreply.github.com"   # your GitHub noreply address
gh auth login                  # for gh pr create / gh pr merge (once per machine)
git switch dev                 # the clone starts on dev (the default branch)
```

`git switch staging` (or `prod`, `main`) creates a local branch tracking
GitHub's when you need to look at it; promotions do not need local branches,
since their pull requests are made between GitHub's branches
(`gh pr create --base staging --head dev`). Never push to these branches
directly: the branch rules refuse it.

### 1. Develop locally

```bash
git switch dev && git pull
git switch -c feature/<name>
# ... change the code / models/*.yaml / migrations ...
npm run generate               # after changing models/*.yaml (docs/models.md)
npm run typecheck && npm test
```

Then check the change in the local compose environment (README, "Local
testing"): rebuild the APIs, apply new migrations, and run the scripts the
change needs:

```bash
docker compose up -d --build
docker compose run --rm tools scripts/migrate.sh
docker compose run --rm tools scripts/replication-setup.sh   # if a table was added
docker compose run --rm tools scripts/api-role-setup.sh      # if a function for the API was added
curl localhost:8081/readyz                                   # 200 on every API (8081-8083)
```

Changes to writes, SQL, migrations or scripts also need a write through an
API outside the primary and, for write routing, a switchover (README).

Push and open a pull request to `dev`:

```bash
git push -u origin feature/<name>
gh pr create --base dev --title "<what changes>" --body "<why; migrations; scripts to run>"
```

In the pull request, list the database steps the release needs (new
migrations, `replication-setup.sh`, `api-role-setup.sh`): they must be done
in every environment before its branch moves.

### 2. Release to an environment (dev, stg, prod)

The same steps for each environment, in this order: dev (merging the
feature pull request), then stg (`dev` → `staging`), then prod (`staging`
→ `prod`).

1. **Update the environment's databases first**, from that environment's
   script host ([getting-started.md](getting-started.md)), when the release
   contains migrations:

   ```bash
   git fetch && git switch --detach origin/<branch to be released>   # e.g. origin/dev before a stg release
   scripts/migrate.sh
   scripts/replication-setup.sh && scripts/replication-status.sh   # if a table was added
   scripts/api-role-setup.sh                                       # if a function for the API was added
   ```

   The API builds its SQL from the models at startup, so a version that
   uses new tables or columns does not work before this. If it is
   forgotten, the new version's `/readyz` stays `503` and the platforms
   keep the old version serving. Migrations are additive, so the running
   version keeps working after this step.

2. **Merge the pull request** of that environment:

   ```bash
   # dev: merge the feature pull request
   gh pr merge <number> --merge --delete-branch
   # stg / prod: open and merge a promotion pull request
   gh pr create --base staging --head dev --title "Release to stg" --body ""
   gh pr create --base prod --head staging --title "Release to prod" --body ""
   gh pr merge <number> --merge
   ```

   Each cloud builds the image (the build runs the tests and stops on a
   failure) and deploys it: AWS CodeBuild → ECS, Cloud Build → Cloud Run,
   Azure Pipelines → Container Apps.

3. **Check every cloud** of the environment:

   ```bash
   curl https://<endpoint>/healthz   # same "version" on the three clouds
   curl https://<endpoint>/readyz    # 200
   ```

   and a write through an API outside the primary's cloud (README, "Check
   the APIs").

4. If only some clouds failed, fix the cause and run their build again
   (CodeBuild, Cloud Build trigger, Azure Pipelines): the old and new
   versions can run side by side while the migrations are additive.

5. Before the next environment, check the changes in this one long enough
   for the release (functions, performance, logs).

### 3. Record the release in `main`

After prod is checked:

```bash
gh pr create --base main --head prod --title "Released to prod" --body ""
gh pr merge <number> --merge
git fetch && git tag vX.Y.Z origin/main && git push origin vX.Y.Z   # optional
```

`main` starts no build; it shows what is in prod.

### Dropping columns or tables

A drop is a hand-written migration in the release **after** every
environment runs a version that no longer uses the column or table
([models.md](models.md)). Otherwise the running version fails as soon as
the migration is applied.

### Rolling back

Revert on the environment's branch by pull request; the previous version is
deployed again:

```bash
git switch -c revert/<name> origin/<branch>
git revert -m 1 <merge commit>     # the merge commit of the release
git push -u origin revert/<name>
gh pr create --base <branch> --title "Revert <release>" --body ""
```

The database changes stay (they are additive; the previous version ignores
them). The earlier branches (e.g. `dev`) still contain the change: fix it
there and promote the fix as usual. The revert stays in the environment's
branch, so to release the change again later, revert the revert in `dev`
and promote it.

### Hotfix

```
prod --> hotfix/* --PR--> prod --PR--> main
                            \--PR--> staging --PR--> dev
```

```bash
git switch -c hotfix/<name> origin/prod
# ... fix, npm run typecheck && npm test, local check ...
git push -u origin hotfix/<name>
gh pr create --base prod --title "Hotfix: <what>" --body ""
```

To test it on stg first, merge it into `staging` before `prod`. Database
steps are the same as for a release (step 2.1). After the release, bring
the fix back so that the next promotion does not remove it:

```bash
gh pr create --base staging --head prod --title "Back-merge hotfix" --body ""
gh pr create --base dev --head staging --title "Back-merge hotfix" --body ""
```

Merge these with a merge commit too, and record prod in `main` (section 3).

## Monitoring replication

```bash
scripts/replication-status.sh
```

| Section | Healthy | Look at |
| --- | --- | --- |
| cluster state | Same `primary_node` and `epoch` on every node | A node with a lower epoch: run `scripts/switchover.sh <current primary>` |
| subscriptions | `enabled = t`, `latest_end_time` recent | An old `latest_end_time`: the publisher is unreachable or the apply worker keeps failing |
| replication slots | `active = t`, small `retained_wal` | `active = f` and growing `retained_wal`: a subscriber is down; WAL accumulates on this node |
| apply errors | `0` | Increasing counts: see "Apply errors" |

`retained_wal` grows on every node while another node is down. Watch the
database disk usage during a long outage.

## Apply errors

When a received change cannot be applied (missing table or column, a
constraint violation), the subscription's apply worker stops, restarts and
retries the same change. Nothing after it is applied on that node.

1. Find the error in the subscriber database's log (the cloud's log service).
2. Fix the cause. Missing table or column: run `scripts/migrate.sh` on that
   node.
3. The worker resumes by itself on its next retry.

Skipping a change (`ALTER SUBSCRIPTION ... SKIP`) loses that change on this
node and leaves the databases different. Do it only after deciding how to
repair the data.

## Cloud outage

**A secondary (not the primary) is down**

- That cloud's API cannot read (its `/readyz` fails); the other clouds keep
  reading and writing. Writes are confirmed by the remaining secondary.
- The other nodes keep WAL for the failed node (`retained_wal`). Watch disk
  usage.
- When the node is back, its subscriptions reconnect and catch up by
  themselves. If a switchover happened meanwhile, run
  `scripts/switchover.sh <current primary>` to give it the current state.

**The primary is down**

- Writes fail with `PRIMARY_UNAVAILABLE` (after up to 5 seconds of connection
  timeout per request); reads continue on the other clouds.
- Move the primary with a forced switchover (below). Writes resume within
  `PRIMARY_REFRESH_INTERVAL_MS`.

If an outage lasts so long that retained WAL threatens the other databases'
disks, remove the failed node from replication (below) and add it back
later (see "Adding a removed node back").

## Switchover

The primary is the node that accepts writes ([architecture.md](architecture.md#writes)).
`scripts/replication-status.sh` shows each node's view of it (cluster
state).

### First setup

After `replication-setup.sh`, with every node reachable:

```bash
scripts/switchover.sh <node>
```

### Planned switchover

The current primary is up (maintenance, moving the primary closer to the
users, rehearsal):

```bash
scripts/switchover.sh <target>
```

The old primary stops accepting writes first, then the script waits until
the target has flushed everything (up to `CATCHUP_TIMEOUT`, default 60 s),
then the other nodes follow. Writes fail for about a second with
`PRIMARY_UNAVAILABLE`. If the wait times out, no node accepts writes: run
the script again, or use `--force` if the old primary is no longer usable.

### Forced switchover

The current primary is down, or cut off from the other databases so that a
planned switchover cannot complete. If it is still reachable from the host
running the script, the script fences it first. Otherwise make sure it
really is down or cut off (it cannot confirm writes either way, but its own
cloud's API may still reach it), then:

```bash
scripts/switchover.sh --force <target>
```

- The script shows how much each reachable node received from the old
  primary. The target must be the node that received the most; otherwise
  the script stops (writes confirmed only by another node would be missing).
  `--allow-behind` overrides this.
- On every reachable node it disables the subscription from the old primary,
  so that the old primary's unconfirmed writes cannot arrive later and
  overwrite newer data, and sets the new state.
- If it warns that some nodes received less than the target, those nodes
  miss some of the old primary's writes for good (changes are not forwarded
  between nodes). `scripts/journal-diff.sh <target> <lagging node>` lists
  them. Reset those nodes: "Removing a node", then "Adding a removed node
  back".

### After a forced switchover

The old primary must not rejoin as it is: it may hold writes that were never
confirmed (clients got `COMMIT_UNCONFIRMED` or no answer). When it is back:

1. List its writes that never reached the others, with their arguments and
   results, and keep the output:

   ```bash
   SINCE='<a time before the outage>' scripts/journal-diff.sh <old primary> <current primary>
   ```

   Clients got `COMMIT_UNCONFIRMED` (or no answer) for these writes. Those
   that retry with the same idempotency key have already written again on
   the new primary; the others can be reviewed and sent again through the
   API if needed.
2. Remove it ("Removing a node") and add it back ("Adding a removed node
   back"). This resets its data.

### Nodes that were unreachable during a switchover

They keep the old state until they get the new one:

```bash
scripts/switchover.sh <current primary>
```

The APIs are not misled meanwhile: they use the highest epoch they can see.

## Write journal

`app.write_journal` grows by one row per write, and keeps each write's
arguments and result. A scheduled job deletes the rows older than
`JOURNAL_RETENTION_DAYS` (default 30) every day: `node dist/prune.js` in the
API image, with the API's settings (`src/prune.ts`). The infrastructure
repository creates it on every cloud with a database
(`apiContainerConfig.journalPrune`): EventBridge Scheduler and an ECS task,
Cloud Scheduler and a Cloud Run job, a Container Apps job. CI/CD keeps its
image the same as the API's. Only the primary deletes (the deletions
replicate), so the runs on the other clouds find nothing to do, and the
pruning goes on while a cloud is down. Check the job runs in each cloud's
console (execution history and logs: `Deleted N journal rows ...`).

To prune by hand (e.g. before the jobs exist), from the scripts host:

```bash
DAYS=30 scripts/journal-prune.sh
```

The retention is also how long idempotency keys work: choose it longer
than any client may retry.

## Adding a node

1. Add the node to `NODES` and its `NODE_<N>_*` settings in
   `replication/nodes.env`.
2. Create the database, apply the migrations and create the API role on
   the new node (`database-create.sh` also checks that its collation matches
   the other nodes):

   ```bash
   scripts/database-create.sh <new>
   scripts/migrate.sh <new>
   scripts/api-role-setup.sh <new>
   ```

3. **Stop writes on all nodes** (stop the API services). Otherwise rows
   written during the copy may be missing on the new node.
4. Create the subscriptions, copying the existing rows from one existing
   node:

   ```bash
   SEED_FROM=<existing> scripts/replication-setup.sh
   scripts/replication-status.sh
   ```

5. Give the new node the current primary:

   ```bash
   scripts/switchover.sh <current primary>
   ```

6. Wait until the new node has the data (the initial copy runs in the
   background), then start the APIs again, including the new one.
7. For a node that is new to the cluster (not one added back), add it to
   `PEER_NODES` and its `DB_<NODE>_*` settings on every other API, and deploy
   its API with the others in its `PEER_NODES`.

## Removing a node

There is no script for this. Do not remove the primary: switch over first.

1. If the removed node is reachable, first drop its own subscriptions on it
   (this also drops their slots on the other nodes):

   ```sql
   DROP SUBSCRIPTION mc_sub_<other>_to_<removed>;   -- for each other node
   ```

2. On **each remaining node**, as the admin user:

   ```sql
   -- Stop receiving from the removed node.
   -- If the removed node is unreachable, detach the slot first:
   ALTER SUBSCRIPTION mc_sub_<removed>_to_<this> DISABLE;
   ALTER SUBSCRIPTION mc_sub_<removed>_to_<this> SET (slot_name = NONE);
   DROP SUBSCRIPTION mc_sub_<removed>_to_<this>;

   -- Stop keeping WAL for the removed node (skip if step 1 dropped it).
   -- A node that was cut off can still hold the slot for up to
   -- wal_sender_timeout (1 minute); end that connection first.
   SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots
    WHERE slot_name = 'mc_sub_<this>_to_<removed>' AND active;
   SELECT pg_drop_replication_slot('mc_sub_<this>_to_<removed>');
   ```

3. Remove the node from `NODES`.

## Adding a removed node back

The removed node's data is outdated and it still has its old
subscriptions. Reset it, then add it as a new node.

1. On the removed node, as the admin user (its old slots on the other nodes
   are already gone, so detach before dropping):

   ```sql
   SELECT format('ALTER SUBSCRIPTION %I DISABLE', subname)
     FROM pg_subscription WHERE subname LIKE 'mc\_sub\_%' \gexec
   SELECT format('ALTER SUBSCRIPTION %I SET (slot_name = NONE)', subname)
     FROM pg_subscription WHERE subname LIKE 'mc\_sub\_%' \gexec
   SELECT format('DROP SUBSCRIPTION %I', subname)
     FROM pg_subscription WHERE subname LIKE 'mc\_sub\_%' \gexec
   SELECT pg_drop_replication_slot(slot_name)
     FROM pg_replication_slots WHERE slot_name LIKE 'mc\_sub\_%';
   -- The publication does not publish TRUNCATE; dropping it as well makes
   -- sure nothing from this node reaches another node (replication-setup.sh
   -- recreates it).
   DROP PUBLICATION IF EXISTS mc_pub;
   TRUNCATE app.items, app.write_journal;   -- every table in schema "app"
   ```

   Rows that were written on this node but never reached the others are
   lost by this step. Export them first if they matter.

2. Follow "Adding a node" from step 1.

## Passwords

- **API role:** every node's `app_api` has the same password, stored in
  every cloud's secret `db-api-password` ([getting-started.md](getting-started.md)).
  Set the new password in every `NODE_<N>_API_PASSWORD` and run
  `scripts/api-role-setup.sh`; then update `db-api-password` in every
  cloud's secret store and restart all APIs (a new deployment: the
  platforms read the secret when a container starts). Existing connections
  keep working until then, but new ones fail: do it at a quiet time and
  without delay between the steps.
- **Replication role:** change `NODE_<N>_REPL_PASSWORD` and run
  `scripts/replication-setup.sh`. It sets the new password on the role and
  updates the connection string of the subscriptions that use it. Between
  the two, the affected subscriptions cannot reconnect; writes may get
  `COMMIT_UNCONFIRMED` if no other node can confirm them meanwhile.

## Local environment reset

```bash
docker compose down -v
docker compose up -d --build
```

Then run the database setup again (README, "Local testing").
