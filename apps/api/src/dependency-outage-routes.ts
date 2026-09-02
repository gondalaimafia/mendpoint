import { Hono } from "hono";
import {
  createDependencyOutageQueue,
  type AppDb,
} from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";

function boundedLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  if (!/^\d+$/.test(raw)) throw new Error("dependency_outage_list_limit_invalid");
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("dependency_outage_list_limit_invalid");
  }
  return limit;
}

export function createDependencyOutageRoutes(input: Readonly<{ db: AppDb }>): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();
  const queue = createDependencyOutageQueue(input.db.raw);
  routes.get("/", (c) => {
    try {
      const principal = c.get("principal");
      if (!principal) return c.json({ error: "authentication_required" }, 401);
      return c.json(queue.tenantHealth({
        tenantId: principal.tenantId,
        limit: boundedLimit(c.req.query("limit")),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "dependency_outage_query_failed";
      if (message === "dependency_outage_list_limit_invalid") {
        return c.json({ error: message }, 400);
      }
      return c.json({ error: "dependency_outage_query_failed" }, 500);
    }
  });
  return routes;
}
