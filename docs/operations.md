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

Each environment deploys its own branch of this repository (the triggers
are set by the infrastructure repository):

| Branch | Deploys to |
| --- | --- |
| `dev` | dev environment (development; feature branches are merged here by pull request) |
| `staging` | stg environment |
| `prod` | prod environment |
| `main` | nothing: keeps the code released to prod (tag `vX.Y.Z` if needed) |

Every branch changes only through pull requests (branch rules on GitHub).
A promotion is a pull request from the previous branch, merged with a merge
commit (the only method allowed on `staging`, `prod` and `main`; squash or
rebase would make the branches diverge), so each environment gets the code
that was tested before it:

```
feature/* --PR--> dev --PR--> staging --PR--> prod --PR--> main
```

The merge commits differ per branch, so the `version` on `/healthz` differs
between environments; within an environment, every cloud must show the same.

For each environment, before moving its branch:

1. Update its databases (from that environment's script host):
   `scripts/migrate.sh`; then `scripts/replication-setup.sh` if a table was
   added, and `scripts/api-role-setup.sh` if a function for the API was
   added. The API builds its SQL from the models at startup, so a version
   that uses new tables or columns does not work before this; its
   `/readyz` stays `503` and the platforms keep the old version serving.
2. Move the branch (merge the pull request). Each cloud builds (running
   the tests) and deploys.
3. Check every cloud: `/readyz`, the same `version` on `/healthz`, and a
   write through an API outside the primary's cloud.
4. If only some clouds failed, run their build again: the migrations are
   additive, so the old and new versions can run side by side.
5. After prod is checked, merge a pull request from `prod` into `main`.

Dropping a column or table is a hand-written migration in the release
**after** every environment runs a version that no longer uses it
([models.md](models.md)).

**Rolling back**: revert on the environment's branch; the previous version
is deployed again. The database changes stay (they are additive).

**Hotfix**: branch `hotfix/*` from `prod`, merge it into `prod` by pull
request (through `staging` first if it needs testing), then merge `prod`
into `staging` and `staging` into `dev` by pull request so that the fix is
not lost by the next promotion.

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

`app.write_journal` grows by one row per write. Delete old rows regularly
(e.g. a daily scheduled job on the scripts host):

```bash
DAYS=30 scripts/journal-prune.sh
```

It runs on the primary only (the deletions replicate). `DAYS` is also how
long idempotency keys work: choose it longer than any client may retry.

## Adding a node

1. Add the node to `NODES` and its `NODE_<N>_*` settings in
   `replication/nodes.env`.
2. Apply the migrations and create the API role on the new node:

   ```bash
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

- **API role:** every API connects to every node (writes go to the
  primary), so a node's API password is used by all clouds. Set the new
  password in `NODE_<N>_API_PASSWORD` and run
  `scripts/api-role-setup.sh <node>`; then update `DB_PASSWORD` (that
  cloud) and `DB_<NODE>_PASSWORD` (the other clouds) in the secret stores and
  restart all APIs. Existing connections keep working until then.
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
