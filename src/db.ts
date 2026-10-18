import { Pool, PoolConfig, types } from "pg";
import { DbConfig } from "./config";

// Return DATE columns as "YYYY-MM-DD" strings, as the API does, instead of
// a Date at local midnight.
types.setTypeParser(types.builtins.DATE, (value) => value);

/** An unreachable node (another cloud during an outage) must not stall requests. */
const CONNECT_TIMEOUT_MS = 5000;

const sslOption = (db: DbConfig): PoolConfig["ssl"] => {
  switch (db.sslMode) {
    case "disable":
      return false;
    case "require":
      // Encrypt without verifying the server certificate (libpq "require").
      return { rejectUnauthorized: false };
    case "verify-full":
      return { rejectUnauthorized: true, ca: db.sslCa };
  }
};

/** Creates the connection pool for one node's database. */
export const createPool = (db: DbConfig): Pool => {
  const pool = new Pool({
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.user,
    password: db.password,
    ssl: sslOption(db),
    max: db.poolMax,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  // An idle connection that breaks (e.g. another cloud goes down) is
  // reported here; without a listener it would crash the process.
  pool.on("error", (error) => {
    console.error(`Idle connection to ${db.host} failed:`, error.message);
  });
  return pool;
};
