import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "./auth.js";
import { createTransformerMissionRoutes } from "./transformer-mission-routes.js";

function fixture(role: "engineer" | "viewer" = "engineer", trust = true) {
  const plan = vi.fn(() => ({ decision: "planned", blueprint: { id: "blueprint-a" } }));
  const launch = vi.fn(() => ({ campaignId: "mission-a", state: "running" }));
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", { id: "human:issuer|planner", tenantId: "tenant-a", role });
    if (trust) c.set("trustPrincipalId", "principal-planner");
    c.set("requestId", "request-a");
    await next();
  });
  app.route("/transformer/missions", createTransformerMissionRoutes({
    service: { plan, launch } as never,
    now: () => "2026-08-13T16:00:00.000Z",
  }));
  return { app, plan, launch };
}

describe("Transformer mission routes", () => {
  it("derives tenant, actor, campaign, time, and evidence outside the request body", async () => {
    const value = fixture();
    const response = await value.app.request("/transformer/missions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "plan-a" },
      body: JSON.stringify({
        tenantId: "tenant-b",
        campaignId: "attacker-campaign",
        organization: { id: "attacker" },
        repositoryIds: ["repo-a"],
        objective: {
          id: "upgrade-node",
          statement: "Upgrade Node 18 to Node 20.",
          sourceSystem: "node@18",
          targetSystem: "node@20",
          evidenceRefs: ["evidence:objective:a"],
          assumptions: [],
          risks: [],
        },
      }),
    });
    expect(response.status).toBe(201);
    expect(value.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        actorId: "human:issuer|planner",
        requestId: "request-a",
        idempotencyKey: "plan-a",
        evidenceRefs: ["trust-principal:principal-planner", "request:request-a"],
      }),
      expect.objectContaining({
        campaignId: expect.stringMatching(/^mission-[a-f0-9]{32}$/),
        evaluatedAt: "2026-08-13T16:00:00.000Z",
        repositoryIds: ["repo-a"],
      }),
    );
    expect(JSON.stringify(value.plan.mock.calls[0])).not.toContain("tenant-b");
    expect(JSON.stringify(value.plan.mock.calls[0])).not.toContain("attacker-campaign");
  });

  it("requires execute permission, durable identity, and idempotency before mutation", async () => {
    const viewer = fixture("viewer");
    expect((await viewer.app.request("/transformer/missions", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "x" }, body: "{}",
    })).status).toBe(403);
    expect(viewer.plan).not.toHaveBeenCalled();

    const missingTrust = fixture("engineer", false);
    expect((await missingTrust.app.request("/transformer/missions", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "x" }, body: "{}",
    })).status).toBe(401);
    expect(missingTrust.plan).not.toHaveBeenCalled();

    const missingKey = fixture();
    expect((await missingKey.app.request("/transformer/missions", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).status).toBe(400);
    expect(missingKey.plan).not.toHaveBeenCalled();
  });

  it("launches only the tenant scoped reviewed campaign", async () => {
    const value = fixture();
    const response = await value.app.request("/transformer/missions/mission-a/launch", {
      method: "POST",
      headers: { "idempotency-key": "launch-a" },
    });
    expect(response.status).toBe(201);
    expect(value.launch).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a", actorId: "human:issuer|planner" }),
      "mission-a",
    );
  });
});
