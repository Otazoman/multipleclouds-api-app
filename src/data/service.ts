import { GraphQLError } from "graphql";
import { WriteMeta } from "../cluster";
import { FieldDef, FilterOp, ModelDef, OrderDef } from "../models/types";
import { Entity, EntityRepository, Values, Where } from "./repository";

export const ERROR_CODES = {
  notFound: "NOT_FOUND",
  versionConflict: "VERSION_CONFLICT",
  badInput: "BAD_USER_INPUT",
  /** A bulk write matched more rows than bulkWrite.maxRows; nothing was written. */
  tooManyRows: "TOO_MANY_ROWS",
  /** A unique or foreign key constraint rejected the write. */
  constraintViolation: "CONSTRAINT_VIOLATION",
} as const;

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Runs `fn` in a write transaction on the primary, records it in the
 * journal and commits it (`PrimaryWriter.transaction` in production).
 */
export type EntityWriter = <T>(
  meta: WriteMeta<T>,
  fn: (repository: EntityRepository) => Promise<T>,
) => Promise<T>;

/** Arguments of the list query, as GraphQL passes them. */
export interface ListArgs {
  where?: Record<string, Record<string, unknown> | null> | null;
  orderBy?: { field: string; direction?: "ASC" | "DESC" | null }[] | null;
  limit: number;
  offset: number;
}

const badInput = (message: string): GraphQLError =>
  new GraphQLError(message, { extensions: { code: ERROR_CODES.badInput } });

const assertUuid = (id: string, name = "id"): void => {
  if (!UUID_PATTERN.test(id)) {
    throw badInput(`${name} must be a UUID`);
  }
};

const assertIdempotencyKey = (key: string | undefined): void => {
  if (
    key !== undefined &&
    (key.trim() === "" || key.length > MAX_IDEMPOTENCY_KEY_LENGTH)
  ) {
    throw badInput(
      `idempotencyKey must be 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
};

/**
 * Checks a non-null value against the field definition and converts it for
 * the database (datetime strings to Date).
 */
export const convertValue = (f: FieldDef, value: unknown): unknown => {
  const name = f.name;
  switch (f.type) {
    case "string": {
      const s = value as string;
      if (f.required && s.trim() === "") {
        throw badInput(`${name} must not be empty`);
      }
      if (f.maxLength !== undefined && [...s].length > f.maxLength) {
        throw badInput(`${name} must be at most ${f.maxLength} characters`);
      }
      return s;
    }
    case "int":
    case "float":
    case "decimal": {
      if (f.type === "decimal" && !DECIMAL_PATTERN.test(value as string)) {
        throw badInput(`${name} must be a decimal number such as 12.34`);
      }
      const n = Number(value);
      if (f.min !== undefined && n < f.min) throw badInput(`${name} must be at least ${f.min}`);
      if (f.max !== undefined && n > f.max) throw badInput(`${name} must be at most ${f.max}`);
      return value;
    }
    case "datetime": {
      const d = new Date(value as string);
      if (Number.isNaN(d.getTime())) {
        throw badInput(`${name} must be an ISO 8601 date and time`);
      }
      return d;
    }
    case "date": {
      const s = value as string;
      if (!DATE_PATTERN.test(s) || Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())) {
        throw badInput(`${name} must be a date (YYYY-MM-DD)`);
      }
      return s;
    }
    case "uuid":
      assertUuid(value as string, name);
      return value;
    default:
      // boolean, enum (checked by GraphQL), json
      return value;
  }
};

/** Number of rows written by a bulk write. */
export interface BulkWriteResult {
  count: number;
}

/**
 * Rules for one model (docs/architecture.md):
 *
 * - Reads use this cloud's database (`reader`); all writes run on the
 *   primary (`write`), so every row has a single writer and the usual
 *   locking and transaction rules of one database apply.
 * - Updates and deletes carry the version the client read; a mismatch is
 *   rejected with VERSION_CONFLICT (optimistic locking).
 * - Writes take an optional idempotency key: a retry with the same key
 *   returns the first result instead of writing again.
 */
export class EntityService {
  private readonly own: FieldDef[];
  private readonly byName: Map<string, FieldDef>;

  constructor(
    readonly model: ModelDef,
    private readonly reader: EntityRepository,
    private readonly write: EntityWriter,
    private readonly cloudId: string,
  ) {
    this.own = model.fields.filter((f) => !f.system);
    this.byName = new Map(model.fields.map((f) => [f.name, f]));
  }

  get(id: string): Promise<Entity | null> {
    assertUuid(id);
    return this.reader.findById(id);
  }

  /** Rows by ID (for relations); IDs that do not exist are missing. */
  async getMany(ids: readonly string[]): Promise<Map<string, Entity>> {
    const rows = await this.reader.findByIds(ids.filter((id) => UUID_PATTERN.test(id)));
    return new Map(rows.map((r) => [r.id, r]));
  }

  list(args: ListArgs): Promise<Entity[]> {
    return this.reader.list(this.listQuery(args));
  }

  /** Children of many parents in one query (hasMany relations). */
  async listByParents(
    field: string,
    parentIds: readonly string[],
    args: ListArgs,
  ): Promise<Map<string, Entity[]>> {
    const rows = await this.reader.listByParents(field, parentIds, this.listQuery(args));
    const byParent = new Map<string, Entity[]>(parentIds.map((id) => [id, []]));
    for (const row of rows) {
      byParent.get(row[field] as string)?.push(row);
    }
    return byParent;
  }

  private listQuery(args: ListArgs) {
    const { maxLimit, defaultOrder } = this.model.list;
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > maxLimit) {
      throw badInput(`limit must be between 1 and ${maxLimit}`);
    }
    if (!Number.isInteger(args.offset) || args.offset < 0) {
      throw badInput("offset must be 0 or greater");
    }
    const orderBy: OrderDef[] =
      args.orderBy && args.orderBy.length > 0
        ? args.orderBy.map((o) => ({
            field: o.field,
            direction: o.direction === "DESC" ? "desc" : "asc",
          }))
        : defaultOrder;
    return {
      where: this.convertWhere(args.where ?? {}),
      orderBy,
      limit: args.limit,
      offset: args.offset,
    };
  }

  create(input: Record<string, unknown>, idempotencyKey?: string): Promise<Entity> {
    const values = this.convertInput(input, "create");
    assertIdempotencyKey(idempotencyKey);
    return this.write(
      { operation: `create${this.model.name}`, args: { input }, idempotencyKey, revive: this.revive },
      (repository) => this.mapConstraints(() => repository.insert(values, this.cloudId)),
    );
  }

  async update(
    id: string,
    version: number,
    input: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<Entity> {
    assertUuid(id);
    const changes = this.convertInput(input, "update");
    assertIdempotencyKey(idempotencyKey);
    const meta = {
      operation: `update${this.model.name}`,
      args: { id, version, input },
      idempotencyKey,
      revive: this.revive,
    };
    return this.write(meta, async (repository) => {
      const updated = await this.mapConstraints(() => repository.update(id, version, changes));
      if (updated) {
        return updated;
      }
      throw await this.explainRejectedWrite(repository, id, version);
    });
  }

  async delete(id: string, version: number, idempotencyKey?: string): Promise<boolean> {
    assertUuid(id);
    assertIdempotencyKey(idempotencyKey);
    const meta = {
      operation: `delete${this.model.name}`,
      args: { id, version },
      idempotencyKey,
      revive: (stored: unknown) => stored === true,
    };
    return this.write(meta, async (repository) => {
      if (await this.mapConstraints(() => repository.delete(id, version))) {
        return true;
      }
      throw await this.explainRejectedWrite(repository, id, version);
    });
  }

  /**
   * Updates every row matching `where` (bulkWrite.update). Fails without
   * writing when more than bulkWrite.maxRows rows match.
   */
  updateMany(
    where: NonNullable<ListArgs["where"]>,
    input: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<BulkWriteResult> {
    const conditions = this.bulkWhere(where);
    const changes = this.convertInput(input, "update");
    if (Object.keys(changes).length === 0) {
      throw badInput("input must change at least one field");
    }
    assertIdempotencyKey(idempotencyKey);
    return this.write(
      {
        operation: `update${this.pluralName()}`,
        args: { where, input },
        idempotencyKey,
        revive: (stored) => stored as BulkWriteResult,
      },
      async (repository) =>
        this.bulkResult(
          await this.mapConstraints(() =>
            repository.updateWhere(conditions, changes, this.model.bulkWrite.maxRows + 1),
          ),
        ),
    );
  }

  /** Deletes every row matching `where` (bulkWrite.delete). */
  deleteMany(
    where: NonNullable<ListArgs["where"]>,
    idempotencyKey?: string,
  ): Promise<BulkWriteResult> {
    const conditions = this.bulkWhere(where);
    assertIdempotencyKey(idempotencyKey);
    return this.write(
      {
        operation: `delete${this.pluralName()}`,
        args: { where },
        idempotencyKey,
        revive: (stored) => stored as BulkWriteResult,
      },
      async (repository) =>
        this.bulkResult(
          await this.mapConstraints(() =>
            repository.deleteWhere(conditions, this.model.bulkWrite.maxRows + 1),
          ),
        ),
    );
  }

  private pluralName(): string {
    return this.model.plural[0].toUpperCase() + this.model.plural.slice(1);
  }

  /** A bulk write needs at least one condition. */
  private bulkWhere(where: NonNullable<ListArgs["where"]>): Where {
    const conditions = this.convertWhere(where);
    if (Object.values(conditions).every((ops) => Object.keys(ops).length === 0)) {
      throw badInput("where must have at least one condition");
    }
    return conditions;
  }

  /** Thrown inside the transaction, so nothing is committed. */
  private bulkResult(count: number): BulkWriteResult {
    const { maxRows } = this.model.bulkWrite;
    if (count > maxRows) {
      throw new GraphQLError(`More than ${maxRows} rows match; nothing was written`, {
        extensions: { code: ERROR_CODES.tooManyRows, maxRows },
      });
    }
    return { count };
  }

  /** Unique and foreign key violations as client errors. */
  private async mapConstraints<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const e = error as { code?: unknown; constraint?: unknown };
      if (e.code !== UNIQUE_VIOLATION && e.code !== FOREIGN_KEY_VIOLATION) {
        throw error;
      }
      const constraint = typeof e.constraint === "string" ? e.constraint : undefined;
      const field = this.model.fields.find(
        (f) =>
          constraint === `${this.model.table}_${f.column}_key` ||
          constraint === `${this.model.table}_${f.column}_fkey`,
      );
      const message =
        e.code === UNIQUE_VIOLATION
          ? `Another ${this.model.name} has the same ${field?.name ?? "value"}`
          : field?.references
            ? `${field.name} refers to a ${field.references.model} that does not exist`
            : `The ${this.model.name} is still referenced by other rows`;
      throw new GraphQLError(message, {
        extensions: { code: ERROR_CODES.constraintViolation, constraint },
      });
    }
  }

  /**
   * create: every given field (null means "use the default / no value").
   * update: given fields only; null clears a field that is not required and
   * is ignored for a required one ("unchanged").
   */
  private convertInput(input: Record<string, unknown>, mode: "create" | "update"): Values {
    const values: Values = {};
    for (const f of this.own) {
      if (!(f.name in input) || input[f.name] === undefined) continue;
      const value = input[f.name];
      if (value === null) {
        if (f.required || mode === "create") continue;
        values[f.name] = null;
        continue;
      }
      values[f.name] = convertValue(f, value);
    }
    return values;
  }

  private convertWhere(where: NonNullable<ListArgs["where"]>): Where {
    const result: Where = {};
    for (const [name, ops] of Object.entries(where)) {
      if (!ops) continue;
      const f = this.byName.get(name);
      if (!f) throw badInput(`unknown field ${name}`);
      const converted: Partial<Record<FilterOp, unknown>> = {};
      for (const [op, value] of Object.entries(ops)) {
        if (value === null || value === undefined) continue;
        if (op === "isNull") {
          converted.isNull = value;
        } else if (op === "in") {
          converted.in = (value as unknown[]).map((v) => convertValue(f, v));
        } else if (op === "like" || op === "ilike") {
          converted[op] = value;
        } else {
          converted[op as FilterOp] = convertValue({ ...f, required: false }, value);
        }
      }
      result[name] = converted;
    }
    return result;
  }

  /** An entity stored as JSON in the journal (dates as ISO strings). */
  private readonly revive = (stored: unknown): Entity => {
    const entity = { ...(stored as Record<string, unknown>) };
    for (const f of this.model.fields) {
      if (f.type === "datetime" && typeof entity[f.name] === "string") {
        entity[f.name] = new Date(entity[f.name] as string);
      }
    }
    return entity as Entity;
  };

  /**
   * Finds out why a conditional update / delete matched no row. Runs in the
   * same transaction on the primary, so it sees the current row.
   */
  private async explainRejectedWrite(
    repository: EntityRepository,
    id: string,
    version: number,
  ): Promise<GraphQLError> {
    const current = await repository.findById(id);
    if (!current) {
      return new GraphQLError(`${this.model.name} ${id} not found`, {
        extensions: { code: ERROR_CODES.notFound },
      });
    }
    return new GraphQLError(
      `${this.model.name} ${id} has version ${current.version}, not ${version}`,
      {
        extensions: {
          code: ERROR_CODES.versionConflict,
          currentVersion: current.version,
        },
      },
    );
  }
}
