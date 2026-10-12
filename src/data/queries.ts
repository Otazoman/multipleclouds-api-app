import { GraphQLError } from "graphql";
import { Pool, PoolClient } from "pg";
import { QUERY_PARAM, snakeCase } from "../models/load";
import { FieldDef, QueryDef, QueryValueDef } from "../models/types";
import { convertValue } from "./service";

/**
 * Named queries (`queries` in models/*.yaml): read-only SQL exposed as
 * GraphQL queries. They run on this cloud's database in a READ ONLY
 * transaction with a statement timeout, with the parameters bound as $n.
 */

export const QUERY_ERROR_CODES = {
  /** The query ran longer than its timeoutMs. */
  timeout: "QUERY_TIMEOUT",
} as const;

const QUERY_CANCELED = "57014";

/** :name placeholders to $n (a name used twice gets the same number). */
export const compileQuery = (q: QueryDef): { text: string; names: string[] } => {
  const names: string[] = [];
  const text = q.sql.replace(QUERY_PARAM, (_match, name: string) => {
    let index = names.indexOf(name);
    if (index < 0) {
      names.push(name);
      index = names.length - 1;
    }
    return `$${index + 1}`;
  });
  return { text, names };
};

/** A parameter or result column as a field, to reuse the field checks. */
const asField = (v: QueryValueDef): FieldDef => ({
  name: v.name,
  column: v.name,
  type: v.type,
  required: false,
  unique: false,
  system: false,
});

/** Database value to API value for a result column. */
const resultValue = (v: QueryValueDef, value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  switch (v.type) {
    case "int":
    case "float":
      // count(*) and other bigint results arrive as strings.
      return Number(value);
    case "decimal":
      return String(value);
    case "datetime":
      return value instanceof Date ? value.toISOString() : value;
    default:
      return value;
  }
};

export class QueryRunner {
  constructor(private readonly pool: Pool) {}

  async run(q: QueryDef, args: Record<string, unknown>): Promise<unknown> {
    const { text, names } = compileQuery(q);
    const values = names.map((name) => {
      const param = q.params.find((p) => p.name === name) as QueryValueDef;
      const value = args[name];
      if (value === null || value === undefined) return null;
      const converted = convertValue(asField(param), value);
      return param.type === "json" ? JSON.stringify(converted) : converted;
    });

    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      // Integers only: one round trip for both.
      await client.query(`BEGIN READ ONLY; SET LOCAL statement_timeout = ${q.timeoutMs}`);
      const result = await client.query(text, values);
      await client.query("COMMIT");
      const rows = result.rows.map((row: Record<string, unknown>) =>
        Object.fromEntries(
          q.returns.map((r) => [r.name, resultValue(r, r.name in row ? row[r.name] : row[snakeCase(r.name)])]),
        ),
      );
      return q.list ? rows : (rows[0] ?? null);
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: unknown }).code === QUERY_CANCELED) {
        throw new GraphQLError(`${q.name} took longer than ${q.timeoutMs} ms`, {
          extensions: { code: QUERY_ERROR_CODES.timeout },
        });
      }
      if (!(error instanceof GraphQLError)) {
        console.error(`Query ${q.name} failed:`, (error as Error).message);
      }
      throw error;
    } finally {
      client?.release();
    }
  }
}
