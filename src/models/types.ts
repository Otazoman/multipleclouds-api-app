/**
 * Model definitions (models/*.yaml), after validation and defaults
 * (src/models/load.ts). See docs/models.md for the file format.
 */

export const FIELD_TYPES = [
  "string",
  "int",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "date",
  "uuid",
  "enum",
  "json",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FILTER_OPS = [
  "eq",
  "ne",
  "in",
  "lt",
  "lte",
  "gt",
  "gte",
  "like",
  "ilike",
  "isNull",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export type SortDirection = "asc" | "desc";

export interface FieldDef {
  /** GraphQL name (camelCase). */
  name: string;
  /** Column name (snake_case). */
  column: string;
  type: FieldType;
  /** NOT NULL; must be given on create unless it has a default. */
  required: boolean;
  /** SQL default; "now" for datetime means the current time. */
  default?: string | number | boolean;
  unique: boolean;
  /** string: maximum number of characters. */
  maxLength?: number;
  /** int / float / decimal: inclusive bounds. */
  min?: number;
  max?: number;
  /** enum: allowed values (also the GraphQL enum values). */
  values?: string[];
  description?: string;
  /** Columns every table has (id, owner_cloud, version, timestamps). */
  system: boolean;
  /** Foreign key of a belongsTo relation (the field is `<relation>Id`). */
  references?: ForeignKey;
}

export const ON_DELETE = ["restrict", "cascade", "setNull"] as const;
export type OnDelete = (typeof ON_DELETE)[number];

export interface ForeignKey {
  /** Referenced model; its table is filled in by resolveModels. */
  model: string;
  table: string;
  onDelete: OnDelete;
}

/** `relation: { belongsTo: Customer }` -> field customerId + GraphQL `relation`. */
export interface BelongsToDef {
  kind: "belongsTo";
  name: string;
  target: string;
  /** The foreign key field (`<name>Id`). */
  field: string;
}

/** `relation: { hasMany: OrderLine, foreignKey: order }`: the inverse list. */
export interface HasManyDef {
  kind: "hasMany";
  name: string;
  target: string;
  /** Name of the belongsTo relation on the target that points here. */
  foreignKey: string;
}

export type RelationDef = BelongsToDef | HasManyDef;

/** Types allowed for named query parameters and result columns. */
export const QUERY_VALUE_TYPES = [
  "string",
  "int",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "date",
  "uuid",
  "json",
] as const;
export type QueryValueType = (typeof QUERY_VALUE_TYPES)[number];

export interface QueryValueDef {
  name: string;
  type: QueryValueType;
  required: boolean;
  description?: string;
}

/** A read-only SQL query exposed as a GraphQL query. */
export interface QueryDef {
  /** GraphQL query name (camelCase). */
  name: string;
  description?: string;
  /** SQL with :param placeholders, as written in the YAML. */
  sql: string;
  params: QueryValueDef[];
  /** Result columns (GraphQL type <Name>Row). */
  returns: QueryValueDef[];
  /** true: a list of rows; false: the first row or null. */
  list: boolean;
  timeoutMs: number;
}

export interface IndexDef {
  name: string;
  /** Field names. */
  fields: string[];
  unique: boolean;
}

export interface OrderDef {
  field: string;
  direction: SortDirection;
}

export interface ModelDef {
  /** GraphQL type name (PascalCase), e.g. Item. */
  name: string;
  /** Plural used for the list query, e.g. items. */
  plural: string;
  /** Table in schema "app". */
  table: string;
  description?: string;
  /** System fields first (id), then the model's fields, then the rest. */
  fields: FieldDef[];
  indexes: IndexDef[];
  relations: RelationDef[];
  /** updateMany / deleteMany by condition (`update<Plural>`, `delete<Plural>`). */
  bulkWrite: { update: boolean; delete: boolean; maxRows: number };
  queries: QueryDef[];
  list: {
    defaultLimit: number;
    maxLimit: number;
    /** Field name -> allowed operators in `where`. */
    filterable: Record<string, FilterOp[]>;
    /** Fields allowed in `orderBy`. */
    sortable: string[];
    /** Order when `orderBy` is not given (id is always added last). */
    defaultOrder: OrderDef[];
  };
  /** File the model was read from, for messages. */
  source: string;
}

/** Fields every model gets; they cannot be defined in the YAML. */
export const SYSTEM_FIELD_NAMES = [
  "id",
  "ownerCloud",
  "version",
  "createdAt",
  "updatedAt",
] as const;
