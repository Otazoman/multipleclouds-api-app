import { loadModels, ModelError, parseModel, pluralize, snakeCase } from "../src/models/load";

const parse = (raw: unknown) => parseModel(raw, "models/test.yaml");

const order = {
  name: "Order",
  fields: {
    title: { type: "string", required: true, maxLength: 200 },
    status: { type: "enum", values: ["draft", "ordered"], default: "draft", required: true },
    amount: { type: "decimal", min: 0 },
    memo: { type: "string" },
  },
};

describe("naming", () => {
  test("plural and column names", () => {
    expect(pluralize("Item")).toBe("items");
    expect(pluralize("Category")).toBe("categories");
    expect(pluralize("Box")).toBe("boxes");
    expect(pluralize("OrderLine")).toBe("orderLines");
    expect(snakeCase("orderLines")).toBe("order_lines");
  });
});

describe("parseModel", () => {
  test("applies defaults and adds the system fields", () => {
    const m = parse(order);
    expect(m).toMatchObject({ name: "Order", plural: "orders", table: "orders" });
    expect(m.fields.map((f) => f.name)).toEqual([
      "id",
      "title",
      "status",
      "amount",
      "memo",
      "ownerCloud",
      "version",
      "createdAt",
      "updatedAt",
    ]);
    expect(m.fields.find((f) => f.name === "title")).toMatchObject({
      column: "title",
      required: true,
      maxLength: 200,
      system: false,
    });
    expect(m.list).toEqual({
      defaultLimit: 50,
      maxLimit: 100,
      filterable: {},
      sortable: [],
      defaultOrder: [{ field: "createdAt", direction: "asc" }],
    });
  });

  test("reads list settings and indexes", () => {
    const m = parse({
      ...order,
      plural: "orderList",
      indexes: [{ fields: ["status", "createdAt"] }, { fields: ["title"], unique: true }],
      list: {
        defaultLimit: 20,
        maxLimit: 40,
        filterable: { status: ["eq", "in"], memo: ["ilike", "isNull"] },
        sortable: ["amount"],
        defaultOrder: [{ field: "amount", direction: "desc" }],
      },
    });
    expect(m.table).toBe("order_list");
    expect(m.indexes).toEqual([
      { name: "order_list_status_created_at_idx", fields: ["status", "createdAt"], unique: false },
      { name: "order_list_title_key", fields: ["title"], unique: true },
    ]);
    expect(m.list.filterable).toEqual({ status: ["eq", "in"], memo: ["ilike", "isNull"] });
    expect(m.list.defaultOrder).toEqual([{ field: "amount", direction: "desc" }]);
  });

  test.each([
    [{ ...order, name: "order" }, "name"],
    [{ ...order, extra: 1 }, 'unknown key "extra"'],
    [{ ...order, fields: {} }, "at least one field"],
    [{ ...order, fields: { id: { type: "uuid" } } }, "added to every model"],
    [{ ...order, fields: { x: { type: "text" } } }, "fields.x.type"],
    [{ ...order, fields: { x: { type: "int", maxLength: 3 } } }, "only for type string"],
    [{ ...order, fields: { x: { type: "enum", values: [] } } }, "must not be empty"],
    [{ ...order, fields: { x: { type: "enum", values: ["a-b"] } } }, "values[0]"],
    [{ ...order, fields: { x: { type: "int", default: "1" } } }, "integer"],
    [{ ...order, fields: { x: { type: "int", min: 5, max: 1 } } }, "min must not exceed max"],
    [{ ...order, table: "write_journal" }, "reserved"],
    [{ ...order, list: { filterable: { title: ["isNull"] } } }, "not required"],
    [{ ...order, list: { filterable: { amount: ["like"] } } }, 'does not apply to type decimal'],
    [{ ...order, list: { filterable: { nope: ["eq"] } } }, 'unknown field "nope"'],
    [{ ...order, list: { sortable: ["nope"] } }, 'unknown field "nope"'],
    [{ ...order, list: { defaultLimit: 500 } }, "list.defaultLimit"],
    [{ ...order, indexes: [{ fields: ["nope"] }] }, 'unknown field "nope"'],
  ])("rejects %#", (raw, message) => {
    expect(() => parse(raw)).toThrow(ModelError);
    expect(() => parse(raw)).toThrow(message);
  });

  test("errors name the file and the path", () => {
    expect(() => parse({ ...order, fields: { x: { type: "int", max: "a" } } })).toThrow(
      "models/test.yaml: fields.x.max: must be an integer",
    );
  });
});

describe("loadModels", () => {
  test("reads the repository's models", () => {
    const models = loadModels();
    expect(models.map((m) => m.name)).toContain("Item");
  });
});
