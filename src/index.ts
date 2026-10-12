import { Pool } from "pg";
import { ClusterState, PrimaryWriter } from "./cluster";
import { loadConfig } from "./config";
import { createPool } from "./db";
import { loadModels } from "./models/load";
import { createAppServer, GRAPHQL_PATH } from "./server";

const config = loadConfig();
// Invalid model files stop the container at startup, like invalid settings.
const models = loadModels();
const pool = createPool(config.db);
// Every node's database by node name; writes go to the primary among them.
const nodes = new Map<string, Pool>([
  [config.cloudId, pool],
  ...Object.entries(config.peers).map(
    ([name, db]) => [name, createPool(db)] as const,
  ),
]);
const cluster = new ClusterState(nodes, config.writes.primaryRefreshMs);
const writer = new PrimaryWriter(cluster, nodes, {
  peers: config.writes.ackPeers,
  timeoutMs: config.writes.ackTimeoutMs,
});
const server = createAppServer(
  models,
  pool,
  writer,
  config.cloudId,
  config.graphiql,
);

void cluster.start();
server.listen(config.port, () => {
  console.log(
    `API (${config.cloudId}) listening on :${config.port}${GRAPHQL_PATH}`,
  );
});

// ECS, Cloud Run and Container Apps send SIGTERM before stopping a task /
// instance / replica. Stop accepting requests, then close the pools.
const shutdown = (signal: string): void => {
  console.log(`${signal} received, shutting down`);
  cluster.stop();
  server.close(() => {
    Promise.allSettled([...nodes.values()].map((node) => node.end()))
      .then((results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            console.error("Pool close failed:", (result.reason as Error).message);
          }
        }
      })
      .finally(() => process.exit(0));
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
