import { createServer, Server, ServerResponse } from "node:http";
import { createYoga } from "graphql-yoga";
import { Pool } from "pg";
import { PrimaryWriter } from "./cluster";
import { Loaders } from "./data/loaders";
import { QueryRunner } from "./data/queries";
import { createPgRepository } from "./data/repository";
import { EntityService } from "./data/service";
import { ModelDef } from "./models/types";
import { buildSchema, GraphQLContext } from "./schema";

/** Paths answered without GraphQL (load balancer / platform probes). */
const LIVENESS_PATHS = new Set(["/", "/healthz"]);
const READINESS_PATH = "/readyz";
export const GRAPHQL_PATH = "/graphql";

const sendJson = (res: ServerResponse, status: number, body: object): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/**
 * Builds the HTTP server:
 * - `/` and `/healthz`: liveness (the process is up; no DB access)
 * - `/readyz`: readiness (this cloud's database answers; the primary is not
 *   checked, so that reads keep being served while it is down)
 * - `/graphql`: the API
 *
 * `pool` is this cloud's database (reads); writes go through `writer`.
 * The GraphQL API is generated from `models` (models/*.yaml).
 */
export const createAppServer = (
  models: readonly ModelDef[],
  pool: Pool,
  writer: PrimaryWriter,
  cloudId: string,
  graphiql: boolean,
): Server => {
  const services = new Map(
    models.map((model) => [
      model.name,
      new EntityService(
        model,
        createPgRepository(model, pool),
        (meta, fn) =>
          writer.transaction(meta, (client) => fn(createPgRepository(model, client))),
        cloudId,
      ),
    ]),
  );
  const queries = new QueryRunner(pool);
  const yoga = createYoga({
    schema: buildSchema(models),
    graphqlEndpoint: GRAPHQL_PATH,
    graphiql,
    // Loaders batch per request, so each request gets new ones.
    context: (): GraphQLContext => ({
      services,
      queries,
      loaders: new Loaders(services),
      cloudId,
    }),
  });

  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && LIVENESS_PATHS.has(path)) {
      sendJson(res, 200, { status: "ok", cloud: cloudId });
      return;
    }
    if (req.method === "GET" && path === READINESS_PATH) {
      pool
        .query("SELECT 1")
        .then(() => sendJson(res, 200, { status: "ok", cloud: cloudId }))
        .catch((error: Error) => {
          console.error("Readiness check failed:", error.message);
          sendJson(res, 503, { status: "unavailable", cloud: cloudId });
        });
      return;
    }
    void yoga(req, res);
  });
};
