import { GraphQLError } from "graphql";
import { WriteMeta } from "../src/cluster";
import { Entity, EntityRepository, ListQuery, sqlFor, Values } from "../src/data/repository";
import { ERROR_CODES, EntityService, EntityWriter } from "../src/data/service";
import { parseModel } from "../src/models/load";

const ID = "6f1c2b4e-8a9d-4c3b-9e7f-1a2b3c4d5e6f";

const model = parseModel(
  {
    name: "Order",
    fields: {
      title: { type: "string", required: true, maxLength: 5 },
      status: { type: "enum", values: ["draft", "ordered"], default: "draft", required: true },
      amount: { type: "decimal", min: 0 },
      dueOn: { type: "date" },
      paidAt: { type: "datetime" },
      memo: { type: "string" },
      meta: { type: "json" },
    },
    list: {
      maxLimit: 20,
      filterable: { status: ["eq", "in"], memo: ["ilike", "isNull"], paidAt: ["gte"] },
      sortable: ["amount"],
    },
  },
  "models/order.yaml",
);

const entity = (extra: Partial<Entity> = {}): Entity => ({
  id: ID,
  title: "a",
  status: "draft",
  ownerCloud: "aws",
  version: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...extra,
});

describe("sqlFor", () => {
  const sql = sqlFor(model);

  test("list with conditions, order and paging", () => {
    expect(
      sql.list({
        where: { status: { in: ["draft"] }, memo: { ilike: "%x%", isNull: false }, paidAt: { gte: new Date(0) } },
        orderBy: [{ field: "amount", direction: "desc" }],
        limit: 10,
        offset: 20,
      }),
    ).toEqual({
      text:
        'SELECT "id", "title", "status", "amount", "due_on", "paid_at", "memo", "meta", "owner_cloud", "version", "created_at", "updated_at" ' +
        'FROM app."orders" WHERE "status" = ANY($1) AND "memo" ILIKE $2 AND "memo" IS NOT NULL AND "paid_at" >= $3 ' +
        'ORDER BY "amount" DESC, "id" ASC LIMIT $4 OFFSET $5',
      values: [["draft"], "%x%", new Date(0), 10, 20],
    });
  });

  test("insert sends JSON as text", () => {
    const q = sql.insert({ title: "a", meta: [1, 2] }, "aws");
    expect(q.text).toMatch(/^INSERT INTO app\."orders" \("title", "meta", "owner_cloud"\) VALUES \(\$1, \$2, \$3\) RETURNING /);
    expect(q.values).toEqual(["a", "[1,2]", "aws"]);
  });

  test("update sets the given fields and the version", () => {
    const q = sql.update(ID, 3, { memo: null });
    expect(q.text).toMatch(
      /^UPDATE app\."orders" SET "memo" = \$3, "version" = "version" \+ 1, "updated_at" = now\(\) WHERE "id" = \$1 AND "version" = \$2 RETURNING /,
    );
    expect(q.values).toEqual([ID, 3, null]);
  });

  test("rows become entities", () => {
    expect(sql.toEntity({ id: ID, due_on: "2026-01-02", owner_cloud: "aws" })).toMatchObject({
      id: ID,
      dueOn: "2026-01-02",
      ownerCloud: "aws",
    });
  });
});

/** Repository that records calls; rows are not filtered. */
const fakeRepository = (rows: Entity[] = []) => {
  const calls: { method: string; args: unknown[] }[] = [];
  const store = new Map(rows.map((r) => [r.id, r]));
  const repository: EntityRepository = {
    findById: async (id) => store.get(id) ?? null,
    list: async (q: ListQuery) => {
      calls.push({ method: "list", args: [q] });
      return [...store.values()];
    },
    insert: async (values: Values, ownerCloud) => {
      calls.push({ method: "insert", args: [values, ownerCloud] });
      return entity({ ...values, ownerCloud });
    },
    update: async (id, version, changes) => {
      calls.push({ method: "update", args: [id, version, changes] });
      const row = store.get(id);
      return row && row.version === version ? { ...row, ...changes, version: version + 1 } : null;
    },
    delete: async (id, version) => store.get(id)?.version === version,
    findByIds: async (ids) => ids.flatMap((id) => store.get(id) ?? []),
    listByParents: async (field, parentIds, q) => {
      calls.push({ method: "listByParents", args: [field, parentIds, q] });
      return [...store.values()].filter((r) => parentIds.includes(r[field] as string));
    },
    updateWhere: async (where, changes, limit) => {
      calls.push({ method: "updateWhere", args: [where, changes, limit] });
      return Math.min(store.size, limit);
    },
    deleteWhere: async (where, limit) => {
      calls.push({ method: "deleteWhere", args: [where, limit] });
      return Math.min(store.size, limit);
    },
  };
  return { repository, calls };
};

const serviceWith = (rows: Entity[] = []) => {
  const { repository, calls } = fakeRepository(rows);
  const metas: WriteMeta<unknown>[] = [];
  const write: EntityWriter = (meta, fn) => {
    metas.push(meta as WriteMeta<unknown>);
    return fn(repository);
  };
  return { service: new EntityService(model, repository, write, "google"), calls, metas };
};

const errorCode = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof GraphQLError) return error.extensions.code;
    throw error;
  }
  throw new Error("expected an error");
};

describe("EntityService", () => {
  test("create converts values and records the operation", async () => {
    const { service, calls, metas } = serviceWith();
    await service.create(
      { title: "abc", status: null, amount: "1.50", paidAt: "2026-01-02T03:04:05Z", memo: null },
      "key",
    );
    expect(calls[0].args).toEqual([
      { title: "abc", amount: "1.50", paidAt: new Date("2026-01-02T03:04:05Z") },
      "google",
    ]);
    expect(metas[0]).toMatchObject({ operation: "createOrder", idempotencyKey: "key" });
  });

  test("update: null clears optional fields and leaves required ones", async () => {
    const { service, calls } = serviceWith([entity()]);
    await service.update(ID, 1, { title: null, memo: null });
    expect(calls[0].args).toEqual([ID, 1, { memo: null }]);
  });

  test.each([
    [{ title: "  " }, "must not be empty"],
    [{ title: "abcdef" }, "at most 5 characters"],
    [{ title: "a", amount: "-1" }, "at least 0"],
    [{ title: "a", amount: "1e3" }, "decimal number"],
    [{ title: "a", dueOn: "2026-1-2" }, "YYYY-MM-DD"],
    [{ title: "a", paidAt: "yesterday" }, "ISO 8601"],
  ])("rejects input %#", async (input, message) => {
    const { service, calls } = serviceWith();
    await expect(errorCode(async () => service.create(input))).resolves.toBe(ERROR_CODES.badInput);
    expect(() => service.create(input)).toThrow(message);
    expect(calls).toEqual([]);
  });

  test("list converts conditions and applies the default order", async () => {
    const { service, calls } = serviceWith();
    await service.list({
      where: { paidAt: { gte: "2026-01-01T00:00:00Z" }, memo: { isNull: true, ilike: null } },
      limit: 20,
      offset: 0,
    });
    expect(calls[0].args[0]).toEqual({
      where: { paidAt: { gte: new Date("2026-01-01T00:00:00Z") }, memo: { isNull: true } },
      orderBy: [{ field: "createdAt", direction: "asc" }],
      limit: 20,
      offset: 0,
    });
    await service.list({ orderBy: [{ field: "amount", direction: "DESC" }], limit: 1, offset: 0 });
    expect((calls[1].args[0] as ListQuery).orderBy).toEqual([{ field: "amount", direction: "desc" }]);
  });

  test("list limits", async () => {
    const { service } = serviceWith();
    await expect(errorCode(async () => service.list({ limit: 21, offset: 0 }))).resolves.toBe(ERROR_CODES.badInput);
    expect(() => service.list({ limit: 21, offset: 0 })).toThrow("between 1 and 20");
  });

  test("stale version and missing rows", async () => {
    const { service } = serviceWith([entity({ version: 2 })]);
    await expect(errorCode(() => service.update(ID, 1, {}))).resolves.toBe(ERROR_CODES.versionConflict);
    await expect(errorCode(() => service.delete("00000000-0000-4000-8000-000000000000", 1))).resolves.toBe(
      ERROR_CODES.notFound,
    );
  });

  test("stored results are revived", async () => {
    const { service, metas } = serviceWith();
    await service.create({ title: "a" });
    const stored = JSON.parse(JSON.stringify(entity({ paidAt: new Date(5) })));
    expect(metas[0].revive(stored)).toEqual(entity({ paidAt: new Date(5) }));
  });

  test("idempotency keys are checked", () => {
    const { service } = serviceWith();
    expect(() => service.create({ title: "a" }, " ")).toThrow("idempotencyKey");
    expect(() => service.create({ title: "a" }, "k".repeat(201))).toThrow("idempotencyKey");
  });
});
