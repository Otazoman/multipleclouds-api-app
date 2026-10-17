import { loadConfig } from "../src/config";

const base = {
  CLOUD_ID: "aws",
  DB_HOST: "db.internal",
  DB_NAME: "appdb",
  DB_USER: "app_api",
  DB_PASSWORD: "secret",
};

describe("loadConfig", () => {
  test("applies defaults", () => {
    const config = loadConfig(base);
    expect(config.port).toBe(8080);
    expect(config.graphiql).toBe(false);
    expect(config.version).toBe("unknown");
    expect(config.db).toMatchObject({ port: 5432, sslMode: "require", poolMax: 4 });
    expect(config.peers).toEqual({});
    expect(config.writes).toEqual({
      ackPeers: 0,
      ackTimeoutMs: 3000,
      primaryRefreshMs: 5000,
    });
  });

  test("reads the version the image was built from", () => {
    expect(loadConfig({ ...base, APP_VERSION: "0123abc" }).version).toBe("0123abc");
  });

  test("reads peers; their settings default to this cloud's database", () => {
    const config = loadConfig({
      ...base,
      DB_SSLMODE: "disable",
      PEER_NODES: "google, azure",
      DB_GOOGLE_HOST: "google.db",
      DB_GOOGLE_PASSWORD: "g",
      DB_AZURE_HOST: "azure.db",
      DB_AZURE_PASSWORD: "z",
      DB_AZURE_USER: "other",
      DB_AZURE_SSLMODE: "require",
    });
    expect(Object.keys(config.peers)).toEqual(["google", "azure"]);
    expect(config.peers.google).toMatchObject({
      host: "google.db",
      port: 5432,
      database: "appdb",
      user: "app_api",
      password: "g",
      sslMode: "disable",
      poolMax: 3,
    });
    expect(config.peers.azure).toMatchObject({ user: "other", sslMode: "require" });
    expect(
      loadConfig({ ...base, PEER_NODES: "google", DB_GOOGLE_HOST: "h", DB_GOOGLE_PASSWORD: "p", DB_PEER_POOL_MAX: "2" })
        .peers.google.poolMax,
    ).toBe(2);
    expect(config.writes.ackPeers).toBe(1);
  });

  test("rejects invalid peer settings", () => {
    const peer = { PEER_NODES: "google", DB_GOOGLE_HOST: "h", DB_GOOGLE_PASSWORD: "p" };
    expect(() => loadConfig({ ...base, PEER_NODES: "google" })).toThrow(
      "DB_GOOGLE_HOST",
    );
    expect(() => loadConfig({ ...base, ...peer, PEER_NODES: "aws" })).toThrow(
      "PEER_NODES",
    );
    expect(() => loadConfig({ ...base, ...peer, PEER_NODES: "google,google" })).toThrow(
      "PEER_NODES",
    );
    expect(() => loadConfig({ ...base, ...peer, PEER_NODES: "Google" })).toThrow(
      "PEER_NODES",
    );
    expect(() => loadConfig({ ...base, ...peer, WRITE_ACK_PEERS: "2" })).toThrow(
      "WRITE_ACK_PEERS",
    );
    expect(loadConfig({ ...base, ...peer, WRITE_ACK_PEERS: "0" }).writes.ackPeers).toBe(0);
  });

  test.each(["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "CLOUD_ID"])(
    "fails without %s",
    (name) => {
      expect(() => loadConfig({ ...base, [name]: "" })).toThrow(name);
    },
  );

  test("rejects invalid values", () => {
    expect(() => loadConfig({ ...base, CLOUD_ID: "AWS" })).toThrow("CLOUD_ID");
    expect(() => loadConfig({ ...base, DB_SSLMODE: "prefer" })).toThrow("DB_SSLMODE");
    expect(() => loadConfig({ ...base, PORT: "0" })).toThrow("PORT");
  });
});
