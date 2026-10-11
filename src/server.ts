import { createServer, Server, ServerResponse } from "node:http";
import { createYoga } from "graphql-yoga";
import { Pool } from "pg";
import { GraphQLContext, schema } from "./schema";
import { ItemService } from "./items/service";
import { createPgItemRepository } from "./items/repository";

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
 * - `/readyz`: readiness (the database answers)
 * - `/graphql`: the API
 */
export const createAppServer = (
  pool: Pool,
  cloudId: string,
  graphiql: boolean,
): Server => {
  const items = new ItemService(createPgItemRepository(pool), cloudId);
  const context: GraphQLContext = { items, cloudId };
  const yoga = createYoga({
    schema,
    graphqlEndpoint: GRAPHQL_PATH,
    graphiql,
    context: () => context,
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
