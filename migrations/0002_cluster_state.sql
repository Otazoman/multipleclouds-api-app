-- Write routing (docs/architecture.md, "Writes"). Everything here is in
-- schema "ops", so it is node-local and never replicated: each node keeps its
-- own copy of the cluster state, set by scripts/switchover.sh.
--
-- The functions are SECURITY DEFINER so that the API role only needs EXECUTE
-- on them (scripts/api-role-setup.sh), not access to the table.

CREATE TABLE IF NOT EXISTS ops.cluster_state (
  -- One row per node.
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  -- Name of this node (lowercase cloud ID, as in NODES).
  node_name text NOT NULL,
  -- Node that accepts writes in this epoch.
  primary_node text NOT NULL,
  -- Incremented on every switchover; the highest epoch wins.
  epoch bigint NOT NULL CHECK (epoch > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- This node's view of the cluster (no row before the first switchover).
CREATE OR REPLACE FUNCTION ops.get_cluster_state()
RETURNS TABLE (node_name text, primary_node text, epoch bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT node_name, primary_node, epoch FROM ops.cluster_state
$$;

-- Fails unless this node is the primary of the given epoch. Called at the
-- start of every write transaction. FOR SHARE makes a switchover (which
-- updates the row) wait for running write transactions, and makes later
-- write transactions see the new state.
CREATE OR REPLACE FUNCTION ops.assert_primary(expected_epoch bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  state record;
BEGIN
  SELECT s.node_name, s.primary_node, s.epoch INTO state
    FROM ops.cluster_state s FOR SHARE;
  IF NOT FOUND
     OR state.primary_node <> state.node_name
     OR state.epoch <> expected_epoch THEN
    RAISE EXCEPTION 'node is not the primary of epoch %', expected_epoch
      USING ERRCODE = 'MCP01';
  END IF;
END
$$;

-- Waits until at least `required` other nodes have confirmed (flushed) all
-- WAL written so far on this node, i.e. the transactions committed before
-- the call. Returns false after timeout_ms. The subscriptions use
-- synchronous_commit = on (scripts/replication-setup.sh), so the confirmed
-- position is reported as soon as the subscriber has flushed.
CREATE OR REPLACE FUNCTION ops.wait_for_peers(required integer, timeout_ms integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target pg_lsn := pg_current_wal_lsn();
  deadline timestamptz := clock_timestamp() + make_interval(secs => timeout_ms / 1000.0);
BEGIN
  LOOP
    IF (SELECT count(*)
          FROM pg_replication_slots
         WHERE slot_name LIKE 'mc\_sub\_%'
           AND confirmed_flush_lsn >= target) >= required THEN
      RETURN true;
    END IF;
    IF clock_timestamp() >= deadline THEN
      RETURN false;
    END IF;
    PERFORM pg_sleep(0.001);
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION ops.get_cluster_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.assert_primary(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.wait_for_peers(integer, integer) FROM PUBLIC;
