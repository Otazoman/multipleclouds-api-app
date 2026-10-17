import { Pool } from "pg";
import { ClusterState } from "../src/cluster";
import { pruneJournal } from "../src/prune";

/**
 * Pool of a node whose cluster state is `state`; its clients delete
 * `batches` rows in turn and record the queries.
 */
const node = (state: { primary: string; epoch: number } | null, batches: number[] = []) => {
  const queries: { text: string; values?: unknown[] }[] = [];
  let released = 0;
  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text: text.trim().split(/\s+/).slice(0, 3).join(" "), values });
      if (text.includes("DELETE")) {
        return { rowCount: batches.shift() ?? 0 };
      }
      return { rows: [] };
    },
    release: () => {
      released += 1;
    },
  };
  const pool = {
    connect: async () => client,
    query: async () => ({
      rows: state ? [{ primary_node: state.primary, epoch: String(state.epoch) }] : [],
    }),
  } as unknown as Pool;
  return { pool, queries, released: () => released };
};

describe("pruneJournal", () => {
  test("deletes in batches on the primary of the highest epoch", async () => {
    const aws = node({ primary: "aws", epoch: 1 });
    const google = node({ primary: "google", epoch: 2 }, [3, 3, 1]);
    const nodes = new Map([
      ["aws", aws.pool],
      ["google", google.pool],
    ]);
    const result = await pruneJournal(new ClusterState(nodes, 60_000), nodes, 30, 3);

    expect(result).toEqual({ deleted: 7, primary: { primary: "google", epoch: 2 } });
    expect(aws.queries).toEqual([]);
    // Three transactions, each checking the epoch before deleting
    expect(google.queries.map((q) => q.text)).toEqual(
      Array(3).fill(["BEGIN", "SELECT ops.assert_primary($1)", "WITH old AS", "COMMIT"]).flat(),
    );
    expect(google.queries[1].values).toEqual([2]);
    expect(google.queries[2].values).toEqual([30, 3]);
    expect(google.released()).toBe(3);
  });

  test("fails without a primary", async () => {
    const nodes = new Map([["aws", node(null).pool]]);
    await expect(pruneJournal(new ClusterState(nodes, 60_000), nodes, 30)).rejects.toThrow(
      "No reachable primary",
    );
  });

  test("rolls back and fails when the node is no longer the primary", async () => {
    const queries: string[] = [];
    const client = {
      query: async (text: string) => {
        queries.push(text);
        if (text.includes("assert_primary")) {
          throw Object.assign(new Error("not the primary"), { code: "MCP01" });
        }
        return { rows: [] };
      },
      release: () => undefined,
    };
    const pool = {
      connect: async () => client,
      query: async () => ({ rows: [{ primary_node: "aws", epoch: "5" }] }),
    } as unknown as Pool;
    const nodes = new Map([["aws", pool]]);
    await expect(pruneJournal(new ClusterState(nodes, 60_000), nodes, 30)).rejects.toThrow(
      "not the primary",
    );
    expect(queries).toEqual(["BEGIN", "SELECT ops.assert_primary($1)", "ROLLBACK"]);
  });
});
