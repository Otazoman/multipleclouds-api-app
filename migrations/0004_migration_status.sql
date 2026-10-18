-- Readiness of a new API version (src/migrations.ts): /readyz stays 503
-- until every migration the image contains has been applied to this node, so
-- that the platforms do not move traffic to an API whose tables or columns
-- are missing. ops.schema_migrations is maintained by scripts/migrate.sh.
--
-- SECURITY DEFINER, like the write-routing functions: the API role only
-- needs EXECUTE (scripts/api-role-setup.sh), not access to the table.

-- The versions in `expected` not applied on this node, in order.
CREATE OR REPLACE FUNCTION ops.missing_migrations(expected text[])
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT coalesce(array_agg(v.version ORDER BY v.version), '{}')
    FROM unnest(expected) AS v(version)
   WHERE NOT EXISTS (
     SELECT 1 FROM ops.schema_migrations m WHERE m.version = v.version
   );
$$;

REVOKE ALL ON FUNCTION ops.missing_migrations(text[]) FROM PUBLIC;
