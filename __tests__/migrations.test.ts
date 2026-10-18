import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { MigrationCheck, migrationVersions } from "../src/migrations";

/** Pool answering ops.missing_migrations with the next of `replies`. */
const fakePool = (replies: string[][]) => {
  const queries: { text: string; values?: unknown[] }[] = [];
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return text.startsWith("SELECT 1") ? { rows: [] } : { rows: [{ missing: replies.shift() }] };
    },
  } as unknown as Pool;
  return { pool, queries };
};

describe("migrationVersions", () => {
  test("lists the SQL migrations in order, as scripts/migrate.sh records them", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrations-"));
    for (const file of ["0002_b.sql", "0001_a.sql", "models.snapshot.json", "notes.sql"]) {
      writeFileSync(join(dir, file), "");
    }
    expect(migrationVersions(dir)).toEqual(["0001_a", "0002_b"]);
  });

  test("includes the repository's migrations", () => {
    expect(migrationVersions()).toEqual(expect.arrayContaining(["0001_create_items", "0004_migration_status"]));
  });
});

describe("MigrationCheck", () => {
  test("reports the missing migrations until all are applied, then only checks the connection", async () => {
    const { pool, queries } = fakePool([["0002_b"], []]);
    const check = new MigrationCheck(pool, ["0001_a", "0002_b"]);

    await expect(check.missing()).resolves.toEqual(["0002_b"]);
    expect(queries[0]).toEqual({
      text: "SELECT ops.missing_migrations($1::text[]) AS missing",
      values: [["0001_a", "0002_b"]],
    });
    await expect(check.missing()).resolves.toEqual([]);
    await expect(check.missing()).resolves.toEqual([]);
    expect(queries.map((q) => q.text)).toEqual([
      "SELECT ops.missing_migrations($1::text[]) AS missing",
      "SELECT ops.missing_migrations($1::text[]) AS missing",
      "SELECT 1",
    ]);
  });

  test("fails when the database fails (e.g. the function is missing)", async () => {
    const pool = {
      query: async () => {
        throw new Error("function ops.missing_migrations(text[]) does not exist");
      },
    } as unknown as Pool;
    await expect(new MigrationCheck(pool, ["0001_a"]).missing()).rejects.toThrow("does not exist");
  });
});
