import { Pool } from "pg";
import { ClusterState, PrimaryState } from "./cluster";
import { loadConfig } from "./config";
import { createPool } from "./db";

/**
 * `node dist/prune.js`: deletes app.write_journal rows older than
 * JOURNAL_RETENTION_DAYS on the primary; the deletions replicate to the other
 * nodes. Run by the scheduled job of each cloud (the same image and settings
 * as the API); scripts/journal-prune.sh does the same by hand.
 *
 * This is maintenance, not an API write: it does not go through
 * PrimaryWriter and is not journaled itself. Like PrimaryWriter, it writes
 * only on the primary of the highest epoch, checked in each transaction
 * (ops.assert_primary): a deletion on another node would not reach the others.
 */

/** Rows deleted per transaction, so that no transaction holds many locks. */
export const PRUNE_BATCH = 10000;

const DELETE_BATCH = `
  WITH old AS (
    SELECT id FROM app.write_journal
     WHERE committed_at < now() - make_interval(days => $1)
     LIMIT $2
  )
  DELETE FROM app.write_journal j USING old WHERE j.id = old.id`;

/** Deletes old journal rows on the primary; returns the number deleted. */
export const pruneJournal = async (
  cluster: ClusterState,
  nodes: ReadonlyMap<string, Pool>,
  days: number,
  batch: number = PRUNE_BATCH,
): Promise<{ deleted: number; primary: PrimaryState }> => {
  await cluster.refresh();
  const primary = cluster.current();
  const pool = primary && nodes.get(primary.primary);
  if (!primary || !pool) {
    throw new Error("No reachable primary (scripts/switchover.sh)");
  }

  let deleted = 0;
  for (;;) {
    const client = await pool.connect();
    let count: number;
    try {
      await client.query("BEGIN");
      await client.query("SELECT ops.assert_primary($1)", [primary.epoch]);
      count = (await client.query(DELETE_BATCH, [days, batch])).rowCount ?? 0;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    deleted += count;
    if (count < batch) {
      return { deleted, primary };
    }
  }
};

const main = async (): Promise<void> => {
  const config = loadConfig();
  const nodes = new Map<string, Pool>([
    [config.cloudId, createPool(config.db)],
    ...Object.entries(config.peers).map(([name, db]) => [name, createPool(db)] as const),
  ]);
  try {
    const cluster = new ClusterState(nodes, config.writes.primaryRefreshMs);
    const { deleted, primary } = await pruneJournal(
      cluster,
      nodes,
      config.journalRetentionDays,
    );
    console.log(
      `Deleted ${deleted} journal rows older than ${config.journalRetentionDays} days ` +
        `on ${primary.primary} (epoch ${primary.epoch})`,
    );
  } finally {
    await Promise.allSettled([...nodes.values()].map((pool) => pool.end()));
  }
};

if (require.main === module) {
  main().catch((error: Error) => {
    console.error("Journal pruning failed:", error.message);
    process.exitCode = 1;
  });
}
