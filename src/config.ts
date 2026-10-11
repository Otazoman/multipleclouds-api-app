import { readFileSync } from "node:fs";

export type SslMode = "disable" | "require" | "verify-full";

export interface AppConfig {
  /** Cloud this instance runs on (e.g. "aws"). Stored as the row owner. */
  cloudId: string;
  port: number;
  /** Serves the GraphiQL IDE on /graphql (local development only). */
  graphiql: boolean;
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    sslMode: SslMode;
    /** CA bundle used when sslMode is "verify-full". */
    sslCa?: string;
    poolMax: number;
  };
}

const CLOUD_ID_PATTERN = /^[a-z][a-z0-9]*$/;
const SSL_MODES: readonly SslMode[] = ["disable", "require", "verify-full"];

const DEFAULT_PORT = 8080;
const DEFAULT_DB_PORT = 5432;
const DEFAULT_POOL_MAX = 10;

type Env = Record<string, string | undefined>;

const required = (env: Env, name: string): string => {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value;
};

const integer = (env: Env, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return value;
};

/**
 * Reads the configuration from environment variables (see `.env.sample`).
 * Throws on missing or invalid values so that a misconfigured container
 * fails at startup instead of on the first request.
 */
export const loadConfig = (env: Env = process.env): AppConfig => {
  const cloudId = required(env, "CLOUD_ID");
  if (!CLOUD_ID_PATTERN.test(cloudId)) {
    throw new Error(
      "Environment variable CLOUD_ID must be lowercase letters and digits",
    );
  }

  const sslMode = (env.DB_SSLMODE ?? "require") as SslMode;
  if (!SSL_MODES.includes(sslMode)) {
    throw new Error(
      `Environment variable DB_SSLMODE must be one of: ${SSL_MODES.join(", ")}`,
    );
  }
  const caFile = env.DB_SSL_CA_FILE;

  return {
    cloudId,
    port: integer(env, "PORT", DEFAULT_PORT),
    graphiql: env.GRAPHIQL_ENABLED === "true",
    db: {
      host: required(env, "DB_HOST"),
      port: integer(env, "DB_PORT", DEFAULT_DB_PORT),
      database: required(env, "DB_NAME"),
      user: required(env, "DB_USER"),
      password: required(env, "DB_PASSWORD"),
      sslMode,
      sslCa: caFile ? readFileSync(caFile, "utf8") : undefined,
      poolMax: integer(env, "DB_POOL_MAX", DEFAULT_POOL_MAX),
    },
  };
};
