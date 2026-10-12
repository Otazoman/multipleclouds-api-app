#!/usr/bin/env bash
# Deletes app.write_journal rows older than DAYS days (default 30) on the
# primary; the deletions replicate to the other nodes. DAYS is also how long
# idempotency keys work. Run it regularly (e.g. daily).
#
# Runs only on the primary of the highest epoch (checked in the same
# transaction with ops.assert_primary), never on a secondary: a deletion
# there would not reach the others.
#
# Usage: [DAYS=30] scripts/journal-prune.sh

source "$(dirname "$0")/lib.sh"

DAYS="${DAYS:-30}"
BATCH=10000
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-5}"
if ! [[ "$DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "DAYS must be a positive integer" >&2
  exit 1
fi

# The primary of the highest epoch among the reachable nodes.
read -r -a nodes <<< "$NODES"
primary=""
epoch=0
for node in "${nodes[@]}"; do
  state="$(psql_admin "$node" -At -F ' ' 2>/dev/null <<'SQL'
SELECT primary_node, epoch FROM ops.cluster_state;
SQL
)" || continue
  [[ -z "$state" ]] && continue
  read -r p e <<< "$state"
  if (( e > epoch )); then
    primary="$p"
    epoch="$e"
  fi
done
if [[ -z "$primary" ]]; then
  echo "No primary found (scripts/switchover.sh)" >&2
  exit 1
fi

echo "-- deleting journal rows older than $DAYS days on $primary (epoch $epoch)"
total=0
while :; do
  # Last line: the number of rows deleted in this batch.
  count="$(psql_admin "$primary" -At -v epoch="$epoch" -v days="$DAYS" -v batch="$BATCH" <<'SQL' | tail -n 1
BEGIN;
SELECT ops.assert_primary(:epoch);
WITH old AS (
  SELECT id FROM app.write_journal
   WHERE committed_at < now() - make_interval(days => :days)
   LIMIT :batch
), deleted AS (
  DELETE FROM app.write_journal j USING old WHERE j.id = old.id RETURNING 1
)
SELECT count(*) FROM deleted;
COMMIT;
SQL
)"
  total=$(( total + count ))
  (( count < BATCH )) && break
done
echo "   deleted $total"
