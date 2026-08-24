import { Hono } from "hono";
import {
  collectDogfood,
  formatDogfoodReport,
  getPlan,
  listPlans,
  listTrajectories,
  runExists,
  savePlanHitl,
  viewTrajectory,
  type PlanPatch,
} from "@mendpoint/harness";
import {
  can,
  canMutateSystemCatalog,
  evaluateDogfoodAlerts,
  recentAlerts,
} from "@mendpoint/platform";
import type { ApiEnv } from "./auth.js";

export type PlatformStateRouteOptions = Readonly<{ baseDir?: string }>;

function notFound(requestId: string) {
  return { error: "not_found", requestId };
}

export function createPlatformStateRoutes(
  options: PlatformStateRouteOptions = {},
): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();
  const baseDir = options.baseDir ?? process.cwd();

  routes.get("/alerts", (c) => {
    const principal = c.get("principal");
    if (!principal || principal.tenantId.trim() === "") {
      return c.json({ error: "unauthorized" }, 401);
    }
    const alerts = canMutateSystemCatalog(principal)
      ? recentAlerts(50)
      : recentAlerts(50, { tenantId: principal.tenantId });
    return c.json({ alerts });
  });

  routes.get("/dogfood", (c) => {
    const principal = c.get("principal");
    if (!principal || principal.tenantId.trim() === "") {
      return c.json({ error: "unauthorized" }, 401);
    }
    const scope = { tenantId: principal.tenantId };
    const report = collectDogfood(baseDir, scope);
    evaluateDogfoodAlerts({ ...report, tenantId: principal.tenantId });
    return c.json({ ...report, markdown: formatDogfoodReport(report) });
  });

  routes.get("/trajectories", (c) => {
    const principal = c.get("principal");
    if (!principal || principal.tenantId.trim() === "") {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.json({ runs: listTrajectories(baseDir, { tenantId: principal.tenantId }) });
  });

  routes.get("/trajectories/:runId", (c) => {
    const principal = c.get("principal");
    if (!principal || principal.tenantId.trim() === "") {
      return c.json({ error: "unauthorized" }, 401);
    }
    const runId = c.req.param("runId");
    const scope = { tenantId: principal.tenantId };
    try {
      if (!runExists(baseDir, runId, scope)) {
        return c.json(notFound(c.get("requestId")), 404);
      }
      return c.json({ runId, text: viewTrajectory(baseDir, runId, undefined, scope) });
    } catch {
      return c.json(notFound(c.get("requestId")), 404);
    }
  });

  routes.get("/plans", (c) => {
    const principal = c.get("principal");
    if (!principal || principal.tenantId.trim() === "") {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.json({ plans: listPlans(baseDir, { tenantId: principal.tenantId }) });
  });

  routes.get("/plans/:runId", (c) => {
    const principal = c.get("principal");
    if (!principal || principal.tenantId.trim() === "") {
      return c.json({ error: "unauthorized" }, 401);
    }
    const runId = c.req.param("runId");
    const scope = { tenantId: principal.tenantId };
    try {
      if (!runExists(baseDir, runId, scope)) {
        return c.json(notFound(c.get("requestId")), 404);
      }
    } catch {
      return c.json(notFound(c.get("requestId")), 404);
    }
    try {
      return c.json(getPlan(baseDir, runId, scope));
    } catch (error) {
      console.error("platform_plan_read_failed", error);
      return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
    }
  });

  routes.patch("/plans/:runId", async (c) => {
    const principal = c.get("principal");
    if (!principal || principal.tenantId.trim() === "") {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!can(principal, "plan:edit")) {
      return c.json({ error: "rbac_denied", need: "plan:edit" }, 403);
    }
    const runId = c.req.param("runId");
    const scope = { tenantId: principal.tenantId };
    try {
      if (!runExists(baseDir, runId, scope)) {
        return c.json(notFound(c.get("requestId")), 404);
      }
    } catch {
      return c.json(notFound(c.get("requestId")), 404);
    }
    const patch = await c.req.json<PlanPatch>().catch(() => undefined);
    if (!patch) return c.json({ error: "invalid_json", requestId: c.get("requestId") }, 400);
    try {
      const plan = savePlanHitl(
        baseDir,
        runId,
        patch,
        scope,
      );
      return c.json({ ok: true, plan });
    } catch (error) {
      console.error("platform_plan_patch_failed", error);
      return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
    }
  });

  return routes;
}
