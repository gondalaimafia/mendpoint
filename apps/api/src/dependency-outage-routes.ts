import { Hono } from "hono";
import {
  createDependencyOutageQueue,
  DependencyOutageQueue,
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
  // Constructing the queue provisions its schema. That must never crash the API
  // at boot: a DDL failure or lock timeout here would otherwise propagate out of
  // server assembly and exit the process, which start-fly turns into a stopped
  // machine (a crash-loop). So construction is lazy and guarded — a failure
  // degrades this route to 503 dependency_outage_unavailable and is logged,
  // while the rest of the API (health, every other route) keeps serving. The
  // schema is normally provisioned once by createDb, so in production this
  // construction is a no-op that only reattaches the queue object.
  let queue: DependencyOutageQueue | null = null;
  const ensureQueue = (): DependencyOutageQueue | null => {
    if (queue) return queue;
    try {
      queue = createDependencyOutageQueue(input.db.raw);
      return queue;
    } catch (error) {
      console.error(
        "dependency_outage_schema_unavailable",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  };
  // Attempt construction at assembly time, but never throw out of the factory.
  ensureQueue();
  routes.get("/", (c) => {
    try {
      const principal = c.get("principal");
      if (!principal) return c.json({ error: "authentication_required" }, 401);
      const active = ensureQueue();
      if (!active) return c.json({ error: "dependency_outage_unavailable" }, 503);
      return c.json(active.tenantHealth({
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
