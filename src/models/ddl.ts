import { FieldDef, FieldType, IndexDef, ModelDef, OnDelete } from "./types";
import { ModelError } from "./load";

/**
 * SQL for the model definitions. `npm run generate` compares the models
 * with the snapshot of the last generated migration
 * (migrations/models.snapshot.json) and writes a migration for the
 * difference. Only additive changes are generated; anything that could lose
 * data or break replication is refused and needs a hand-written migration.
 */

const SQL_TYPES: Record<FieldType, string> = {
  string: "text",
  int: "integer",
  float: "double precision",
  decimal: "numeric",
  boolean: "boolean",
  datetime: "timestamptz",
  date: "date",
  uuid: "uuid",
  enum: "text",
  json: "jsonb",
};

/** Always quoted, so that names that are SQL keywords work. */
export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

const quoteLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const tableName = (model: { table: string }): string => `app.${quoteIdent(model.table)}`;

/** Schema-relevant part of a user field (what the snapshot stores). */
export interface ColumnSnapshot {
  column: string;
  type: FieldType;
  required: boolean;
  default?: string | number | boolean;
  unique: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  values?: string[];
  /** Foreign key (belongsTo relation). */
  references?: { table: string; onDelete: OnDelete };
}

export interface IndexSnapshot {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface Snapshot {
  version: 1;
  tables: Record<string, { columns: ColumnSnapshot[]; indexes: IndexSnapshot[] }>;
}

export const emptySnapshot = (): Snapshot => ({ version: 1, tables: {} });

const columnSnapshot = (f: FieldDef): ColumnSnapshot => {
  const c: ColumnSnapshot = { column: f.column, type: f.type, required: f.required, unique: f.unique };
  if (f.default !== undefined) c.default = f.default;
  if (f.maxLength !== undefined) c.maxLength = f.maxLength;
  if (f.min !== undefined) c.min = f.min;
  if (f.max !== undefined) c.max = f.max;
  if (f.values !== undefined) c.values = f.values;
  if (f.references !== undefined) {
    c.references = { table: f.references.table, onDelete: f.references.onDelete };
  }
  return c;
};

const indexSnapshot = (model: ModelDef, index: IndexDef): IndexSnapshot => ({
  name: index.name,
  columns: index.fields.map((n) => model.fields.find((f) => f.name === n)?.column ?? n),
  unique: index.unique,
});

/** The snapshot that matches the given models. */
export const snapshotOf = (models: readonly ModelDef[]): Snapshot => ({
  version: 1,
  tables: Object.fromEntries(
    models.map((m) => [
      m.table,
      {
        columns: m.fields.filter((f) => !f.system).map(columnSnapshot),
        indexes: m.indexes.map((i) => indexSnapshot(m, i)),
      },
    ]),
  ),
});

const defaultSql = (c: ColumnSnapshot): string => {
  const value = c.default;
  if (value === undefined) return "";
  if (c.type === "datetime") return " DEFAULT now()";
  if (typeof value === "string") return ` DEFAULT ${quoteLiteral(value)}`;
  return ` DEFAULT ${String(value)}`;
};

const columnSql = (c: ColumnSnapshot): string => {
  const col = quoteIdent(c.column);
  const checks: string[] = [];
  if (c.maxLength !== undefined) checks.push(`char_length(${col}) <= ${c.maxLength}`);
  if (c.min !== undefined) checks.push(`${col} >= ${c.min}`);
  if (c.max !== undefined) checks.push(`${col} <= ${c.max}`);
  if (c.values !== undefined) checks.push(`${col} IN (${c.values.map(quoteLiteral).join(", ")})`);
  return (
    `${col} ${SQL_TYPES[c.type]}` +
    (c.required ? " NOT NULL" : "") +
    defaultSql(c) +
    (c.unique ? " UNIQUE" : "") +
    (checks.length > 0 ? ` CHECK (${checks.join(" AND ")})` : "")
  );
};

const indexSql = (table: string, ix: IndexSnapshot): string =>
  `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdent(ix.name)}\n` +
  `  ON ${tableName({ table })} (${ix.columns.map(quoteIdent).join(", ")});`;

const ON_DELETE_SQL: Record<OnDelete, string> = {
  restrict: "RESTRICT",
  cascade: "CASCADE",
  setNull: "SET NULL",
};

/**
 * Foreign keys are added after every table of the migration exists. On the
 * other nodes, logical replication applies changes without firing foreign
 * key checks, so the order in which rows arrive does not matter there.
 */
const foreignKeySql = (table: string, c: ColumnSnapshot): string[] =>
  c.references
    ? [
        `ALTER TABLE ${tableName({ table })}\n` +
          `  ADD CONSTRAINT ${quoteIdent(`${table}_${c.column}_fkey`)} FOREIGN KEY (${quoteIdent(c.column)})\n` +
          `  REFERENCES ${tableName({ table: c.references.table })} (${quoteIdent("id")}) ON DELETE ${ON_DELETE_SQL[c.references.onDelete]};`,
      ]
    : [];

const createTableSql = (table: string, def: Snapshot["tables"][string]): string[] => [
  `CREATE TABLE IF NOT EXISTS ${tableName({ table })} (\n` +
    [
      `${quoteIdent("id")} uuid PRIMARY KEY DEFAULT gen_random_uuid()`,
      ...def.columns.map(columnSql),
      `${quoteIdent("owner_cloud")} text NOT NULL`,
      `${quoteIdent("version")} integer NOT NULL DEFAULT 1`,
      `${quoteIdent("created_at")} timestamptz NOT NULL DEFAULT now()`,
      `${quoteIdent("updated_at")} timestamptz NOT NULL DEFAULT now()`,
    ]
      .map((line) => `  ${line}`)
      .join(",\n") +
    "\n);",
  ...def.indexes.map((ix) => indexSql(table, ix)),
];

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface Changes {
  /** SQL statements, in order. */
  statements: string[];
  /** One line per change, for the file name and the header. */
  summary: string[];
}

/**
 * The migration from `snapshot` to `models`. Throws ModelError for changes
 * that are not generated (removing or changing a table or column).
 */
export const diffModels = (snapshot: Snapshot, models: readonly ModelDef[]): Changes => {
  const target = snapshotOf(models);
  const statements: string[] = [];
  const foreignKeys: string[] = [];
  const summary: string[] = [];
  const handWritten = (what: string): never => {
    throw new ModelError(
      `${what}: not generated, because it can lose data or break replication. ` +
        "Write the migration by hand (docs/models.md, \"Changes that are not generated\") " +
        "and then run `npm run generate -- --baseline`.",
    );
  };

  for (const table of Object.keys(snapshot.tables)) {
    if (!target.tables[table]) handWritten(`table ${table} was removed`);
  }

  for (const [table, def] of Object.entries(target.tables)) {
    const before = snapshot.tables[table];
    if (!before) {
      statements.push(...createTableSql(table, def));
      foreignKeys.push(...def.columns.flatMap((col) => foreignKeySql(table, col)));
      summary.push(`create table ${table}`);
      continue;
    }
    for (const old of before.columns) {
      const now = def.columns.find((c) => c.column === old.column);
      if (!now) handWritten(`column ${table}.${old.column} was removed`);
      if (!same(old, now)) handWritten(`column ${table}.${old.column} was changed`);
    }
    for (const col of def.columns) {
      if (before.columns.some((c) => c.column === col.column)) continue;
      if (col.required && col.default === undefined) {
        throw new ModelError(
          `column ${table}.${col.column}: a required field added to an existing table needs a default`,
        );
      }
      statements.push(`ALTER TABLE ${tableName({ table })}\n  ADD COLUMN IF NOT EXISTS ${columnSql(col)};`);
      foreignKeys.push(...foreignKeySql(table, col));
      summary.push(`add column ${table}.${col.column}`);
    }
    for (const old of before.indexes) {
      const now = def.indexes.find((i) => i.name === old.name);
      if (!now || !same(old, now)) {
        statements.push(`DROP INDEX IF EXISTS app.${quoteIdent(old.name)};`);
        summary.push(`drop index ${old.name}`);
      }
    }
    for (const ix of def.indexes) {
      const old = before.indexes.find((i) => i.name === ix.name);
      if (!old || !same(old, ix)) {
        statements.push(indexSql(table, ix));
        summary.push(`create index ${ix.name}`);
      }
    }
  }
  return { statements: [...statements, ...foreignKeys], summary };
};
