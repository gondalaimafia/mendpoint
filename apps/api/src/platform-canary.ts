import type { Context, Hono } from "hono";
import { evaluateCanary } from "@mendpoint/platform";
import { recordAudit } from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";

/**
 * Canary / rollback decision route.
 *
 * evaluateCanary is a pure decision function (canary.ts). Before this, a
 * "rollback" decision was returned to the caller and never recorded, so the one
 * migration action spec 19.8 names explicitly — rollback — left no auditable
 * trace. The decision now flows through the SAME canonical audit sink
 * (requestAudit -> recordAudit) as every other route, so rollback decisions are
 * hash-chained and covered by verifyAuditIntegrity.
 *
 * Only generated, non-user-controlled fields reach the append-only export:
 * the decision action, allowDeploy, evaluateCanary's own reason strings, and the
 * numeric observed error rate. No free-form caller input is copied verbatim.
 */
type CanaryAuditEvent = Omit<
  Parameters<typeof recordAudit>[1],
  "tenantId" | "principalId" | "apiKeyId" | "requestId"
>;
export type CanaryAudit = (c: Context<ApiEnv>, event: CanaryAuditEvent) => void;

export function registerPlatformCanaryRoutes(
  app: Hono<ApiEnv>,
  audit?: CanaryAudit,
): void {
  app.post("/platform/canary/evaluate", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      humanApproved?: boolean;
      observedErrorRate?: number;
    };
    const decision = evaluateCanary(body);
    if (decision.action === "rollback") {
      audit?.(c, {
        actor: "platform",
        action: "deploy.rollback",
        resourceType: "deployment",
        resourceId: null,
        metadata: {
          action: decision.action,
          allowDeploy: decision.allowDeploy,
          observedErrorRate:
            typeof body.observedErrorRate === "number" ? body.observedErrorRate : null,
          reasons: decision.reasons,
        },
      });
    }
    return c.json(decision);
  });
}
