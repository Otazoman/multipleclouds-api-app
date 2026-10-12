#!/usr/bin/env bash
# Shows the replication state of every node in NODES: the node's view of the
# primary (scripts/switchover.sh), subscriptions (received changes) and
# replication slots (changes kept for other nodes).
#
# Usage: scripts/replication-status.sh

source "$(dirname "$0")/lib.sh"

read -r -a nodes <<< "$NODES"
for node in "${nodes[@]}"; do
  echo "== $node"
  psql_admin "$node" -P pager=off <<'SQL'
\echo 'cluster state (scripts/switchover.sh)'
SELECT node_name, primary_node, epoch, updated_at FROM ops.cluster_state;
\echo 'subscriptions (enabled, last message received from the publisher)'
SELECT s.subname, s.subenabled AS enabled, st.received_lsn, st.latest_end_time
  FROM pg_subscription s
  LEFT JOIN pg_stat_subscription st ON st.subid = s.oid AND st.relid IS NULL
 WHERE s.subname LIKE 'mc\_sub\_%'
 ORDER BY s.subname;
\echo 'replication slots (WAL retained for subscribers on other nodes)'
SELECT slot_name, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS retained_wal
  FROM pg_replication_slots
 WHERE slot_name LIKE 'mc\_sub\_%'
 ORDER BY slot_name;
\echo 'apply errors since the last reset'
SELECT subname, apply_error_count, sync_error_count
  FROM pg_stat_subscription_stats
 WHERE subname LIKE 'mc\_sub\_%'
 ORDER BY subname;
SQL
done
