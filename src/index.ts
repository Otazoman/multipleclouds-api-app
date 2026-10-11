import { loadConfig } from "./config";
import { createPool } from "./db";
import { createAppServer, GRAPHQL_PATH } from "./server";

const config = loadConfig();
const pool = createPool(config.db);
const server = createAppServer(pool, config.cloudId, config.graphiql);

server.listen(config.port, () => {
  console.log(
    `API (${config.cloudId}) listening on :${config.port}${GRAPHQL_PATH}`,
  );
});

// ECS, Cloud Run and Container Apps send SIGTERM before stopping a task /
// instance / replica. Stop accepting requests, then close the pool.
const shutdown = (signal: string): void => {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    pool
      .end()
      .catch((error: Error) => console.error("Pool close failed:", error.message))
      .finally(() => process.exit(0));
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
