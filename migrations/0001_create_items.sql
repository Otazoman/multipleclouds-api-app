-- Tables in schema "app" are replicated between the clouds
-- (scripts/replication-setup.sh publishes every table in this schema).
-- Logical replication does not replicate DDL: apply every migration to every
-- node with scripts/migrate.sh.

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  -- Cloud that created the row; only that cloud's API changes it.
  owner_cloud text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS items_created_at_idx ON app.items (created_at, id);
