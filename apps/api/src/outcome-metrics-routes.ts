/**
 * Wave 3b — customer-visible outcome metrics surface.
 *
 * GET / returns the tenant-scoped outcome metrics object (accepted-candidate
 * rate, escaped-regression signal, human-intervention rate, cost per accepted
 * PR, time-to-candidate) alongside the labeled external baseline reference.
 *
 * GET /retrieval-gaps returns the tenant-scoped retrieval context-gap summary:
 * how often a run's required context was CONFIRMED absent (the `retrieval` lesson
 * destination), and for what capability / migration family. This is the read side
 * of the retrieval sink — the consumer that turns that destination from a
 * computed-and-dropped lesson into an operator-visible signal.
 *
 * Consistent with other customer read routes: an authenticated principal is
 * required, results are tenant-scoped to that principal, and the response is
 * no-store (metrics are live and must not be cached by intermediaries).
 */
import { computeOutcomeMetrics, computeRetrievalContextGaps, type AppDb } from "@mendpoint/db";
import { Hono } from "hono";
import type { ApiEnv } from "./auth.js";

export type OutcomeMetricsRoutesOptions = Readonly<{
  db: AppDb;
}>;

export function createOutcomeMetricsRoutes(options: OutcomeMetricsRoutesOptions): Hono<ApiEnv> {
  const { db } = options;
  const routes = new Hono<ApiEnv>({ strict: false });

  routes.get("/", (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    const since = c.req.query("since") ?? null;
    const until = c.req.query("until") ?? null;
    let metrics;
    try {
      metrics = computeOutcomeMetrics(db, { tenantId: principal.tenantId, since, until });
    } catch (error) {
      const code = error instanceof Error ? error.message : "outcome_metrics_invalid";
      if (code === "outcome_since_invalid" || code === "outcome_until_invalid" || code === "outcome_window_invalid") {
        return c.json({ error: code }, 400);
      }
      throw error;
    }
    c.header("Cache-Control", "no-store");
    return c.json(metrics);
  });

  routes.get("/retrieval-gaps", (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    const since = c.req.query("since") ?? null;
    const until = c.req.query("until") ?? null;
    let gaps;
    try {
      gaps = computeRetrievalContextGaps(db, { tenantId: principal.tenantId, since, until });
    } catch (error) {
      const code = error instanceof Error ? error.message : "retrieval_gap_invalid";
      if (
        code === "retrieval_gap_since_invalid" ||
        code === "retrieval_gap_until_invalid" ||
        code === "retrieval_gap_window_invalid"
      ) {
        return c.json({ error: code }, 400);
      }
      throw error;
    }
    c.header("Cache-Control", "no-store");
    return c.json(gaps);
  });

  return routes;
}
