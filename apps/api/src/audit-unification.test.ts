import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  listAudit,
  recordAudit,
  verifyAuditIntegrity,
  type AppDb,
} from "@mendpoint/db";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import type { ApiEnv } from "./auth.js";
import {
  registerTransformerControlPlaneRoutes,
  TransformerCampaignService,
  type ControlPlaneAudit,
} from "./transformer-control-plane.js";
import {
  registerPlatformCanaryRoutes,
  type CanaryAudit,
} from "./platform-canary.js";

/**
 * These tests assert the audit unification: ReGauge control-plane actions and
 * deploy rollback decisions — which previously lived only in a separate SQLite
 * log or were never recorded — now reach the single hash-chained audit_events
 * table, and the chain still verifies after those writes (spec 19.8, 31.7).
 */

const dirs: string[] = [];
const services: TransformerCampaignService[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  while (services.length) services.pop()?.close();
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function openDb() {
  const db = createDb(join(tempDir("mendpoint-audit-db-"), "api.sqlite"));
  dbs.push(db);
  return db;
}

function openService() {
  const service = new TransformerCampaignService(
    join(tempDir("mendpoint-audit-cp-"), "control-plane.sqlite"),
  );
  services.push(service);
  return service;
}

/** Mirror of server.ts's requestAudit, bound to a test db. */
function auditSink(db: AppDb): ControlPlaneAudit & CanaryAudit {
  return (c, event) => {
    const principal = c.get("principal");
    if (!principal) throw new Error("authenticated_principal_required");
    recordAudit(db, {
      ...event,
      tenantId: principal.tenantId,
      principalId: c.get("trustPrincipalId") ?? principal.id,
      apiKeyId: c.get("apiKeyId") ?? null,
      requestId: c.get("requestId") ?? null,
    });
  };
}

function gateConfig(tenantIds = ["tenant-a"]) {
  return JSON.stringify({
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantAllowlist: tenantIds,
    environmentAllowlist: ["test"],
    grants: tenantIds.map((tenantId) => ({
      tenantId,
      environment: "test",
      boundaries: ["api_control_plane", "ui"],
      acceptanceEvidenceRefs: ["acceptance:test-contract"],
      productionDeliveryApprovalRefs: [],
    })),
  });
}

function principalMiddleware(app: Hono<ApiEnv>) {
  app.use("*", async (c, next) => {
    c.set("requestId", c.req.header("x-request-id") ?? "request-route");
    const tenantId = c.req.header("x-test-tenant");
    const principalId = c.req.header("x-test-principal");
    if (tenantId && principalId) {
      c.set("principal", { id: principalId, tenantId, role: "owner" });
      c.set("trustPrincipalId", "trust-reviewer-a");
    }
    await next();
  });
}

function mutationHeaders(overrides: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "x-request-id": "request-route",
    "x-test-tenant": "tenant-a",
    "x-test-principal": "human:reviewer@example.com",
    "idempotency-key": "route-create",
    "x-mendpoint-evidence-refs": "evidence:product-spec:node-runtime",
    ...overrides,
  };
}

function bundle() {
  return {
    campaign: {
      id: "campaign-a",
      name: "Node runtime migration",
      sourceSystem: "node-18",
      targetSystem: "node-20",
    },
    blueprint: {
      id: "blueprint-a",
      objective: "Move the supported runtime to Node 20",
      content: { summary: "Upgrade runtime declarations" },
      policy: {
        ownerIds: ["human:owner@example.com"],
        risks: [
          {
            id: "risk-runtime",
            statement: "A dependency may not support Node 20",
            severity: "high",
            ownerId: "human:owner@example.com",
            evidenceRefs: ["evidence:compatibility-matrix"],
          },
        ],
        unknowns: [
          {
            id: "unknown-native-addon",
            question: "Does the native addon publish Node 20 binaries?",
            ownerId: "human:owner@example.com",
            evidenceRefs: ["evidence:dependency-inventory"],
          },
        ],
        verification: { commands: ["npm test"] },
        rollback: { strategy: "inverse_operations", verificationCommands: ["npm test"] },
        approval: { required: true, reviewerIds: ["human:reviewer@example.com"] },
      },
    },
    bsg: {
      id: "bsg-a",
      nodes: [
        {
          id: "runtime-declared",
          kind: "runtime",
          spec: "The declared runtime is Node 20",
          sourceRefs: ["spec:runtime-requirement"],
        },
      ],
      edges: [],
    },
  };
}

describe("audit unification", () => {
  it("records a ReGauge campaign creation, approval, and promotion in the canonical hash-chained audit log", async () => {
    const db = openDb();
    const service = openService();
    const app = new Hono<ApiEnv>();
    principalMiddleware(app);
    registerTransformerControlPlaneRoutes(
      app,
      service,
      { rawConfig: gateConfig(), environment: "test" },
      auditSink(db),
    );

    const created = await app.request("/regauge/control-plane/campaigns", {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify(bundle()),
    });
    expect(created.status).toBe(201);

    const reviewed = await app.request("/regauge/control-plane/campaigns/campaign-a/review", {
      method: "POST",
      headers: mutationHeaders({ "idempotency-key": "route-review" }),
      body: JSON.stringify({
        expectedCampaignRevision: 1,
        expectedBlueprintRevision: 1,
        expectedBsgRevision: 1,
      }),
    });
    expect(reviewed.status).toBe(200);
    expect(await reviewed.json()).toMatchObject({ campaign: { state: "ready" } });

    const events = listAudit(db, "tenant-a");
    const actions = events.map((event) => event.action);
    expect(actions).toContain("regauge.campaign.created");
    expect(actions).toContain("regauge.blueprint.approved");
    expect(actions).toContain("regauge.campaign.promoted");

    const approval = events.find((event) => event.action === "regauge.blueprint.approved");
    expect(approval?.principal_id).toBe("trust-reviewer-a");
    expect(approval?.resource_id).toBe("blueprint-a");
    // Metadata is whitelist-shaped: identifiers only, no blueprint content.
    const metadata = JSON.parse(approval?.metadata_json ?? "{}") as Record<string, unknown>;
    expect(metadata).toEqual({
      campaignId: "campaign-a",
      blueprintId: "blueprint-a",
      subjectType: "blueprint",
    });

    // The chain still verifies after the new writes.
    expect(verifyAuditIntegrity(db, "tenant-a")).toEqual({ ok: true, checked: events.length });
  });

  it("records a rollback decision from the canary endpoint and keeps the chain verifiable", async () => {
    const db = openDb();
    const app = new Hono<ApiEnv>();
    principalMiddleware(app);
    registerPlatformCanaryRoutes(app, auditSink(db));

    // A healthy canary decision is NOT a rollback and records nothing.
    const healthy = await app.request("/platform/canary/evaluate", {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ humanApproved: true }),
    });
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toMatchObject({ action: "canary" });
    expect(listAudit(db, "tenant-a")).toHaveLength(0);

    // An error rate above the max produces a rollback, which IS recorded.
    const rolledBack = await app.request("/platform/canary/evaluate", {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ humanApproved: true, observedErrorRate: 0.5 }),
    });
    expect(rolledBack.status).toBe(200);
    expect(await rolledBack.json()).toMatchObject({ action: "rollback", allowDeploy: false });

    const events = listAudit(db, "tenant-a");
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("deploy.rollback");
    const metadata = JSON.parse(events[0]?.metadata_json ?? "{}") as Record<string, unknown>;
    expect(metadata.action).toBe("rollback");
    expect(metadata.observedErrorRate).toBe(0.5);

    expect(verifyAuditIntegrity(db, "tenant-a")).toEqual({ ok: true, checked: 1 });
  });
});
