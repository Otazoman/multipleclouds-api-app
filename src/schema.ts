import { GraphQLScalarType, GraphQLSchema, Kind, ValueNode } from "graphql";
import { createSchema } from "graphql-yoga";
import { Loaders } from "./data/loaders";
import { QueryRunner } from "./data/queries";
import { Entity } from "./data/repository";
import { EntityService, ListArgs } from "./data/service";
import { ModelError } from "./models/load";
import { FieldDef, FilterOp, ModelDef, QueryDef, QueryValueDef } from "./models/types";

/**
 * The GraphQL schema, generated from the model definitions (models/*.yaml).
 * For each model, e.g. Item:
 *   type Item, input CreateItemInput / UpdateItemInput,
 *   input ItemWhere (filterable fields), enum ItemSortField (sortable fields),
 *   Query.item(id), Query.items(where, orderBy, limit, offset),
 *   Mutation.createItem / updateItem / deleteItem,
 *   and, when defined: relation fields, Mutation.updateItems / deleteItems
 *   (bulkWrite), one query per named query (`queries`).
 * generated/schema.graphql is a printout of it (`npm run generate`).
 */

export interface GraphQLContext {
  /** Service per model name. */
  services: ReadonlyMap<string, EntityService>;
  /** Named queries (this cloud's database). */
  queries: QueryRunner;
  /** Relation batching; one per request. */
  loaders: Loaders;
  cloudId: string;
}

const lowerFirst = (s: string): string => s[0].toLowerCase() + s.slice(1);
const upperFirst = (s: string): string => s[0].toUpperCase() + s.slice(1);

const describe = (text: string | undefined, indent = ""): string =>
  text ? `${indent}"""\n${indent}${text.replace(/"""/g, '\\"""').split("\n").join(`\n${indent}`)}\n${indent}"""\n` : "";

const enumName = (model: ModelDef, f: FieldDef): string => `${model.name}${upperFirst(f.name)}`;

/** GraphQL type of a field value (without "!"). */
const valueType = (model: ModelDef, f: FieldDef): string => {
  switch (f.type) {
    case "string":
    case "decimal":
    case "datetime":
    case "date":
      return "String";
    case "int":
      return "Int";
    case "float":
      return "Float";
    case "boolean":
      return "Boolean";
    case "uuid":
      return "ID";
    case "json":
      return "JSON";
    case "enum":
      return enumName(model, f);
  }
};

const FORMAT_HINTS: Partial<Record<FieldDef["type"], string>> = {
  decimal: "Decimal number as a string, e.g. \"12.34\".",
  datetime: "ISO 8601 date and time.",
  date: "Date (YYYY-MM-DD).",
};

const fieldDoc = (f: FieldDef): string | undefined =>
  f.system
    ? f.description
    : [f.description, FORMAT_HINTS[f.type]].filter(Boolean).join(" ") || undefined;

const filterType = (model: ModelDef, f: FieldDef): string => `${model.name}${upperFirst(f.name)}Filter`;

const filterInput = (model: ModelDef, f: FieldDef, ops: FilterOp[]): string => {
  const t = valueType(model, f);
  const line = (op: FilterOp): string => {
    switch (op) {
      case "in":
        return "  in: [" + t + "!]";
      case "isNull":
        return "  isNull: Boolean";
      case "like":
      case "ilike":
        return `  "SQL ${op.toUpperCase()} pattern (% and _ are wildcards)."\n  ${op}: String`;
      default:
        return `  ${op}: ${t}`;
    }
  };
  return `input ${filterType(model, f)} {\n${ops.map(line).join("\n")}\n}\n`;
};

const QUERY_VALUE_TYPES: Record<QueryValueDef["type"], string> = {
  string: "String",
  int: "Int",
  float: "Float",
  decimal: "String",
  boolean: "Boolean",
  datetime: "String",
  date: "String",
  uuid: "ID",
  json: "JSON",
};

const rowType = (q: QueryDef): string => `${upperFirst(q.name)}Row`;

const queryTypeDefs = (q: QueryDef): string =>
  `type ${rowType(q)} {\n` +
  q.returns
    .map((r) => `${describe(r.description, "  ")}  ${r.name}: ${QUERY_VALUE_TYPES[r.type]}${r.required ? "!" : ""}`)
    .join("\n") +
  "\n}\n";

const queryField = (q: QueryDef): string => {
  const params = q.params.map(
    (p) => `${p.name}: ${QUERY_VALUE_TYPES[p.type]}${p.required ? "!" : ""}`,
  );
  const result = q.list ? `[${rowType(q)}!]!` : rowType(q);
  return `${describe(q.description, "  ")}  ${q.name}${params.length > 0 ? `(${params.join(", ")})` : ""}: ${result}`;
};

const pluralType = (m: ModelDef): string => upperFirst(m.plural);

const modelTypeDefs = (model: ModelDef, models: readonly ModelDef[]): string => {
  const own = model.fields.filter((f) => !f.system);
  const field = (f: FieldDef, nonNull: boolean): string =>
    `${describe(fieldDoc(f), "  ")}  ${f.name}: ${valueType(model, f)}${nonNull ? "!" : ""}`;
  const parts: string[] = [];

  for (const f of own.filter((f) => f.type === "enum")) {
    parts.push(`enum ${enumName(model, f)} {\n${f.values?.map((v) => `  ${v}`).join("\n")}\n}\n`);
  }
  const relationFields = model.relations.map((r) => {
    const target = models.find((m) => m.name === r.target) as ModelDef;
    return r.kind === "belongsTo"
      ? `${describe(`The ${r.target} of ${r.field}.`, "  ")}  ${r.name}: ${r.target}`
      : `${describe(`${target.plural} whose ${r.foreignKey} is this ${model.name}.`, "  ")}  ${r.name}(${listArgs(target)}): [${r.target}!]!`;
  });
  parts.push(
    `${describe(model.description)}type ${model.name} {\n` +
      [...model.fields.map((f) => field(f, f.required)), ...relationFields].join("\n") +
      "\n}\n",
  );
  parts.push(
    `input Create${model.name}Input {\n` +
      own.map((f) => field(f, f.required && f.default === undefined)).join("\n") +
      "\n}\n",
  );
  parts.push(
    `"Fields to change. Omitted fields keep their value; null clears a field that is not required."\n` +
      `input Update${model.name}Input {\n` +
      own.map((f) => field(f, false)).join("\n") +
      "\n}\n",
  );

  const filterable = Object.entries(model.list.filterable);
  if (filterable.length > 0) {
    for (const [name, ops] of filterable) {
      parts.push(filterInput(model, model.fields.find((f) => f.name === name) as FieldDef, ops));
    }
    parts.push(
      `"Conditions on ${model.plural}; all given conditions must match."\n` +
        `input ${model.name}Where {\n` +
        filterable.map(([name]) => `  ${name}: ${filterType(model, model.fields.find((f) => f.name === name) as FieldDef)}`).join("\n") +
        "\n}\n",
    );
  }
  if (model.list.sortable.length > 0) {
    parts.push(`enum ${model.name}SortField {\n${model.list.sortable.map((s) => `  ${s}`).join("\n")}\n}\n`);
    parts.push(
      `input ${model.name}OrderBy {\n  field: ${model.name}SortField!\n  direction: SortDirection = ASC\n}\n`,
    );
  }
  return parts.join("\n");
};

const listArgs = (model: ModelDef): string => {
  const args: string[] = [];
  if (Object.keys(model.list.filterable).length > 0) args.push(`where: ${model.name}Where`);
  if (model.list.sortable.length > 0) args.push(`orderBy: [${model.name}OrderBy!]`);
  args.push(`limit: Int = ${model.list.defaultLimit}`, "offset: Int = 0");
  return args.join(", ");
};

const MUTATION_DOC = `Writes run on the primary database. idempotencyKey (optional, 1-200
characters, e.g. a UUID made by the client): a retry with the same key
returns the first result instead of writing again, for as long as the
write journal keeps it.`;

export const typeDefs = (models: readonly ModelDef[]): string =>
  [
    `${describe("Any JSON value.")}scalar JSON\n`,
    "enum SortDirection {\n  ASC\n  DESC\n}\n",
    ...(models.some((m) => m.bulkWrite.update || m.bulkWrite.delete)
      ? ['"Result of a bulk write."\ntype BulkWriteResult {\n  "Rows written."\n  count: Int!\n}\n']
      : []),
    ...models.map((m) => modelTypeDefs(m, models)),
    ...models.flatMap((m) => m.queries.map(queryTypeDefs)),
    "type Query {\n" +
      '  "Cloud that served this request."\n  cloud: String!\n' +
      models
        .map((m) =>
          [
            `  ${lowerFirst(m.name)}(id: ID!): ${m.name}`,
            `  ${m.plural}(${listArgs(m)}): [${m.name}!]!`,
            ...m.queries.map(queryField),
          ].join("\n"),
        )
        .join("\n") +
      "\n}\n",
    `${describe(MUTATION_DOC)}type Mutation {\n` +
      models
        .map(
          (m) =>
            [
              `  create${m.name}(input: Create${m.name}Input!, idempotencyKey: String): ${m.name}!`,
              `  update${m.name}(id: ID!, version: Int!, input: Update${m.name}Input!, idempotencyKey: String): ${m.name}!`,
              `  delete${m.name}(id: ID!, version: Int!, idempotencyKey: String): Boolean!`,
              ...(m.bulkWrite.update
                ? [
                    `${describe(`Updates every ${m.name} matching where (at most ${m.bulkWrite.maxRows}, otherwise nothing is written).`, "  ")}` +
                      `  update${pluralType(m)}(where: ${m.name}Where!, input: Update${m.name}Input!, idempotencyKey: String): BulkWriteResult!`,
                  ]
                : []),
              ...(m.bulkWrite.delete
                ? [
                    `${describe(`Deletes every ${m.name} matching where (at most ${m.bulkWrite.maxRows}, otherwise nothing is deleted).`, "  ")}` +
                      `  delete${pluralType(m)}(where: ${m.name}Where!, idempotencyKey: String): BulkWriteResult!`,
                  ]
                : []),
            ].join("\n"),
        )
        .join("\n") +
      "\n}\n",
  ].join("\n");

const literalValue = (node: ValueNode): unknown => {
  switch (node.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
    case Kind.ENUM:
      return node.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(node.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return node.values.map(literalValue);
    case Kind.OBJECT:
      return Object.fromEntries(node.fields.map((f) => [f.name.value, literalValue(f.value)]));
    default:
      throw new TypeError("Variables are not supported inside JSON literals");
  }
};

const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: literalValue,
});

const iso = (value: unknown): unknown => (value instanceof Date ? value.toISOString() : value);

type Args = Record<string, unknown>;

/** Builds the executable schema. Fails if generated names collide. */
export const buildSchema = (models: readonly ModelDef[]): GraphQLSchema => {
  const rootFields = new Set(["cloud"]);
  const mutations = new Set<string>();
  const typeNames = new Set(models.map((m) => m.name));
  const claim = (set: Set<string>, name: string, m: ModelDef, what: string): void => {
    if (set.has(name)) {
      throw new ModelError(`${m.source}: ${what} "${name}" is already used; rename it (or set "plural")`);
    }
    set.add(name);
  };
  for (const m of models) {
    claim(rootFields, lowerFirst(m.name), m, "query name");
    claim(rootFields, m.plural, m, "query name");
    for (const q of m.queries) {
      claim(rootFields, q.name, m, "query name");
      claim(typeNames, rowType(q), m, "type name");
    }
    for (const op of ["create", "update", "delete"]) claim(mutations, `${op}${m.name}`, m, "mutation name");
    if (m.bulkWrite.update) claim(mutations, `update${pluralType(m)}`, m, "mutation name");
    if (m.bulkWrite.delete) claim(mutations, `delete${pluralType(m)}`, m, "mutation name");
  }

  const service = (ctx: GraphQLContext, model: ModelDef): EntityService => {
    const s = ctx.services.get(model.name);
    if (!s) throw new Error(`No service for ${model.name}`);
    return s;
  };
  const query: Record<string, unknown> = {
    cloud: (_p: unknown, _a: Args, ctx: GraphQLContext) => ctx.cloudId,
  };
  const mutation: Record<string, unknown> = {};
  const types: Record<string, unknown> = { JSON: JSONScalar };

  for (const m of models) {
    query[lowerFirst(m.name)] = (_p: unknown, a: { id: string }, ctx: GraphQLContext) =>
      service(ctx, m).get(a.id);
    query[m.plural] = (_p: unknown, a: ListArgs, ctx: GraphQLContext) => service(ctx, m).list(a);
    mutation[`create${m.name}`] = (
      _p: unknown,
      a: { input: Args; idempotencyKey?: string | null },
      ctx: GraphQLContext,
    ) => service(ctx, m).create(a.input, a.idempotencyKey ?? undefined);
    mutation[`update${m.name}`] = (
      _p: unknown,
      a: { id: string; version: number; input: Args; idempotencyKey?: string | null },
      ctx: GraphQLContext,
    ) => service(ctx, m).update(a.id, a.version, a.input, a.idempotencyKey ?? undefined);
    mutation[`delete${m.name}`] = (
      _p: unknown,
      a: { id: string; version: number; idempotencyKey?: string | null },
      ctx: GraphQLContext,
    ) => service(ctx, m).delete(a.id, a.version, a.idempotencyKey ?? undefined);
    if (m.bulkWrite.update) {
      mutation[`update${pluralType(m)}`] = (
        _p: unknown,
        a: { where: NonNullable<ListArgs["where"]>; input: Args; idempotencyKey?: string | null },
        ctx: GraphQLContext,
      ) => service(ctx, m).updateMany(a.where, a.input, a.idempotencyKey ?? undefined);
    }
    if (m.bulkWrite.delete) {
      mutation[`delete${pluralType(m)}`] = (
        _p: unknown,
        a: { where: NonNullable<ListArgs["where"]>; idempotencyKey?: string | null },
        ctx: GraphQLContext,
      ) => service(ctx, m).deleteMany(a.where, a.idempotencyKey ?? undefined);
    }
    for (const q of m.queries) {
      query[q.name] = (_p: unknown, a: Args, ctx: GraphQLContext) => ctx.queries.run(q, a);
    }
    const relations = Object.fromEntries(
      m.relations.map((r) => {
        if (r.kind === "belongsTo") {
          return [
            r.name,
            (e: Entity, _a: Args, ctx: GraphQLContext) =>
              typeof e[r.field] === "string" ? ctx.loaders.byId(r.target, e[r.field] as string) : null,
          ];
        }
        const target = models.find((t) => t.name === r.target) as ModelDef;
        const inverse = target.relations.find((t) => t.name === r.foreignKey);
        const field = inverse?.kind === "belongsTo" ? inverse.field : `${r.foreignKey}Id`;
        return [
          r.name,
          (e: Entity, a: ListArgs, ctx: GraphQLContext) => ctx.loaders.children(r.target, field, a, e.id),
        ];
      }),
    );
    types[m.name] = {
      ...Object.fromEntries(
        m.fields
          .filter((f) => f.type === "datetime")
          .map((f) => [f.name, (e: Entity) => iso(e[f.name])]),
      ),
      ...relations,
    };
  }

  return createSchema<GraphQLContext>({
    typeDefs: typeDefs(models),
    resolvers: { ...types, Query: query, Mutation: mutation },
  });
};
