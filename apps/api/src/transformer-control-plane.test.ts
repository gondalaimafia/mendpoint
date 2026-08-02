import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NODE_RUNTIME_18_TO_20_RECIPE } from "@mendpoint/transformer";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import type { ApiEnv } from "./auth.js";
import {
  registerTransformerControlPlaneRoutes,
  transformerControlPlanePath,
  TransformerCampaignService,
  type TransformerMutationRequest,
} from "./transformer-control-plane.js";

const dirs: string[] = [];
const services: TransformerCampaignService[] = [];

afterEach(() => {
  while (services.length) services.pop()?.close();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function servicePath() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-transformer-api-"));
  dirs.push(dir);
  return join(dir, "control-plane.sqlite");
}

function open(path = servicePath()) {
  const service = new TransformerCampaignService(path);
  services.push(service);
  return service;
}

function request(
  tenantId = "tenant-a",
  idempotencyKey = "request-create",
): TransformerMutationRequest {
  return {
    tenantId,
    actorId: "human:reviewer@example.com",
    requestId: `correlation-${idempotencyKey}`,
    idempotencyKey,
    evidenceRefs: ["evidence:product-spec:node-runtime"],
  };
}

function bundle(name = "Node runtime migration") {
  return {
    campaign: {
      id: "campaign-a",
      name,
      sourceSystem: "node-18",
      targetSystem: "node-20",
      tenantId: "client-controlled-tenant",
    },
    blueprint: {
      id: "blueprint-a",
      objective: "Move the supported runtime to Node 20",
      content: {
        summary: "Upgrade runtime declarations",
        localPath: "C:\\private\\checkout",
        apiToken: "sk_super_secret_value",
        nested: { workspace_path: "/srv/private/repository", safe: "visible" },
      },
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
        verification: { commands: ["npm test", "C:\\private\\verify.ps1"] },
        rollback: {
          strategy: "inverse_operations",
          verificationCommands: ["npm test"],
        },
        approval: {
          required: true,
          reviewerIds: ["human:reviewer@example.com"],
        },
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

function view(value: unknown) {
  return value as {
    campaign: { id: string; state: string; revision: number };
    blueprint: {
      state: string;
      revision: number;
      content: Record<string, unknown>;
      policy: { recipe: { digest: string }; verification: { commands: string[] } };
    };
    bsg: { state: string; revision: number; nodes: Array<{ sourceRefs: string[] }> };
  };
}

function gateConfig(tenantIds = ["tenant-a", "tenant-b"]) {
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

function testApp(
  service: TransformerCampaignService,
  gateRuntime = { rawConfig: gateConfig(), environment: "test" },
) {
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", c.req.header("x-request-id") ?? "request-route");
    const tenantId = c.req.header("x-test-tenant");
    const principalId = c.req.header("x-test-principal");
    if (tenantId && principalId) {
      c.set("principal", { id: principalId, tenantId, role: "owner" });
    }
    await next();
  });
  registerTransformerControlPlaneRoutes(app, service, gateRuntime);
  return app;
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

describe("Transformer campaign service", () => {
  it("persists an exact recipe and source provenance across restart with tenant isolation", () => {
    const path = servicePath();
    const first = open(path);
    const created = view(first.createBundle(request(), bundle()));
    expect(created.blueprint.policy.recipe.digest).toBe(NODE_RUNTIME_18_TO_20_RECIPE.digest);
    expect(created.bsg.nodes[0]?.sourceRefs).toEqual(["spec:runtime-requirement"]);
    first.close();
    services.pop();

    const restarted = open(path);
    const restored = view(restarted.get("tenant-a", "campaign-a"));
    expect(restored).toEqual(created);
    expect(() => restarted.get("tenant-b", "campaign-a")).toThrow("campaign_not_found");
  });

  it("replays identical requests and rejects changed replay and stale revisions", () => {
    const service = open();
    const created = service.createBundle(request(), bundle());
    expect(service.createBundle(request(), bundle())).toEqual(created);
    expect(() => service.createBundle(request(), bundle("Changed campaign"))).toThrow(
      "idempotency_conflict",
    );

    expect(() =>
      service.reviewToReady(request("tenant-a", "review-stale"), "campaign-a", {
        campaign: 1,
        blueprint: 1,
        bsg: 2,
      }),
    ).toThrow("review_revision_conflict");
    expect(view(service.get("tenant-a", "campaign-a"))).toMatchObject({
      campaign: { state: "draft", revision: 1 },
      blueprint: { state: "draft", revision: 1 },
      bsg: { state: "draft", revision: 1 },
    });

    const ready = view(
      service.reviewToReady(request("tenant-a", "review-ready"), "campaign-a", {
        campaign: 1,
        blueprint: 1,
        bsg: 1,
      }),
    );
    expect(ready).toMatchObject({
      campaign: { state: "ready", revision: 2 },
      blueprint: { state: "reviewed", revision: 3 },
      bsg: { state: "locked", revision: 2 },
    });
    expect(
      service.reviewToReady(request("tenant-a", "review-ready"), "campaign-a", {
        campaign: 1,
        blueprint: 1,
        bsg: 1,
      }),
    ).toEqual(ready);
    expect(() =>
      service.transition(request("tenant-a", "stale-transition"), "campaign-a", "running", 1),
    ).toThrow("campaign_revision_conflict");
  });

  it("validates the full bundle before the first durable record", () => {
    const service = open();
    const valid = bundle();
    const invalid = {
      ...valid,
      bsg: {
        ...valid.bsg,
        edges: [{ id: "broken-edge", from: "runtime-declared", to: "missing", kind: "depends_on" }],
      },
    };
    expect(() => service.createBundle(request(), invalid)).toThrow("bsg_edge_0_unknown_node");
    expect(service.store.getCampaign("tenant-a", "campaign-a")).toBeUndefined();
    expect(service.store.getBlueprint("tenant-a", "blueprint-a")).toBeUndefined();
    expect(service.store.getBsg("tenant-a", "bsg-a")).toBeUndefined();
  });

  it("rolls back createBundle when a post-campaign write fails", () => {
    const service = open();
    const failure = vi
      .spyOn(service.store, "createBlueprint")
      .mockImplementationOnce(() => {
        throw new Error("injected_blueprint_failure");
      });
    expect(() => service.createBundle(request(), bundle())).toThrow("injected_blueprint_failure");
    failure.mockRestore();

    expect(service.store.getCampaign("tenant-a", "campaign-a")).toBeUndefined();
    expect(service.store.getBlueprint("tenant-a", "blueprint-a")).toBeUndefined();
    expect(service.store.getBsg("tenant-a", "bsg-a")).toBeUndefined();
    expect(service.events("tenant-a", "campaign-a")).toEqual([]);

    expect(view(service.createBundle(request(), bundle())).campaign.revision).toBe(1);
  });

  it("rolls back reviewToReady when a later transition fails", () => {
    const service = open();
    service.createBundle(request(), bundle());
    const transitionBlueprint = service.store.transitionBlueprint.bind(service.store);
    let transitionCount = 0;
    const failure = vi
      .spyOn(service.store, "transitionBlueprint")
      .mockImplementation((...args: Parameters<typeof service.store.transitionBlueprint>) => {
        transitionCount += 1;
        if (transitionCount === 2) throw new Error("injected_review_failure");
        return transitionBlueprint(...args);
      });

    expect(() =>
      service.reviewToReady(request("tenant-a", "review-fault"), "campaign-a", {
        campaign: 1,
        blueprint: 1,
        bsg: 1,
      }),
    ).toThrow("injected_review_failure");
    failure.mockRestore();

    expect(view(service.get("tenant-a", "campaign-a"))).toMatchObject({
      campaign: { state: "draft", revision: 1 },
      blueprint: { state: "draft", revision: 1 },
      bsg: { state: "draft", revision: 1 },
    });
    expect(service.events("tenant-a", "campaign-a")).toHaveLength(3);

    expect(
      view(
        service.reviewToReady(request("tenant-a", "review-fault"), "campaign-a", {
          campaign: 1,
          blueprint: 1,
          bsg: 1,
        }),
      ).campaign.state,
    ).toBe("ready");
  });

  it("uses MENDPOINT_DATA_DIR by default and honors the database override", () => {
    const cwd = join(tmpdir(), "mendpoint-transformer-path-test");
    const dataRoot = join(cwd, "data-root");
    const override = join(cwd, "state", "transformer.sqlite");
    expect(transformerControlPlanePath({ MENDPOINT_DATA_DIR: dataRoot }, cwd)).toBe(
      join(dataRoot, "transformer-control-plane.sqlite"),
    );
    expect(
      transformerControlPlanePath(
        { MENDPOINT_TRANSFORMER_CONTROL_PLANE_DB: override },
        cwd,
      ),
    ).toBe(override);
  });
});

describe("Transformer campaign routes", () => {
  it("defaults deny and reports the experimental gate without mutating state", async () => {
    const service = open();
    const app = testApp(service, { rawConfig: "", environment: "test" });
    const status = await app.request("/transformer/gate", { headers: mutationHeaders() });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      gate: { allowed: false, reasons: ["transformer_gate_config_missing"], boundary: "ui" },
    });
    const create = await app.request("/transformer/control-plane/campaigns", {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify(bundle()),
    });
    expect(create.status).toBe(403);
    expect(await create.json()).toMatchObject({
      error: "transformer_experimental_gate_denied",
      gate: { allowed: false },
    });
    expect(() => service.get("tenant-a", "campaign-a")).toThrow("campaign_not_found");
  });

  it("denies a tenant not named by the exact gate grant", async () => {
    const app = testApp(open(), { rawConfig: gateConfig(["tenant-a"]), environment: "test" });
    const response = await app.request("/transformer/gate", {
      headers: mutationHeaders({ "x-test-tenant": "tenant-b" }),
    });
    expect(await response.json()).toMatchObject({ gate: { allowed: false, reasons: expect.arrayContaining(["tenant_not_allowed"]) } });
  });

  it("requires authenticated identity and mutation metadata", async () => {
    const app = testApp(open());
    const response = await app.request("/transformer/control-plane/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle()),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthorized" });

    const missingEvidence = await app.request("/transformer/control-plane/campaigns", {
      method: "POST",
      headers: mutationHeaders({ "x-mendpoint-evidence-refs": "" }),
      body: JSON.stringify(bundle()),
    });
    expect(missingEvidence.status).toBe(400);
    expect(await missingEvidence.json()).toMatchObject({ error: "evidence_refs_required" });
  });

  it("attributes mutations, isolates tenants, and never returns paths or secrets", async () => {
    const service = open();
    const app = testApp(service);
    const createdResponse = await app.request("/transformer/control-plane/campaigns", {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify(bundle()),
    });
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get("location")).toBe(
      "/transformer/control-plane/campaigns/campaign-a",
    );
    const createdText = await createdResponse.text();
    expect(createdText).not.toContain("client-controlled-tenant");
    expect(createdText).not.toContain("C:\\\\private");
    expect(createdText).not.toContain("/srv/private");
    expect(createdText).not.toContain("sk_super_secret_value");
    const created = view(JSON.parse(createdText));
    expect(created.blueprint.content).toEqual({
      summary: "Upgrade runtime declarations",
      nested: { safe: "visible" },
    });
    expect(created.blueprint.policy.recipe.digest).toBe(NODE_RUNTIME_18_TO_20_RECIPE.digest);

    const events = service.events("tenant-a", "campaign-a");
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.actorId === "human:reviewer@example.com")).toBe(true);
    expect(events.every((event) => event.correlationId === "request-route")).toBe(true);
    expect(events.every((event) => event.causationId === "request-route")).toBe(true);
    expect(events.every((event) => event.evidenceRefs[0] === "evidence:product-spec:node-runtime")).toBe(true);

    const eventResponse = await app.request(
      "/transformer/control-plane/campaigns/campaign-a/events",
      { headers: mutationHeaders() },
    );
    expect(eventResponse.status).toBe(200);
    const eventText = await eventResponse.text();
    expect(eventText).not.toContain("C:\\\\private");
    expect(eventText).not.toContain("/srv/private");
    expect(eventText).not.toContain("sk_super_secret_value");

    const otherTenant = await app.request(
      "/transformer/control-plane/campaigns/campaign-a",
      { headers: mutationHeaders({ "x-test-tenant": "tenant-b" }) },
    );
    expect(otherTenant.status).toBe(404);
  });

  it("reviews to ready, transitions the campaign, and records exceptions", async () => {
    const app = testApp(open());
    const created = await app.request("/transformer/control-plane/campaigns", {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify(bundle()),
    });
    expect(created.status).toBe(201);

    const reviewed = await app.request(
      "/transformer/control-plane/campaigns/campaign-a/review",
      {
        method: "POST",
        headers: mutationHeaders({ "idempotency-key": "route-review" }),
        body: JSON.stringify({
          expectedCampaignRevision: 1,
          expectedBlueprintRevision: 1,
          expectedBsgRevision: 1,
        }),
      },
    );
    expect(reviewed.status).toBe(200);
    expect(await reviewed.json()).toMatchObject({ campaign: { state: "ready", revision: 2 } });

    const running = await app.request(
      "/transformer/control-plane/campaigns/campaign-a/transitions",
      {
        method: "POST",
        headers: mutationHeaders({ "idempotency-key": "route-running" }),
        body: JSON.stringify({ state: "running", expectedRevision: 2 }),
      },
    );
    expect(running.status).toBe(200);
    expect(await running.json()).toMatchObject({ campaign: { state: "running", revision: 3 } });

    const exception = await app.request(
      "/transformer/control-plane/campaigns/campaign-a/exceptions",
      {
        method: "POST",
        headers: mutationHeaders({ "idempotency-key": "route-exception" }),
        body: JSON.stringify({
          id: "exception-a",
          code: "verification_failed",
          message: "A canary check failed",
        }),
      },
    );
    expect(exception.status).toBe(201);
    expect(await exception.json()).toMatchObject({
      exception: { id: "exception-a", state: "open", revision: 1 },
    });

    const events = await app.request(
      "/transformer/control-plane/campaigns/campaign-a/events",
      { headers: mutationHeaders() },
    );
    expect(events.status).toBe(200);
    const eventBody = await events.json() as { events: Array<{ tenantId: string; campaignId: string }> };
    expect(eventBody.events.length).toBeGreaterThanOrEqual(8);
    expect(eventBody.events.every((event) => event.tenantId === "tenant-a")).toBe(true);
    expect(eventBody.events.every((event) => event.campaignId === "campaign-a")).toBe(true);

    const otherTenantEvents = await app.request(
      "/transformer/control-plane/campaigns/campaign-a/events",
      { headers: mutationHeaders({ "x-test-tenant": "tenant-b" }) },
    );
    expect(otherTenantEvents.status).toBe(404);
  });
});
