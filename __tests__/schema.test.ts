import { graphql } from "graphql";
import { Loaders } from "../src/data/loaders";
import { QueryRunner } from "../src/data/queries";
import { EntityService } from "../src/data/service";
import { ModelError, parseModel } from "../src/models/load";
import { buildSchema, GraphQLContext } from "../src/schema";

const model = parseModel(
  {
    name: "Order",
    fields: {
      title: { type: "string", required: true },
      status: { type: "enum", values: ["draft", "ordered"], default: "draft", required: true },
      meta: { type: "json" },
      paidAt: { type: "datetime" },
    },
    list: { filterable: { status: ["in"] }, sortable: ["title"] },
  },
  "models/order.yaml",
);

const row = {
  id: "6f1c2b4e-8a9d-4c3b-9e7f-1a2b3c4d5e6f",
  title: "a",
  status: "ordered",
  meta: { tags: ["x"] },
  paidAt: new Date("2026-01-02T03:04:05Z"),
  ownerCloud: "aws",
  version: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const run = async (source: string) => {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    };
  const service = {
    get: record("get", row),
    list: record("list", [row]),
    create: record("create", row),
    update: record("update", row),
    delete: record("delete", true),
  } as unknown as EntityService;
  const services = new Map([["Order", service]]);
  const context: GraphQLContext = {
    services,
    queries: {} as QueryRunner,
    loaders: new Loaders(services),
    cloudId: "azure",
  };
  const result = await graphql({ schema: buildSchema([model]), source, contextValue: context });
  return { result, calls };
};

describe("generated schema", () => {
  test("list query passes where, orderBy and paging; values are serialized", async () => {
    const { result, calls } = await run(
      `{ cloud orders(where: {status: {in: [ordered]}}, orderBy: [{field: title, direction: DESC}], limit: 5) {
           id status meta paidAt createdAt } }`,
    );
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      cloud: "azure",
      orders: [
        {
          id: row.id,
          status: "ordered",
          meta: { tags: ["x"] },
          paidAt: "2026-01-02T03:04:05.000Z",
          createdAt: "1970-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(calls[0].args[0]).toMatchObject({
      where: { status: { in: ["ordered"] } },
      orderBy: [{ field: "title", direction: "DESC" }],
      limit: 5,
      offset: 0,
    });
  });

  test("mutations pass input and idempotency key", async () => {
    const { result, calls } = await run(
      `mutation { createOrder(input: {title: "a", meta: {a: [1, true, null]}}, idempotencyKey: "k") { id }
                  deleteOrder(id: "${row.id}", version: 1) }`,
    );
    expect(result.errors).toBeUndefined();
    expect(calls[0]).toEqual({
      method: "create",
      args: [{ title: "a", meta: { a: [1, true, null] } }, "k"],
    });
    expect(calls[1]).toEqual({ method: "delete", args: [row.id, 1, undefined] });
  });

  test("required fields with a default are optional on create", async () => {
    const { result } = await run(`mutation { createOrder(input: {}) { id } }`);
    expect(result.errors?.[0].message).toMatch(/title/);
  });

  test("names that collide are rejected", () => {
    const clash = parseModel({ name: "Cloud", fields: { x: { type: "int" } } }, "models/cloud.yaml");
    expect(() => buildSchema([clash])).toThrow(ModelError);
  });
});
