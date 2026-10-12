import { graphql, GraphQLError } from "graphql";
import { Pool } from "pg";
import { Loaders } from "../src/data/loaders";
import { compileQuery, QueryRunner } from "../src/data/queries";
import { Entity, EntityRepository, sqlFor } from "../src/data/repository";
import { ERROR_CODES, EntityService, EntityWriter } from "../src/data/service";
import { diffModels, emptySnapshot, snapshotOf } from "../src/models/ddl";
import { ModelError, parseModel, resolveModels } from "../src/models/load";
import { ModelDef } from "../src/models/types";
import { buildSchema, GraphQLContext } from "../src/schema";

/** Customer 1 - n Order, as in docs/models.md. */
const customerYaml = {
  name: "Customer",
  fields: { name: { type: "string", required: true } },
  relations: { orders: { hasMany: "Order", foreignKey: "customer" } },
};
const orderYaml = {
  name: "Order",
  fields: {
    title: { type: "string", required: true },
    status: { type: "enum", values: ["draft", "shipped"], required: true, default: "draft" },
    code: { type: "string", unique: true },
  },
  relations: { customer: { belongsTo: "Customer", required: true, onDelete: "cascade" } },
  bulkWrite: { update: true, delete: true, maxRows: 2 },
  list: { filterable: { status: ["eq"], customerId: ["eq"] }, sortable: ["title"] },
  queries: {
    ordersPerStatus: {
      sql: "SELECT status, count(*) AS order_count FROM app.orders WHERE created_at >= :since::timestamptz GROUP BY status",
      params: { since: { type: "datetime", required: true } },
      returns: { status: { type: "string" }, orderCount: { type: "int" } },
    },
  },
};

const models = (): ModelDef[] =>
  resolveModels([
    parseModel(customerYaml, "models/customer.yaml"),
    parseModel(orderYaml, "models/order.yaml"),
  ]);

describe("definitions", () => {
  test("belongsTo adds the foreign key field and its index", () => {
    const order = models()[1];
    expect(order.fields.find((f) => f.name === "customerId")).toMatchObject({
      column: "customer_id",
      type: "uuid",
      required: true,
      references: { model: "Customer", table: "customers", onDelete: "cascade" },
    });
    expect(order.indexes).toContainEqual({ name: "orders_customer_id_idx", fields: ["customerId"], unique: false });
    expect(order.bulkWrite).toEqual({ update: true, delete: true, maxRows: 2 });
    expect(order.queries[0]).toMatchObject({ name: "ordersPerStatus", list: true, timeoutMs: 5000 });
  });

  test.each([
    [{ ...orderYaml, relations: { customer: { belongsTo: "Customer", hasMany: "Customer" } } }, "exactly one"],
    [{ ...orderYaml, relations: { customer: { belongsTo: "Customer", required: true, onDelete: "setNull" } } }, "setNull"],
    [{ ...orderYaml, relations: { title: { belongsTo: "Customer" } } }, "already a field"],
    [{ ...orderYaml, list: {} }, "needs list.filterable"],
    [{ ...orderYaml, queries: { q: { sql: "SELECT :x", returns: { a: { type: "int" } } } } }, ":x is not declared"],
    [
      { ...orderYaml, queries: { q: { sql: "SELECT 1", params: { x: { type: "int" } }, returns: { a: { type: "int" } } } } },
      "not used",
    ],
    [{ ...orderYaml, queries: { q: { sql: "SELECT 1", returns: {}, timeoutMs: 1 } } }, "at least one column"],
  ])("rejects %#", (raw, message) => {
    expect(() => parseModel(raw, "models/order.yaml")).toThrow(message);
  });

  test("relations must point to existing models and matching inverses", () => {
    expect(() => resolveModels([parseModel(orderYaml, "models/order.yaml")])).toThrow('unknown model "Customer"');
    const wrongInverse = { ...customerYaml, relations: { orders: { hasMany: "Order", foreignKey: "buyer" } } };
    expect(() =>
      resolveModels([parseModel(wrongInverse, "models/customer.yaml"), parseModel(orderYaml, "models/order.yaml")]),
    ).toThrow(ModelError);
  });
});

describe("DDL", () => {
  test("foreign keys come after all tables", () => {
    const { statements } = diffModels(emptySnapshot(), models());
    expect(statements[statements.length - 1]).toBe(
      'ALTER TABLE app."orders"\n' +
        '  ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id")\n' +
        '  REFERENCES app."customers" ("id") ON DELETE CASCADE;',
    );
    expect(statements.findIndex((s) => s.includes('CREATE TABLE IF NOT EXISTS app."orders"'))).toBeLessThan(
      statements.length - 1,
    );
  });

  test("a relation added to an existing table adds column, index and key", () => {
    const [customer] = models();
    const plainOrder = resolveModels([
      customer,
      parseModel({ ...orderYaml, relations: undefined, list: { filterable: { status: ["eq"] } } }, "models/order.yaml"),
    ].map((m) => ({ ...m, relations: m.name === "Customer" ? [] : m.relations })));
    const optional = {
      ...orderYaml,
      relations: { customer: { belongsTo: "Customer" } },
    };
    const changes = diffModels(snapshotOf(plainOrder), resolveModels([parseModel(customerYaml, "c"), parseModel(optional, "o")]));
    expect(changes.summary).toEqual([
      "add column orders.customer_id",
      "create index orders_customer_id_idx",
    ]);
    expect(changes.statements[changes.statements.length - 1]).toContain("ON DELETE RESTRICT");
  });
});

describe("SQL", () => {
  const sql = sqlFor(models()[1]);

  test("children of many parents with per-parent paging", () => {
    const q = sql.listByParents("customerId", ["a", "b"], {
      where: { status: { eq: "draft" } },
      orderBy: [{ field: "title", direction: "asc" }],
      limit: 3,
      offset: 1,
    });
    expect(q.text).toContain('row_number() OVER (PARTITION BY "customer_id" ORDER BY "title" ASC, "id" ASC)');
    expect(q.text).toContain('WHERE "customer_id" = ANY($1) AND "status" = $2) AS t WHERE "_row" > $3 AND "_row" <= $4');
    expect(q.values).toEqual([["a", "b"], "draft", 1, 4]);
  });

  test("bulk writes are limited", () => {
    expect(sql.updateWhere({ status: { eq: "draft" } }, { title: "x" }, 3)).toEqual({
      text:
        'UPDATE app."orders" SET "title" = $1, "version" = "version" + 1, "updated_at" = now() ' +
        'WHERE "id" IN (SELECT "id" FROM app."orders" WHERE "status" = $2 LIMIT $3)',
      values: ["x", "draft", 3],
    });
    expect(sql.deleteWhere({ status: { eq: "draft" } }, 3).text).toBe(
      'DELETE FROM app."orders" WHERE "id" IN (SELECT "id" FROM app."orders" WHERE "status" = $1 LIMIT $2)',
    );
  });
});

const code = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof GraphQLError) return error.extensions.code;
    throw error;
  }
  throw new Error("expected an error");
};

describe("bulk writes and constraints", () => {
  const service = (repository: Partial<EntityRepository>) => {
    const write: EntityWriter = (_meta, fn) => fn(repository as EntityRepository);
    return new EntityService(models()[1], repository as EntityRepository, write, "aws");
  };

  test("a bulk write needs a condition and a change", async () => {
    const s = service({});
    expect(() => s.updateMany({ status: { eq: null } }, { title: "x" })).toThrow("at least one condition");
    expect(() => s.updateMany({ status: { eq: "draft" } }, {})).toThrow("at least one field");
  });

  test("more rows than maxRows: nothing is written", async () => {
    const s = service({ updateWhere: async () => 3, deleteWhere: async () => 2 });
    await expect(code(() => s.updateMany({ status: { eq: "draft" } }, { title: "x" }))).resolves.toBe(
      ERROR_CODES.tooManyRows,
    );
    await expect(s.deleteMany({ status: { eq: "draft" } })).resolves.toEqual({ count: 2 });
  });

  test("constraint violations become client errors", async () => {
    const pgError = (code: string, constraint: string) => Object.assign(new Error("pg"), { code, constraint });
    const s = service({
      insert: async () => Promise.reject(pgError("23503", "orders_customer_id_fkey")),
      delete: async () => Promise.reject(pgError("23505", "orders_code_key")),
    });
    await expect(code(() => s.create({ title: "a", customerId: "6f1c2b4e-8a9d-4c3b-9e7f-1a2b3c4d5e6f" }))).resolves.toBe(
      ERROR_CODES.constraintViolation,
    );
    await expect(s.create({ title: "a", customerId: "6f1c2b4e-8a9d-4c3b-9e7f-1a2b3c4d5e6f" })).rejects.toThrow(
      "customerId refers to a Customer that does not exist",
    );
    await expect(s.delete("6f1c2b4e-8a9d-4c3b-9e7f-1a2b3c4d5e6f", 1)).rejects.toThrow("same code");
  });
});

describe("named queries", () => {
  const q = models()[1].queries[0];

  test("placeholders become parameters; :: casts stay", () => {
    expect(compileQuery({ ...q, sql: "SELECT :a, :b::int, :a" })).toEqual({
      text: "SELECT $1, $2::int, $1",
      names: ["a", "b"],
    });
  });

  test("run read-only with a timeout and convert the results", async () => {
    const queries: string[] = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push(values ? `${text} ${JSON.stringify(values)}` : text);
        return { rows: text.startsWith("SELECT") ? [{ status: "draft", order_count: "12" }] : [] };
      },
      release: () => undefined,
    };
    const runner = new QueryRunner({ connect: async () => client } as unknown as Pool);
    await expect(runner.run(q, { since: "2026-01-01T00:00:00Z" })).resolves.toEqual([
      { status: "draft", orderCount: 12 },
    ]);
    expect(queries[0]).toBe("BEGIN READ ONLY; SET LOCAL statement_timeout = 5000");
    expect(queries[1]).toContain('>= $1::timestamptz GROUP BY status ["2026-01-01T00:00:00.000Z"]');
    expect(queries[2]).toBe("COMMIT");
  });

  test("a timeout becomes QUERY_TIMEOUT", async () => {
    const client = {
      query: async (text: string) => {
        if (text.startsWith("SELECT")) throw Object.assign(new Error("canceling"), { code: "57014" });
        return { rows: [] };
      },
      release: () => undefined,
    };
    const runner = new QueryRunner({ connect: async () => client } as unknown as Pool);
    await expect(code(() => runner.run(q, { since: "2026-01-01T00:00:00Z" }))).resolves.toBe("QUERY_TIMEOUT");
  });
});

describe("schema with relations", () => {
  const customer = (id: string): Entity => ({
    id,
    name: `c${id}`,
    ownerCloud: "aws",
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const order = (id: string, customerId: string): Entity => ({
    ...customer(id),
    title: `o${id}`,
    status: "draft",
    customerId,
  });

  test("relations are batched per request", async () => {
    const calls: string[] = [];
    const customers = {
      list: async () => [customer("c1"), customer("c2")],
      getMany: async (ids: string[]) => {
        calls.push(`getMany ${ids.join(",")}`);
        return new Map(ids.map((id) => [id, customer(id)]));
      },
    } as unknown as EntityService;
    const orders = {
      list: async () => [order("o1", "c1"), order("o2", "c2"), order("o3", "c1")],
      listByParents: async (_f: string, ids: string[]) => {
        calls.push(`listByParents ${ids.join(",")}`);
        return new Map(ids.map((id) => [id, [order(`x${id}`, id)]]));
      },
      updateMany: async () => ({ count: 1 }),
    } as unknown as EntityService;
    const services = new Map([
      ["Customer", customers],
      ["Order", orders],
    ]);
    const context: GraphQLContext = {
      services,
      queries: { run: async () => [{ status: "draft", orderCount: 1 }] } as unknown as QueryRunner,
      loaders: new Loaders(services),
      cloudId: "aws",
    };
    const schema = buildSchema(models());
    const result = await graphql({
      schema,
      contextValue: context,
      source: `{ orders { title customer { name } }
                 customers { name orders(limit: 5) { title } }
                 ordersPerStatus(since: "2026-01-01T00:00:00Z") { status orderCount } }`,
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.orders).toEqual([
      { title: "oo1", customer: { name: "cc1" } },
      { title: "oo2", customer: { name: "cc2" } },
      { title: "oo3", customer: { name: "cc1" } },
    ]);
    expect(calls.sort()).toEqual(["getMany c1,c2", "listByParents c1,c2"]);

    const bulk = await graphql({
      schema,
      contextValue: { ...context, loaders: new Loaders(services) },
      source: `mutation { updateOrders(where: {status: {eq: draft}}, input: {title: "x"}) { count } }`,
    });
    expect(bulk.data).toEqual({ updateOrders: { count: 1 } });
  });
});
