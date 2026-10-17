import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

/** migrations/ next to dist/ (or src/), copied into the image. */
export const MIGRATIONS_DIR = resolve(__dirname, "..", "migrations");

/**
 * Versions of the migrations in `dir`, as scripts/migrate.sh records them in
 * ops.schema_migrations (file name without ".sql"), in order.
 */
export const migrationVersions = (dir: string = MIGRATIONS_DIR): string[] =>
  readdirSync(dir)
    .filter((file) => /^\d{4}_.*\.sql$/.test(file))
    .map((file) => file.slice(0, -".sql".length))
    .sort();

/**
 * Whether this node's database has every migration this version of the API
 * was built with (ops.missing_migrations, migrations/0004). Once it has, the
 * answer is kept: migrations are never removed from a node.
 */
export class MigrationCheck {
  private complete = false;

  constructor(
    private readonly pool: Pool,
    private readonly expected: readonly string[],
  ) {}

  /** The versions not applied yet ([] when all are). Throws when the database fails. */
  async missing(): Promise<string[]> {
    if (this.complete) {
      await this.pool.query("SELECT 1");
      return [];
    }
    const { rows } = await this.pool.query<{ missing: string[] }>(
      "SELECT ops.missing_migrations($1::text[]) AS missing",
      [this.expected],
    );
    const missing = rows[0].missing;
    this.complete = missing.length === 0;
    return missing;
  }
}
