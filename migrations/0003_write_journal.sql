-- Journal of committed writes: one row per write transaction, inserted by the
-- API in the same transaction (src/cluster.ts, PrimaryWriter). In schema
-- "app", so it is replicated and survives a switchover. Used for:
--   - idempotency keys: a retried mutation with the same key returns the
--     stored result instead of running again
--   - recovery: scripts/journal-diff.sh lists the writes that one node has
--     and another does not (e.g. an old primary's unconfirmed writes)
-- Old rows are deleted by scripts/journal-prune.sh.
--
-- Run scripts/replication-setup.sh after this migration so that the table
-- is replicated before the API writes to it.

CREATE TABLE IF NOT EXISTS app.write_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Epoch and node of the primary that ran the write.
  epoch bigint NOT NULL,
  node text NOT NULL,
  -- GraphQL mutation and its arguments (without the idempotency key).
  operation text NOT NULL,
  args jsonb NOT NULL,
  -- What the mutation returned.
  result jsonb NOT NULL,
  idempotency_key text,
  committed_at timestamptz NOT NULL DEFAULT now()
);

-- Unique only among keyed writes. Safe because only the primary writes.
CREATE UNIQUE INDEX IF NOT EXISTS write_journal_idempotency_key_idx
  ON app.write_journal (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS write_journal_committed_at_idx
  ON app.write_journal (committed_at);
