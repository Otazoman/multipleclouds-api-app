import { GraphQLError } from "graphql";
import { escapeLiteral, Pool, PoolClient, QueryConfig, QueryResult } from "pg";

/**
 * Write routing (docs/architecture.md, "Writes"): every API reads from its
 * own cloud's database and writes to the primary, the node named in
 * ops.cluster_state with the highest epoch (set by scripts/switchover.sh).
 * A commit is reported as successful only after at least `ackPeers` other
 * nodes have flushed it, so a switchover never loses a confirmed write.
 * Every write is recorded in app.write_journal in the same transaction
 * (migrations/0003_write_journal.sql), which also serves idempotency keys.
 */

export const WRITE_ERROR_CODES = {
  /** No primary is known, it is unreachable, or it changed: retry later. */
  primaryUnavailable: "PRIMARY_UNAVAILABLE",
  /** The write may or may not have been committed. */
  commitUnconfirmed: "COMMIT_UNCONFIRMED",
  /** The idempotency key was used for a different write. */
  idempotencyKeyReused: "IDEMPOTENCY_KEY_REUSED",
} as const;

export interface PrimaryState {
  primary: string;
  epoch: number;
}

/** Reading the state must not wait long for a node that does not answer. */
const STATE_QUERY_TIMEOUT_MS = 3000;

/** The state with the highest epoch, or null. */
export const pickPrimary = (
  states: readonly PrimaryState[],
): PrimaryState | null =>
  states.reduce<PrimaryState | null>(
    (best, state) => (best === null || state.epoch > best.epoch ? state : best),
    null,
  );

interface StateRow {
  primary_node: string;
  epoch: string; // bigint
}

/** Keeps track of the primary by reading ops.cluster_state on every node. */
export class ClusterState {
  private state: PrimaryState | null = null;
  private loading: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly nodes: ReadonlyMap<string, Pool>,
    private readonly intervalMs: number,
  ) {}

  current(): PrimaryState | null {
    return this.state;
  }

  start(): Promise<void> {
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref();
    return this.refresh();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** Reads the state now; concurrent calls share one read. */
  refresh(): Promise<void> {
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.nodes.values()].map((pool) =>
        pool.query<StateRow>({
          text: "SELECT primary_node, epoch FROM ops.get_cluster_state()",
          query_timeout: STATE_QUERY_TIMEOUT_MS,
        } as QueryConfig),
      ),
    );
    const states = results.flatMap((result) =>
      result.status === "fulfilled"
        ? result.value.rows.map((row) => ({
            primary: row.primary_node,
            epoch: Number(row.epoch),
          }))
        : [],
    );
    const next = pickPrimary(states);
    // The epoch only moves forward: a node that is unreachable right now
    // may hold the newest state, so keep what was already seen.
    if (next && (!this.state || next.epoch > this.state.epoch)) {
      console.log(`Primary: ${next.primary} (epoch ${next.epoch})`);
      this.state = next;
    }
  }
}

export interface WriteAck {
  /** Other nodes that must confirm a commit (0: do not wait). */
  peers: number;
  timeoutMs: number;
}

/** What a write is, for the journal and for idempotent retries. */
export interface WriteMeta<T> {
  /** GraphQL mutation name. */
  operation: string;
  /** Mutation arguments, without the idempotency key. */
  args: unknown;
  /** Same key, same write: the stored result is returned, nothing runs. */
  idempotencyKey?: string;
  /** Rebuilds the result from its stored JSON. */
  revive: (stored: unknown) => T;
}

const primaryUnavailable = (message: string): GraphQLError =>
  new GraphQLError(message, {
    extensions: { code: WRITE_ERROR_CODES.primaryUnavailable },
  });

const commitUnconfirmed = (message: string): GraphQLError =>
  new GraphQLError(message, {
    extensions: { code: WRITE_ERROR_CODES.commitUnconfirmed },
  });

/** SQLSTATE raised by ops.assert_primary. */
const NOT_PRIMARY = "MCP01";
const UNIQUE_VIOLATION = "23505";
const IDEMPOTENCY_KEY_INDEX = "write_journal_idempotency_key_idx";

/** True for errors returned by the server (the connection still works). */
const isServerError = (
  error: unknown,
): error is { code: string; constraint?: string } =>
  typeof error === "object" &&
  error !== null &&
  "severity" in error &&
  typeof (error as { code?: unknown }).code === "string";

/** JSON with sorted object keys, to compare arguments. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );

/** JSON text as a SQL literal. */
const jsonLiteral = (value: unknown): string =>
  `${escapeLiteral(JSON.stringify(value ?? null))}::jsonb`;

interface JournalRow {
  operation: string;
  args: unknown;
  result: unknown;
}

/** Thrown when a concurrent write committed the same idempotency key first. */
class DuplicateKey extends Error {}

/** Runs write transactions on the primary. */
export class PrimaryWriter {
  constructor(
    private readonly cluster: ClusterState,
    private readonly nodes: ReadonlyMap<string, Pool>,
    private readonly ack: WriteAck,
  ) {}

  /**
   * Runs `fn` in a transaction on the primary, records it in the journal and
   * commits it. Throws PRIMARY_UNAVAILABLE when nothing was written, and
   * COMMIT_UNCONFIRMED when the commit was sent but its result or its
   * confirmation by the other nodes is unknown. With an idempotency key that
   * is already in the journal, returns the stored result instead.
   */
  async transaction<T>(
    meta: WriteMeta<T>,
    fn: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.run(meta, fn);
    } catch (error) {
      if (error instanceof DuplicateKey) {
        // The other write has committed: this run returns its result.
        return this.run(meta, fn);
      }
      throw error;
    }
  }

  private async run<T>(
    meta: WriteMeta<T>,
    fn: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    const state = this.cluster.current();
    const pool = state && this.nodes.get(state.primary);
    if (!state || !pool) {
      throw primaryUnavailable(
        state ? `Primary ${state.primary} is not configured` : "No primary is known",
      );
    }

    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      console.error(`Primary ${state.primary} unreachable:`, (error as Error).message);
      void this.cluster.refresh();
      throw primaryUnavailable(`Primary ${state.primary} is unreachable`);
    }

    // Statements are sent without parameters (integers, and literals escaped
    // by escapeLiteral) so that several go in one round trip: BEGIN with the
    // checks, and the journal with COMMIT and the wait.
    const key = meta.idempotencyKey;
    const wait =
      this.ack.peers > 0
        ? `; SELECT ops.wait_for_peers(${this.ack.peers}, ${this.ack.timeoutMs}) AS confirmed`
        : "";
    const confirmed = (results: QueryResult[]): boolean =>
      this.ack.peers === 0 || results[results.length - 1].rows[0]?.confirmed === true;

    let committing = false;
    let broken = false;
    try {
      const begin = (await client.query(
        `BEGIN; SELECT ops.assert_primary(${state.epoch})` +
          (key === undefined
            ? ""
            : `; SELECT operation, args, result FROM app.write_journal WHERE idempotency_key = ${escapeLiteral(key)}`),
      )) as unknown as QueryResult[];

      const previous = key === undefined ? undefined : (begin[2].rows[0] as JournalRow | undefined);
      if (previous) {
        if (
          previous.operation !== meta.operation ||
          canonical(previous.args) !== canonical(JSON.parse(JSON.stringify(meta.args ?? null)))
        ) {
          throw new GraphQLError("The idempotency key was used for a different write", {
            extensions: { code: WRITE_ERROR_CODES.idempotencyKeyReused },
          });
        }
        // Already written; it may still lack confirmation by another node.
        committing = true;
        const replay = (await client.query(`ROLLBACK${wait}`)) as unknown as QueryResult[];
        if (!confirmed([replay].flat())) {
          throw commitUnconfirmed(
            "The write is on the primary but not confirmed by another cloud in time",
          );
        }
        return meta.revive(previous.result);
      }

      const result = await fn(client);
      committing = true;
      const journal =
        "INSERT INTO app.write_journal (epoch, node, operation, args, result, idempotency_key) " +
        `VALUES (${state.epoch}, ${escapeLiteral(state.primary)}, ${escapeLiteral(meta.operation)}, ` +
        `${jsonLiteral(meta.args)}, ${jsonLiteral(result)}, ${key === undefined ? "NULL" : escapeLiteral(key)})`;
      const commit = (await client.query(`${journal}; COMMIT${wait}`)) as unknown as QueryResult[];
      if (!confirmed(commit)) {
        throw commitUnconfirmed(
          "The write was committed on the primary but not confirmed by another cloud in time",
        );
      }
      return result;
    } catch (error) {
      if (
        committing &&
        isServerError(error) &&
        error.code === UNIQUE_VIOLATION &&
        error.constraint === IDEMPOTENCY_KEY_INDEX
      ) {
        // The journal insert failed, so nothing was committed.
        broken = !(await client.query("ROLLBACK").then(
          () => true,
          () => false,
        ));
        throw new DuplicateKey();
      }
      if (committing) {
        if (error instanceof GraphQLError) {
          throw error;
        }
        broken = !isServerError(error);
        console.error("Commit failed:", (error as Error).message);
        throw commitUnconfirmed("The result of the write is unknown");
      }
      broken = !(await client.query("ROLLBACK").then(
        () => true,
        () => false,
      ));
      if (isServerError(error) && error.code === NOT_PRIMARY) {
        void this.cluster.refresh();
        throw primaryUnavailable("The primary has changed; retry");
      }
      if (!isServerError(error) && !(error instanceof GraphQLError)) {
        console.error(`Write on ${state.primary} failed:`, (error as Error).message);
        throw primaryUnavailable(`Primary ${state.primary} is unreachable`);
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }
}
