import { Pool, PoolClient } from "pg";
import { quoteIdent } from "../models/ddl";
import { FieldDef, FilterOp, ModelDef, OrderDef } from "../models/types";

/** A row as the API sees it: field names, not column names. */
export type Entity = Record<string, unknown> & {
  id: string;
  version: number;
  ownerCloud: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Field name -> value, already validated and converted (src/data/service.ts). */
export type Values = Record<string, unknown>;

/** Field name -> operator -> value; the conditions are combined with AND. */
export type Where = Record<string, Partial<Record<FilterOp, unknown>>>;

export interface ListQuery {
  where: Where;
  orderBy: OrderDef[];
  limit: number;
  offset: number;
}

/**
 * Data access for one model's table in schema "app". Business rules live in
 * `EntityService`. Reads use this cloud's database; writes run in a
 * transaction on the primary (`PrimaryWriter`).
 */
export interface EntityRepository {
  findById(id: string): Promise<Entity | null>;
  findByIds(ids: readonly string[]): Promise<Entity[]>;
  list(query: ListQuery): Promise<Entity[]>;
  /**
   * The rows whose `field` (a foreign key) is one of `parentIds`; `query`
   * (order, limit, offset) applies to each parent separately.
   */
  listByParents(field: string, parentIds: readonly string[], query: ListQuery): Promise<Entity[]>;
  insert(values: Values, ownerCloud: string): Promise<Entity>;
  /** Updates the row only if the version matches; null otherwise. */
  update(id: string, version: number, changes: Values): Promise<Entity | null>;
  /** Deletes the row only if the version matches; false otherwise. */
  delete(id: string, version: number): Promise<boolean>;
  /**
   * Updates the rows matching `where`, at most `limit` of them; returns how
   * many were updated.
   */
  updateWhere(where: Where, changes: Values, limit: number): Promise<number>;
  /** Deletes the rows matching `where`, at most `limit`; returns the count. */
  deleteWhere(where: Where, limit: number): Promise<number>;
}

export interface Sql {
  text: string;
  values: unknown[];
}

const OPERATORS: Record<Exclude<FilterOp, "in" | "isNull">, string> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  like: "LIKE",
  ilike: "ILIKE",
};

/** SQL builders for one model; exported for tests. */
export const sqlFor = (model: ModelDef) => {
  const table = `app.${quoteIdent(model.table)}`;
  const byName = new Map(model.fields.map((f) => [f.name, f]));
  const field = (name: string): FieldDef => {
    const f = byName.get(name);
    if (!f) throw new Error(`Unknown field ${model.name}.${name}`);
    return f;
  };
  const col = (name: string): string => quoteIdent(field(name).column);
  const columns = model.fields.map((f) => quoteIdent(f.column)).join(", ");
  // node-pg would turn a JS array into a PostgreSQL array: send JSON as text.
  const param = (f: FieldDef, value: unknown): unknown =>
    f.type === "json" && value !== null && value !== undefined ? JSON.stringify(value) : value;

  const whereSql = (where: Where, values: unknown[]): string[] =>
    Object.entries(where).flatMap(([name, ops]) =>
      Object.entries(ops)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([op, value]) => {
          const c = col(name);
          if (op === "isNull") return value ? `${c} IS NULL` : `${c} IS NOT NULL`;
          values.push(op === "in" ? (value as unknown[]).map((v) => param(field(name), v)) : param(field(name), value));
          if (op === "in") return `${c} = ANY($${values.length})`;
          return `${c} ${OPERATORS[op as keyof typeof OPERATORS]} $${values.length}`;
        }),
    );

  const orderSql = (orderBy: readonly OrderDef[]): string => {
    const order = orderBy.some((o) => o.field === "id")
      ? orderBy
      : [...orderBy, { field: "id", direction: "asc" as const }];
    return order.map((o) => `${col(o.field)} ${o.direction === "desc" ? "DESC" : "ASC"}`).join(", ");
  };

  /** Rows matching `where`, at most `limit` (for bulk writes). */
  const matching = (where: Where, limit: number, values: unknown[]): string => {
    const conditions = whereSql(where, values);
    values.push(limit);
    return (
      `${col("id")} IN (SELECT ${col("id")} FROM ${table}` +
      (conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "") +
      ` LIMIT $${values.length})`
    );
  };

  return {
    findById: (id: string): Sql => ({
      text: `SELECT ${columns} FROM ${table} WHERE ${col("id")} = $1`,
      values: [id],
    }),
    findByIds: (ids: readonly string[]): Sql => ({
      text: `SELECT ${columns} FROM ${table} WHERE ${col("id")} = ANY($1)`,
      values: [ids],
    }),
    listByParents: (field: string, parentIds: readonly string[], q: ListQuery): Sql => {
      const values: unknown[] = [parentIds];
      const conditions = [`${col(field)} = ANY($1)`, ...whereSql(q.where, values)];
      values.push(q.offset, q.offset + q.limit);
      return {
        text:
          `SELECT ${columns} FROM (SELECT ${columns}, ` +
          `row_number() OVER (PARTITION BY ${col(field)} ORDER BY ${orderSql(q.orderBy)}) AS "_row" ` +
          `FROM ${table} WHERE ${conditions.join(" AND ")}) AS t ` +
          `WHERE "_row" > $${values.length - 1} AND "_row" <= $${values.length} ORDER BY ${col(field)}, "_row"`,
        values,
      };
    },
    list: (q: ListQuery): Sql => {
      const values: unknown[] = [];
      const conditions = whereSql(q.where, values);
      values.push(q.limit, q.offset);
      return {
        text:
          `SELECT ${columns} FROM ${table}` +
          (conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "") +
          ` ORDER BY ${orderSql(q.orderBy)} LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      };
    },
    insert: (values: Values, ownerCloud: string): Sql => {
      const names = Object.keys(values);
      const params = names.map((n) => param(field(n), values[n]));
      params.push(ownerCloud);
      return {
        text:
          `INSERT INTO ${table} (${[...names.map(col), col("ownerCloud")].join(", ")}) ` +
          `VALUES (${params.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${columns}`,
        values: params,
      };
    },
    update: (id: string, version: number, changes: Values): Sql => {
      const names = Object.keys(changes);
      const sets = names.map((n, i) => `${col(n)} = $${i + 3}`);
      sets.push(`${col("version")} = ${col("version")} + 1`, `${col("updatedAt")} = now()`);
      return {
        text:
          `UPDATE ${table} SET ${sets.join(", ")} ` +
          `WHERE ${col("id")} = $1 AND ${col("version")} = $2 RETURNING ${columns}`,
        values: [id, version, ...names.map((n) => param(field(n), changes[n]))],
      };
    },
    delete: (id: string, version: number): Sql => ({
      text: `DELETE FROM ${table} WHERE ${col("id")} = $1 AND ${col("version")} = $2`,
      values: [id, version],
    }),
    updateWhere: (where: Where, changes: Values, limit: number): Sql => {
      const names = Object.keys(changes);
      const values: unknown[] = names.map((n) => param(field(n), changes[n]));
      const sets = names.map((n, i) => `${col(n)} = $${i + 1}`);
      sets.push(`${col("version")} = ${col("version")} + 1`, `${col("updatedAt")} = now()`);
      return { text: `UPDATE ${table} SET ${sets.join(", ")} WHERE ${matching(where, limit, values)}`, values };
    },
    deleteWhere: (where: Where, limit: number): Sql => {
      const values: unknown[] = [];
      return { text: `DELETE FROM ${table} WHERE ${matching(where, limit, values)}`, values };
    },
    /** Column-named row to field-named entity. */
    toEntity: (row: Record<string, unknown>): Entity =>
      Object.fromEntries(model.fields.map((f) => [f.name, row[f.column]])) as Entity,
  };
};

export const createPgRepository = (
  model: ModelDef,
  db: Pool | PoolClient,
): EntityRepository => {
  const sql = sqlFor(model);
  const one = async (q: Sql): Promise<Entity | null> => {
    const result = await db.query(q.text, q.values);
    return result.rows[0] ? sql.toEntity(result.rows[0]) : null;
  };
  const many = async (q: Sql): Promise<Entity[]> =>
    (await db.query(q.text, q.values)).rows.map(sql.toEntity);
  const count = async (q: Sql): Promise<number> => (await db.query(q.text, q.values)).rowCount ?? 0;
  return {
    findById: (id) => one(sql.findById(id)),
    findByIds: (ids) => many(sql.findByIds(ids)),
    list: (query) => many(sql.list(query)),
    listByParents: (field, parentIds, query) => many(sql.listByParents(field, parentIds, query)),
    updateWhere: (where, changes, limit) => count(sql.updateWhere(where, changes, limit)),
    deleteWhere: (where, limit) => count(sql.deleteWhere(where, limit)),
    async insert(values, ownerCloud) {
      return (await one(sql.insert(values, ownerCloud))) as Entity;
    },
    update: (id, version, changes) => one(sql.update(id, version, changes)),
    async delete(id, version) {
      const q = sql.delete(id, version);
      return (await db.query(q.text, q.values)).rowCount === 1;
    },
  };
};
