/**
 * S3 — self-serve dashboard + exportable reporting.
 *
 * GET /                 tenant-scoped dashboard object (adoption, outcomes,
 *                       reliability, cost, satisfaction) with its provenance map.
 * GET /export           the same data as CSV (format=csv, default) or JSON
 *                       (format=json), so a customer can pull their own numbers.
 * POST /satisfaction    optional 1-5 developer-satisfaction rating on a reviewed
 *                       run/PR, which is the ONLY source that feeds the
 *                       satisfaction dimension (never fabricated).
 *
 * Consistent with the other customer read routes (see outcome-metrics-routes):
 * an authenticated principal is required, everything is scoped to that
 * principal's tenant, and reads are no-store (metrics are live).
 */
import {
  computeSelfServeDashboard,
  exportSelfServeDashboardCsv,
  recordDeveloperSatisfaction,
  getAgentRun,
  type AppDb,
} from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";
import { Hono } from "hono";
import type { ApiEnv } from "./auth.js";

export type DashboardRoutesOptions = Readonly<{
  db: AppDb;
}>;

const WINDOW_ERRORS = new Set(["dashboard_since_invalid", "dashboard_until_invalid", "dashboard_window_invalid"]);
const SATISFACTION_ERRORS = new Set([
  "developer_satisfaction_rating_invalid",
  "developer_satisfaction_created_at_invalid",
  "developer_satisfaction_id_invalid",
  "developer_satisfaction_tenant_invalid",
]);

export function createDashboardRoutes(options: DashboardRoutesOptions): Hono<ApiEnv> {
  const { db } = options;
  const routes = new Hono<ApiEnv>({ strict: false });

  routes.get("/", (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    const since = c.req.query("since") ?? null;
    const until = c.req.query("until") ?? null;
    let dashboard;
    try {
      dashboard = computeSelfServeDashboard(db, { tenantId: principal.tenantId, since, until });
    } catch (error) {
      const code = error instanceof Error ? error.message : "dashboard_invalid";
      if (WINDOW_ERRORS.has(code)) return c.json({ error: code }, 400);
      throw error;
    }
    c.header("Cache-Control", "no-store");
    return c.json(dashboard);
  });

  routes.get("/export", (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    const since = c.req.query("since") ?? null;
    const until = c.req.query("until") ?? null;
    const format = (c.req.query("format") ?? "csv").toLowerCase();
    let dashboard;
    try {
      dashboard = computeSelfServeDashboard(db, { tenantId: principal.tenantId, since, until });
    } catch (error) {
      const code = error instanceof Error ? error.message : "dashboard_invalid";
      if (WINDOW_ERRORS.has(code)) return c.json({ error: code }, 400);
      throw error;
    }
    c.header("Cache-Control", "no-store");
    if (format === "json") {
      return c.json(dashboard);
    }
    return c.body(exportSelfServeDashboardCsv(dashboard), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="mendpoint-dashboard.csv"',
    });
  });

  routes.post("/satisfaction", async (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    const body = await c.req
      .json<{ rating?: unknown; runId?: unknown; prId?: unknown; comment?: unknown }>()
      .catch(() => ({}) as Record<string, unknown>);
    const rating = body.rating;
    if (typeof rating !== "number") {
      return c.json({ error: "developer_satisfaction_rating_invalid" }, 400);
    }
    const runId = typeof body.runId === "string" && body.runId ? body.runId : null;
    const prId = typeof body.prId === "string" && body.prId ? body.prId : null;
    const comment = typeof body.comment === "string" ? body.comment : null;

    // A run reference, when supplied, must belong to the caller's tenant so a
    // rating can never be attached across tenant boundaries.
    if (runId && !getAgentRun(db, runId, principal.tenantId)) {
      return c.json({ error: "run_not_found" }, 404);
    }

    try {
      const signal = recordDeveloperSatisfaction(db, {
        id: newId(),
        tenantId: principal.tenantId,
        rating,
        runId,
        prId,
        comment,
        submittedBy: principal.id,
        createdAt: nowIso(),
      });
      return c.json(signal, 201);
    } catch (error) {
      const code = error instanceof Error ? error.message : "developer_satisfaction_invalid";
      if (SATISFACTION_ERRORS.has(code)) return c.json({ error: code }, 400);
      throw error;
    }
  });

  return routes;
}
