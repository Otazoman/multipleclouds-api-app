#!/usr/bin/env bash
# Sets the primary (the node that accepts writes) in ops.cluster_state on
# every node (migrations/0002_cluster_state.sql). The APIs read it and send
# writes to the primary of the highest epoch. See docs/operations.md,
# "Switchover".
#
#   scripts/switchover.sh <target>
#     - no node has a state yet: first setup (epoch 1; every node must be
#       reachable)
#     - <target> is the current primary: copies the current state to nodes
#       that are behind (e.g. a node that was unreachable during a switchover)
#     - otherwise: planned switchover; the current primary must be reachable
#         1. the current primary gets the new state first, so it rejects
#            writes from then on (ops.assert_primary)
#         2. waits until <target> has flushed everything the old primary
#            wrote (CATCHUP_TIMEOUT seconds, default 60)
#         3. the other nodes get the new state
#
#   scripts/switchover.sh --force [--allow-behind] <target>
#     The current primary is down or cut off from the other databases (a
#     planned switchover cannot complete). If it is still reachable from
#     here, it is fenced first (gets the new state). On every other reachable
#     node, disables
#     the subscription from the old primary (its unconfirmed writes must not
#     arrive later) and sets the new state. <target> must have received at
#     least as much from the old primary as every other reachable node;
#     --allow-behind overrides this check. Nodes that received less than
#     <target> are listed: they miss some of the old primary's writes, which
#     the other nodes do not forward (origin = none), and must be reset.
#
# Usage: scripts/switchover.sh [--force] [--allow-behind] <target>

source "$(dirname "$0")/lib.sh"

usage() {
  echo "Usage: $0 [--force] [--allow-behind] <target>" >&2
  exit 1
}

force=false
allow_behind=false
target=""
for arg in "$@"; do
  case "$arg" in
    --force) force=true ;;
    --allow-behind) allow_behind=true ;;
    -*) usage ;;
    *) [[ -z "$target" ]] || usage; target="$arg" ;;
  esac
done
[[ -n "$target" ]] || usage

read -r -a nodes <<< "$NODES"
if [[ " ${nodes[*]} " != *" $target "* ]]; then
  echo "$target is not in NODES ($NODES)" >&2
  exit 1
fi

# Unreachable nodes must not stall the script.
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-5}"
CATCHUP_TIMEOUT="${CATCHUP_TIMEOUT:-60}"

# Prints "<primary> <epoch>", or nothing when the node has no state yet.
read_state() {
  psql_admin "$1" -At -F ' ' <<'SQL'
SELECT primary_node, epoch FROM ops.cluster_state;
SQL
}

# write_state <node> <primary> <epoch>
write_state() {
  psql_admin "$1" -v node="$1" -v primary="$2" -v epoch="$3" <<'SQL'
INSERT INTO ops.cluster_state (node_name, primary_node, epoch)
VALUES (:'node', :'primary', :'epoch')
ON CONFLICT (singleton) DO UPDATE
   SET node_name = EXCLUDED.node_name,
       primary_node = EXCLUDED.primary_node,
       epoch = EXCLUDED.epoch,
       updated_at = now();
SQL
  echo "   $1: primary = $2, epoch = $3"
}

# "X/Y" LSN to a number, for comparisons.
lsn_number() {
  local high="${1%/*}" low="${1#*/}"
  echo $(( (16#$high << 32) + 16#$low ))
}

echo "-- current state"
declare -A reachable=() node_epoch=()
max_epoch=0
current=""
for node in "${nodes[@]}"; do
  if ! state="$(read_state "$node" 2>&1)"; then
    echo "   $node: unreachable ($(head -n 1 <<< "$state"))"
    continue
  fi
  reachable[$node]=1
  if [[ -z "$state" ]]; then
    echo "   $node: no state"
    node_epoch[$node]=0
    continue
  fi
  read -r primary epoch <<< "$state"
  echo "   $node: primary = $primary, epoch = $epoch"
  node_epoch[$node]="$epoch"
  if (( epoch > max_epoch )); then
    max_epoch="$epoch"
    current="$primary"
  fi
done

if [[ -z "${reachable[$target]:-}" ]]; then
  echo "$target is unreachable" >&2
  exit 1
fi

# First setup.
if (( max_epoch == 0 )); then
  if (( ${#reachable[@]} != ${#nodes[@]} )); then
    echo "First setup needs every node in NODES to be reachable" >&2
    exit 1
  fi
  echo "-- first setup"
  for node in "${nodes[@]}"; do
    write_state "$node" "$target" 1
  done
  exit 0
fi

# Target is already the primary: bring nodes that are behind up to date.
if [[ "$current" == "$target" ]]; then
  echo "-- $target is the primary of epoch $max_epoch; syncing nodes that are behind"
  for node in "${nodes[@]}"; do
    if [[ -n "${reachable[$node]:-}" ]] && (( node_epoch[$node] < max_epoch )); then
      write_state "$node" "$target" "$max_epoch"
    fi
  done
  exit 0
fi

new_epoch=$(( max_epoch + 1 ))

if [[ "$force" != true && -n "${reachable[$current]:-}" ]]; then
  echo "-- planned switchover: $current -> $target (epoch $new_epoch)"
  echo "1. fence $current"
  write_state "$current" "$target" "$new_epoch"
  lsn="$(psql_admin "$current" -At <<'SQL'
SELECT pg_current_wal_lsn();
SQL
)"

  echo "2. wait until $target has flushed $current up to $lsn"
  slot="mc_sub_${current}_to_${target}"
  deadline=$(( SECONDS + CATCHUP_TIMEOUT ))
  until [[ "$(psql_admin "$current" -At -v slot="$slot" -v lsn="$lsn" <<'SQL'
SELECT coalesce(bool_or(confirmed_flush_lsn >= :'lsn'::pg_lsn), false)
  FROM pg_replication_slots WHERE slot_name = :'slot';
SQL
)" == "t" ]]; do
    if (( SECONDS >= deadline )); then
      echo "$target did not catch up within ${CATCHUP_TIMEOUT}s." >&2
      echo "$current is fenced: no node accepts writes. Run this script again," >&2
      echo "or use --force if $current is no longer usable." >&2
      exit 1
    fi
    sleep 1
  done

  echo "3. other nodes"
  for node in "${nodes[@]}"; do
    [[ "$node" == "$current" ]] && continue
    if [[ -n "${reachable[$node]:-}" ]]; then
      write_state "$node" "$target" "$new_epoch"
    else
      echo "   $node: unreachable; run this script again when it is back"
    fi
  done
  exit 0
fi

# Forced: the current primary is unreachable or cannot replicate.
if [[ "$force" != true ]]; then
  echo "The current primary $current is unreachable. Use --force (docs/operations.md)." >&2
  exit 1
fi

echo "-- forced switchover: $current -> $target (epoch $new_epoch)"
if [[ -n "${reachable[$current]:-}" ]]; then
  echo "0. fence $current (reachable from here)"
  write_state "$current" "$target" "$new_epoch"
fi
echo "1. changes received from $current"
declare -A received=()
for node in "${!reachable[@]}"; do
  [[ "$node" == "$current" ]] && continue
  if ! lsn="$(psql_admin "$node" -At -v sub="mc_sub_${current}_to_${node}" 2>&1 <<'SQL'
SELECT s.remote_lsn
  FROM pg_subscription sub
  JOIN pg_replication_origin_status s ON s.external_id = 'pg_' || sub.oid
 WHERE sub.subname = :'sub'
   AND sub.subdbid = (SELECT oid FROM pg_database WHERE datname = current_database());
SQL
)"; then
    echo "   $node: cannot read ($(head -n 1 <<< "$lsn"))"
    lsn=""
  fi
  echo "   $node: ${lsn:-unknown}"
  received[$node]="$lsn"
done

behind=()
if [[ -z "${received[$target]}" ]]; then
  behind+=("unknown for $target")
else
  for node in "${!received[@]}"; do
    [[ -z "${received[$node]}" ]] && continue
    if (( $(lsn_number "${received[$node]}") > $(lsn_number "${received[$target]}") )); then
      behind+=("$node received more than $target")
    fi
  done
fi
if (( ${#behind[@]} > 0 )); then
  printf '   %s\n' "${behind[@]}"
  if [[ "$allow_behind" != true ]]; then
    echo "Choose the node that received the most, or use --allow-behind" >&2
    echo "(writes confirmed only by another node would be missing on $target)." >&2
    exit 1
  fi
fi

# Nodes that received less than the target miss some of the old primary's
# writes for good.
lagging=()
if [[ -n "${received[$target]}" ]]; then
  for node in "${!received[@]}"; do
    if [[ -z "${received[$node]}" ]] ||
       (( $(lsn_number "${received[$node]}") < $(lsn_number "${received[$target]}") )); then
      lagging+=("$node")
    fi
  done
fi

echo "2. disable the subscriptions from $current and set the new state"
for node in "${nodes[@]}"; do
  [[ -z "${reachable[$node]:-}" || "$node" == "$current" ]] && continue
  psql_admin "$node" -v sub="mc_sub_${current}_to_${node}" <<'SQL'
SELECT format('ALTER SUBSCRIPTION %I DISABLE', subname)
  FROM pg_subscription
 WHERE subname = :'sub' AND subenabled
   AND subdbid = (SELECT oid FROM pg_database WHERE datname = current_database()) \gexec
SQL
  write_state "$node" "$target" "$new_epoch"
done

echo "Done. $current must not rejoin as is: see docs/operations.md, \"Switchover\"."
if (( ${#lagging[@]} > 0 )); then
  echo "WARNING: ${lagging[*]} received less from $current than $target and miss" >&2
  echo "some of its writes. Reset them as described in docs/operations.md." >&2
fi
