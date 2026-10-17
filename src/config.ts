import { readFileSync } from "node:fs";

export type SslMode = "disable" | "require" | "verify-full";

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: SslMode;
  /** CA bundle used when sslMode is "verify-full". */
  sslCa?: string;
  poolMax: number;
}

export interface AppConfig {
  /**
   * Cloud this instance runs on (e.g. "aws"); also this node's name in the
   * cluster. Stored on new rows as the creating cloud.
   */
  cloudId: string;
  /** Commit the image was built from (APP_VERSION, set by the Dockerfile). */
  version: string;
  port: number;
  /** Serves the GraphiQL IDE on /graphql (local development only). */
  graphiql: boolean;
  /** This cloud's database: reads, and writes while it is the primary. */
  db: DbConfig;
  /** The other nodes' databases, by node name; writes go to the primary. */
  peers: Record<string, DbConfig>;
  writes: {
    /** Other nodes that must confirm a commit (0 disables the wait). */
    ackPeers: number;
    ackTimeoutMs: number;
    /** How often the cluster state is read from the nodes. */
    primaryRefreshMs: number;
  };
}

const CLOUD_ID_PATTERN = /^[a-z][a-z0-9]*$/;
const SSL_MODES: readonly SslMode[] = ["disable", "require", "verify-full"];

const DEFAULT_PORT = 8080;
const DEFAULT_DB_PORT = 5432;
// Every instance has a pool per node and every node may be the primary, so
// the primary's connections are about (instances in its cloud x DB_POOL_MAX)
// + (other instances x DB_PEER_POOL_MAX); keep it below max_connections.
const DEFAULT_POOL_MAX = 4;
// Peers get only writes (short, one at a time per connection).
const DEFAULT_PEER_POOL_MAX = 3;
const DEFAULT_ACK_PEERS = 1;
const DEFAULT_ACK_TIMEOUT_MS = 3000;
const DEFAULT_PRIMARY_REFRESH_MS = 5000;

type Env = Record<string, string | undefined>;

const required = (env: Env, name: string): string => {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value;
};

const integer = (
  env: Env,
  name: string,
  fallback: number,
  min = 1,
): number => {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(
      `Environment variable ${name} must be an integer of at least ${min}`,
    );
  }
  return value;
};

const sslModeOf = (env: Env, name: string, fallback: SslMode): SslMode => {
  const sslMode = (env[name] ?? fallback) as SslMode;
  if (!SSL_MODES.includes(sslMode)) {
    throw new Error(
      `Environment variable ${name} must be one of: ${SSL_MODES.join(", ")}`,
    );
  }
  return sslMode;
};

const nodeName = (name: string, value: string): string => {
  if (!CLOUD_ID_PATTERN.test(value)) {
    throw new Error(
      `Environment variable ${name} must list lowercase letters and digits`,
    );
  }
  return value;
};

/**
 * Settings of another node, from DB_<NODE>_*. HOST and PASSWORD are
 * required; the others default to this cloud's database settings, except
 * the pool size (DB_PEER_POOL_MAX).
 */
const peerDb = (env: Env, node: string, local: DbConfig, poolMax: number): DbConfig => {
  const prefix = `DB_${node.toUpperCase()}_`;
  const sslMode = sslModeOf(env, `${prefix}SSLMODE`, local.sslMode);
  const caFile = env[`${prefix}SSL_CA_FILE`];
  return {
    host: required(env, `${prefix}HOST`),
    port: integer(env, `${prefix}PORT`, DEFAULT_DB_PORT),
    database: env[`${prefix}NAME`] || local.database,
    user: env[`${prefix}USER`] || local.user,
    password: required(env, `${prefix}PASSWORD`),
    sslMode,
    sslCa: caFile ? readFileSync(caFile, "utf8") : local.sslCa,
    poolMax,
  };
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

  const sslMode = sslModeOf(env, "DB_SSLMODE", "require");
  const caFile = env.DB_SSL_CA_FILE;
  const db: DbConfig = {
    host: required(env, "DB_HOST"),
    port: integer(env, "DB_PORT", DEFAULT_DB_PORT),
    database: required(env, "DB_NAME"),
    user: required(env, "DB_USER"),
    password: required(env, "DB_PASSWORD"),
    sslMode,
    sslCa: caFile ? readFileSync(caFile, "utf8") : undefined,
    poolMax: integer(env, "DB_POOL_MAX", DEFAULT_POOL_MAX),
  };

  const peerNames = (env.PEER_NODES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .map((name) => nodeName("PEER_NODES", name));
  if (new Set([cloudId, ...peerNames]).size !== peerNames.length + 1) {
    throw new Error(
      "Environment variable PEER_NODES must not repeat a node or include CLOUD_ID",
    );
  }
  const peerPoolMax = integer(env, "DB_PEER_POOL_MAX", DEFAULT_PEER_POOL_MAX);
  const peers: Record<string, DbConfig> = {};
  for (const name of peerNames) {
    peers[name] = peerDb(env, name, db, peerPoolMax);
  }

  const ackPeers = integer(
    env,
    "WRITE_ACK_PEERS",
    Math.min(DEFAULT_ACK_PEERS, peerNames.length),
    0,
  );
  if (ackPeers > peerNames.length) {
    throw new Error(
      "Environment variable WRITE_ACK_PEERS must not exceed the number of PEER_NODES",
    );
  }

  return {
    cloudId,
    version: env.APP_VERSION || "unknown",
    port: integer(env, "PORT", DEFAULT_PORT),
    graphiql: env.GRAPHIQL_ENABLED === "true",
    db,
    peers,
    writes: {
      ackPeers,
      ackTimeoutMs: integer(env, "WRITE_ACK_TIMEOUT_MS", DEFAULT_ACK_TIMEOUT_MS),
      primaryRefreshMs: integer(
        env,
        "PRIMARY_REFRESH_INTERVAL_MS",
        DEFAULT_PRIMARY_REFRESH_MS,
      ),
    },
  };
};
