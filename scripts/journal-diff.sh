#!/usr/bin/env bash
# Lists the writes in app.write_journal of <node> that <reference> does not
# have, committed since SINCE (default: 7 days ago). Read-only.
#
# Typical uses (docs/operations.md, "Switchover"):
#   - an old primary that comes back after a forced switchover:
#       scripts/journal-diff.sh <old primary> <current primary>
#     shows its writes that never reached the others (clients got
#     COMMIT_UNCONFIRMED or no answer), before the node is reset
#   - a node that received less than the new primary:
#       scripts/journal-diff.sh <current primary> <lagging node>
#     shows the old primary's writes the lagging node misses
#
# Each row shows the operation, its arguments and its result, so the writes
# can be reviewed and, if needed, sent again through the API.
#
# Usage: [SINCE='2026-01-31 00:00+09'] scripts/journal-diff.sh <node> <reference>

source "$(dirname "$0")/lib.sh"

if (( $# != 2 )); then
  echo "Usage: [SINCE=<timestamp>] $0 <node> <reference>" >&2
  exit 1
fi
node="$1"
reference="$2"
since="${SINCE:-$(date -u -d '7 days ago' '+%Y-%m-%d %H:%M:%S+00')}"

reference_ids="$(psql_admin "$reference" -At -v since="$since" <<'SQL'
SELECT id FROM app.write_journal WHERE committed_at >= :'since'::timestamptz;
SQL
)"

echo "-- writes on $node missing on $reference since $since"
{
  echo "CREATE TEMP TABLE reference_ids (id uuid PRIMARY KEY);"
  echo "COPY reference_ids FROM STDIN;"
  [[ -n "$reference_ids" ]] && printf '%s\n' "$reference_ids"
  echo '\.'
  cat <<'SQL'
SELECT j.committed_at, j.epoch, j.node, j.operation, j.idempotency_key,
       j.args, j.result
  FROM app.write_journal j
 WHERE j.committed_at >= :'since'::timestamptz
   AND NOT EXISTS (SELECT 1 FROM reference_ids r WHERE r.id = j.id)
 ORDER BY j.committed_at, j.id;
SQL
} | psql_admin "$node" -P pager=off -v since="$since"
