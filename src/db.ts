import { Pool, PoolConfig } from "pg";
import { AppConfig } from "./config";

const sslOption = (db: AppConfig["db"]): PoolConfig["ssl"] => {
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

/** Creates the connection pool for this cloud's database. */
export const createPool = (db: AppConfig["db"]): Pool =>
  new Pool({
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.user,
    password: db.password,
    ssl: sslOption(db),
    max: db.poolMax,
  });
