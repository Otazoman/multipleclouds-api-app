import { GraphQLError } from "graphql";
import { Pool } from "pg";
import {
  ClusterState,
  pickPrimary,
  PrimaryWriter,
  WRITE_ERROR_CODES,
  WriteMeta,
} from "../src/cluster";

/** A write with no idempotency key; results are returned as stored. */
const meta = (extra: Partial<WriteMeta<unknown>> = {}): WriteMeta<unknown> => ({
  operation: "op",
  args: { a: 1 },
  revive: (stored) => ({ revived: stored }),
  ...extra,
});

/** pg error returned by the server (has severity and SQLSTATE). */
const serverError = (code: string): Error =>
  Object.assign(new Error(`server error ${code}`), { code, severity: "ERROR" });

type Reply = (text: string) => unknown;

/** Pool whose clients answer queries with `reply` and record them. */
const fakePool = (reply: Reply, state?: { primary: string; epoch: number }) => {
  const queries: string[] = [];
  const released: boolean[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      return reply(text);
    },
    release: (broken?: boolean) => released.push(Boolean(broken)),
  };
  const pool = {
    connect: async () => client,
    query: async () => ({
      rows: state ? [{ primary_node: state.primary, epoch: String(state.epoch) }] : [],
    }),
  } as unknown as Pool;
  return { pool, queries, released };
};

/**
 * Replies for a healthy primary: BEGIN/checks (with `journal` as the rows
 * found for an idempotency key), statements, journal/COMMIT/wait.
 */
const healthy =
  (confirmed = true, journal: object[] = []): Reply =>
  (text) => {
    if (text.startsWith("BEGIN;")) {
      return [{ rows: [] }, { rows: [] }, { rows: journal }];
    }
    if (text.startsWith("INSERT INTO app.write_journal") || text.startsWith("ROLLBACK;")) {
      return [{ rows: [] }, { rows: [] }, { rows: [{ confirmed }] }].slice(
        text.startsWith("ROLLBACK;") ? 1 : 0,
      );
    }
    return { rows: [] };
  };

const code = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraphQLError) {
      return error.extensions.code;
    }
    throw error;
  }
  throw new Error("expected an error");
};

const setup = async (
  reply: Reply,
  ack = { peers: 1, timeoutMs: 3000 },
): Promise<{ writer: PrimaryWriter; queries: string[]; released: boolean[] }> => {
  const primary = fakePool(reply, { primary: "azure", epoch: 3 });
  const nodes = new Map<string, Pool>([
    ["aws", fakePool(healthy(), { primary: "aws", epoch: 2 }).pool],
    ["azure", primary.pool],
  ]);
  const cluster = new ClusterState(nodes, 60_000);
  await cluster.refresh();
  return { writer: new PrimaryWriter(cluster, nodes, ack), ...primary };
};

describe("pickPrimary", () => {
  test("picks the highest epoch", () => {
    expect(
      pickPrimary([
        { primary: "aws", epoch: 1 },
        { primary: "azure", epoch: 2 },
        { primary: "aws", epoch: 1 },
      ]),
    ).toEqual({ primary: "azure", epoch: 2 });
    expect(pickPrimary([])).toBeNull();
  });
});

describe("ClusterState", () => {
  test("follows the highest epoch and never goes back", async () => {
    let epoch = 2;
    const pool = {
      query: async () => ({ rows: [{ primary_node: `n${epoch}`, epoch: String(epoch) }] }),
    } as unknown as Pool;
    const cluster = new ClusterState(new Map([["aws", pool]]), 60_000);
    await cluster.refresh();
    expect(cluster.current()).toEqual({ primary: "n2", epoch: 2 });
    epoch = 1;
    await cluster.refresh();
    expect(cluster.current()).toEqual({ primary: "n2", epoch: 2 });
  });

  test("ignores unreachable nodes", async () => {
    const down = { query: async () => Promise.reject(new Error("timeout")) } as unknown as Pool;
    const up = fakePool(healthy(), { primary: "google", epoch: 4 }).pool;
    const cluster = new ClusterState(new Map([["aws", down], ["google", up]]), 60_000);
    await cluster.refresh();
    expect(cluster.current()).toEqual({ primary: "google", epoch: 4 });
  });
});

describe("PrimaryWriter", () => {
  test("runs the transaction on the primary of the highest epoch", async () => {
    const { writer, queries, released } = await setup(healthy());
    await expect(writer.transaction(meta(), async (db) => {
      await db.query("UPDATE x");
      return "done";
    })).resolves.toBe("done");
    expect(queries).toEqual([
      "BEGIN; SELECT ops.assert_primary(3)",
      "UPDATE x",
      "INSERT INTO app.write_journal (epoch, node, operation, args, result, idempotency_key) " +
        `VALUES (3, 'azure', 'op', '{"a":1}'::jsonb, '"done"'::jsonb, NULL); ` +
        "COMMIT; SELECT ops.wait_for_peers(1, 3000) AS confirmed",
    ]);
    expect(released).toEqual([false]);
  });

  test("an idempotency key already in the journal returns the stored result", async () => {
    const { writer, queries } = await setup(
      healthy(true, [{ operation: "op", args: { a: 1 }, result: "first" }]),
    );
    let ran = false;
    await expect(
      writer.transaction(meta({ idempotencyKey: "k'1" }), async () => {
        ran = true;
      }),
    ).resolves.toEqual({ revived: "first" });
    expect(ran).toBe(false);
    expect(queries).toEqual([
      "BEGIN; SELECT ops.assert_primary(3); SELECT operation, args, result FROM app.write_journal WHERE idempotency_key = 'k''1'",
      "ROLLBACK; SELECT ops.wait_for_peers(1, 3000) AS confirmed",
    ]);
  });

  test("a stored write that is still unconfirmed gets COMMIT_UNCONFIRMED", async () => {
    const { writer } = await setup(
      healthy(false, [{ operation: "op", args: { a: 1 }, result: "first" }]),
    );
    await expect(
      code(writer.transaction(meta({ idempotencyKey: "k" }), async () => undefined)),
    ).resolves.toBe(WRITE_ERROR_CODES.commitUnconfirmed);
  });

  test("an idempotency key reused for another write is rejected", async () => {
    const { writer, queries } = await setup(
      healthy(true, [{ operation: "op", args: { a: 2 }, result: "first" }]),
    );
    await expect(
      code(writer.transaction(meta({ idempotencyKey: "k" }), async () => undefined)),
    ).resolves.toBe(WRITE_ERROR_CODES.idempotencyKeyReused);
    expect(queries[queries.length - 1]).toBe("ROLLBACK");
  });

  test("argument order does not matter for the comparison", async () => {
    const { writer } = await setup(
      healthy(true, [{ operation: "op", args: { b: { y: 1, x: 2 }, a: 1 }, result: 1 }]),
    );
    await expect(
      writer.transaction(
        meta({ idempotencyKey: "k", args: { a: 1, b: { x: 2, y: 1 } } }),
        async () => undefined,
      ),
    ).resolves.toEqual({ revived: 1 });
  });

  test("a concurrent write with the same key wins; the retry returns its result", async () => {
    let attempt = 0;
    const { writer } = await setup((text) => {
      if (text.startsWith("BEGIN;")) {
        attempt++;
        const journal = attempt === 1 ? [] : [{ operation: "op", args: { a: 1 }, result: "theirs" }];
        return [{ rows: [] }, { rows: [] }, { rows: journal }];
      }
      if (text.startsWith("INSERT")) {
        throw Object.assign(serverError("23505"), {
          constraint: "write_journal_idempotency_key_idx",
        });
      }
      if (text.startsWith("ROLLBACK;")) {
        return [{ rows: [] }, { rows: [{ confirmed: true }] }];
      }
      return { rows: [] };
    });
    await expect(
      writer.transaction(meta({ idempotencyKey: "k" }), async () => "mine"),
    ).resolves.toEqual({ revived: "theirs" });
  });

  test("does not wait when no confirmation is required", async () => {
    const { writer, queries } = await setup(healthy(), { peers: 0, timeoutMs: 3000 });
    await writer.transaction(meta(), async () => undefined);
    expect(queries[queries.length - 1]).toMatch(/; COMMIT$/);
  });

  test("unconfirmed commit gets COMMIT_UNCONFIRMED", async () => {
    const { writer } = await setup(healthy(false));
    await expect(code(writer.transaction(meta(), async () => undefined))).resolves.toBe(
      WRITE_ERROR_CODES.commitUnconfirmed,
    );
  });

  test("lost connection while committing gets COMMIT_UNCONFIRMED", async () => {
    const { writer, released } = await setup((text) => {
      if (text.startsWith("INSERT")) {
        throw new Error("Connection terminated unexpectedly");
      }
      return { rows: [] };
    });
    await expect(code(writer.transaction(meta(), async () => undefined))).resolves.toBe(
      WRITE_ERROR_CODES.commitUnconfirmed,
    );
    expect(released).toEqual([true]);
  });

  test("a node that is no longer the primary gets PRIMARY_UNAVAILABLE", async () => {
    const { writer, queries } = await setup((text) => {
      if (text.startsWith("BEGIN;")) {
        throw serverError("MCP01");
      }
      return { rows: [] };
    });
    await expect(code(writer.transaction(meta(), async () => undefined))).resolves.toBe(
      WRITE_ERROR_CODES.primaryUnavailable,
    );
    expect(queries).toContain("ROLLBACK");
  });

  test("errors of the transaction itself roll back and pass through", async () => {
    const { writer, queries, released } = await setup(healthy());
    const failure = new GraphQLError("nope", { extensions: { code: "NOT_FOUND" } });
    await expect(code(writer.transaction(meta(), async () => Promise.reject(failure)))).resolves.toBe(
      "NOT_FOUND",
    );
    expect(queries).toContain("ROLLBACK");
    expect(queries.some((q) => q.startsWith("COMMIT"))).toBe(false);
    expect(released).toEqual([false]);
  });

  test("no known primary gets PRIMARY_UNAVAILABLE", async () => {
    const cluster = new ClusterState(new Map(), 60_000);
    const writer = new PrimaryWriter(cluster, new Map(), { peers: 1, timeoutMs: 1 });
    await expect(code(writer.transaction(meta(), async () => undefined))).resolves.toBe(
      WRITE_ERROR_CODES.primaryUnavailable,
    );
  });

  test("unreachable primary gets PRIMARY_UNAVAILABLE", async () => {
    const down = {
      connect: async () => Promise.reject(new Error("timeout")),
      query: async () => ({ rows: [{ primary_node: "aws", epoch: "1" }] }),
    } as unknown as Pool;
    const nodes = new Map([["aws", down]]);
    const cluster = new ClusterState(nodes, 60_000);
    await cluster.refresh();
    const writer = new PrimaryWriter(cluster, nodes, { peers: 1, timeoutMs: 1 });
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(code(writer.transaction(meta(), async () => undefined))).resolves.toBe(
      WRITE_ERROR_CODES.primaryUnavailable,
    );
  });
});
