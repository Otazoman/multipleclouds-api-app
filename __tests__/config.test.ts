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
    expect(config.db).toMatchObject({ port: 5432, sslMode: "require", poolMax: 10 });
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
