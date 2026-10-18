import { readFileSync } from "node:fs";
import { diffModels, emptySnapshot, snapshotOf } from "../src/models/ddl";
import { loadModels, ModelError, parseModel } from "../src/models/load";
import { readSnapshot, SCHEMA_FILE, schemaText } from "../src/generate";

const model = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseModel({ name: "Order", fields, ...extra }, "models/order.yaml");

const base = {
  title: { type: "string", required: true, maxLength: 200 },
  status: { type: "enum", values: ["draft", "ordered"], default: "draft", required: true },
  amount: { type: "decimal", min: 0 },
  note: { type: "string", default: "it's" },
};

describe("diffModels", () => {
  test("creates a new table with checks, defaults and indexes", () => {
    const changes = diffModels(emptySnapshot(), [
      model(base, { indexes: [{ fields: ["status", "createdAt"] }] }),
    ]);
    expect(changes.summary).toEqual(["create table orders"]);
    expect(changes.statements).toEqual([
      'CREATE TABLE IF NOT EXISTS app."orders" (\n' +
        '  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),\n' +
        '  "title" text NOT NULL CHECK (char_length("title") <= 200),\n' +
        `  "status" text NOT NULL DEFAULT 'draft' CHECK ("status" IN ('draft', 'ordered')),\n` +
        '  "amount" numeric CHECK ("amount" >= 0),\n' +
        `  "note" text DEFAULT 'it''s',\n` +
        '  "owner_cloud" text NOT NULL,\n' +
        '  "version" integer NOT NULL DEFAULT 1,\n' +
        '  "created_at" timestamptz NOT NULL DEFAULT now(),\n' +
        '  "updated_at" timestamptz NOT NULL DEFAULT now()\n' +
        ");",
      'CREATE INDEX IF NOT EXISTS "orders_status_created_at_idx"\n' +
        '  ON app."orders" ("status", "created_at");',
    ]);
  });

  test("adds columns and indexes", () => {
    const before = snapshotOf([model(base)]);
    const changes = diffModels(before, [
      model(
        { ...base, memo: { type: "string" }, paidAt: { type: "datetime", required: true, default: "now" } },
        { indexes: [{ fields: ["memo"], unique: true }] },
      ),
    ]);
    expect(changes.summary).toEqual([
      "add column orders.memo",
      "add column orders.paid_at",
      "create index orders_memo_key",
    ]);
    expect(changes.statements[1]).toBe(
      'ALTER TABLE app."orders"\n  ADD COLUMN IF NOT EXISTS "paid_at" timestamptz NOT NULL DEFAULT now();',
    );
  });

  test("replaces a changed index", () => {
    const before = snapshotOf([model(base, { indexes: [{ name: "orders_x", fields: ["title"] }] })]);
    const changes = diffModels(before, [
      model(base, { indexes: [{ name: "orders_x", fields: ["title", "status"] }] }),
    ]);
    expect(changes.summary).toEqual(["drop index orders_x", "create index orders_x"]);
  });

  test("no changes, no statements", () => {
    const models = [model(base)];
    expect(diffModels(snapshotOf(models), models).statements).toEqual([]);
  });

  test.each([
    ["removing a table", [], "table orders was removed"],
    ["removing a column", [model({ title: base.title, status: base.status, note: base.note })], "orders.amount was removed"],
    ["changing a column", [model({ ...base, amount: { type: "decimal", min: 1 } })], "orders.amount was changed"],
    [
      "adding a required column without default",
      [model({ ...base, code: { type: "string", required: true } })],
      "needs a default",
    ],
  ])("refuses %s", (_name, models, message) => {
    expect(() => diffModels(snapshotOf([model(base)]), models)).toThrow(ModelError);
    expect(() => diffModels(snapshotOf([model(base)]), models)).toThrow(message);
  });
});

describe("repository models", () => {
  test("have their migrations (npm run generate)", () => {
    expect(diffModels(readSnapshot(), loadModels()).summary).toEqual([]);
  });

  test("generated/schema.graphql is up to date (npm run generate)", () => {
    expect(readFileSync(SCHEMA_FILE, "utf8")).toBe(schemaText(loadModels()));
  });
});
