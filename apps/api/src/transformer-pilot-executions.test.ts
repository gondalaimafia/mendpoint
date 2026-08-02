import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  createOrganizationConstraintContract,
  recipeReference,
} from "@mendpoint/transformer";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import type { ApiEnv } from "./auth.js";
import {
  registerTransformerPilotExecutionRoutes,
  TransformerPilotExecutionService,
} from "./transformer-pilot-executions.js";

const roots: string[] = [];
const services: TransformerPilotExecutionService[] = [];

afterEach(() => {
  while (services.length) services.pop()?.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const revision = (character: string) => character.repeat(40);
const digest = (character: string) => `sha256:${character.repeat(64)}`;

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-pilot-api-"));
  roots.push(root);
  return join(root, "pilot.sqlite");
}

function gateConfig(tenants = ["tenant-a", "tenant-b"]): string {
  return JSON.stringify({
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantAllowlist: tenants,
    environmentAllowlist: ["test"],
    grants: tenants.map((tenantId) => ({
      tenantId,
      environment: "test",
      boundaries: ["api_control_plane", "worker_action", "delivery", "ui"],
      acceptanceEvidenceRefs: ["acceptance:transformer-pilot:v1"],
      productionDeliveryApprovalRefs: [],
    })),
  });
}

function clock() {
  let minute = 0;
  return () => `2026-08-02T12:${String(minute++).padStart(2, "0")}:00.000Z`;
}

function open(path: string, rawGateConfig = gateConfig()) {
  const service = new TransformerPilotExecutionService(path, {
    rawGateConfig,
    environment: "test",
    now: clock(),
  });
  services.push(service);
  return service;
}

function close(service: TransformerPilotExecutionService): void {
  service.close();
  const index = services.indexOf(service);
  if (index >= 0) services.splice(index, 1);
}

function app(service: TransformerPilotExecutionService) {
  const instance = new Hono<ApiEnv>();
  instance.use("*", async (c, next) => {
    c.set("requestId", c.req.header("x-request-id") ?? "request-test");
    const tenantId = c.req.header("x-test-tenant");
    const principalId = c.req.header("x-test-principal");
    if (tenantId && principalId) {
      c.set("principal", {
        id: principalId,
        tenantId,
        role: c.req.header("x-test-role") === "agent" ? "agent" : "owner",
      });
      c.set(
        "authScopes",
        c.req.header("x-test-scopes")?.split(",").filter(Boolean) ?? ["*"],
      );
    }
    await next();
  });
  registerTransformerPilotExecutionRoutes(instance, service);
  return instance;
}

function headers(key: string, tenantId = "tenant-a") {
  return {
    "content-type": "application/json",
    "x-request-id": `request-${key}`,
    "x-test-tenant": tenantId,
    "x-test-principal": "human:transformer-owner@example.com",
    "idempotency-key": key,
    "x-mendpoint-evidence-refs": `evidence:api:${key}`,
  };
}

function workerHeaders(key: string, tenantId = "tenant-a") {
  return {
    ...headers(key, tenantId),
    "x-test-principal": "api-key:transformer-worker",
    "x-test-role": "agent",
    "x-test-scopes": "plan:execute,transformer:worker",
  };
}

function constraints(repositoryIds: string[]) {
  return createOrganizationConstraintContract({
    tenantId: "tenant-a",
    organizationId: "organization-a",
    version: 1,
    effectiveAt: "2026-08-02T11:59:00.000Z",
    sources: repositoryIds.map((repositoryId, index) => ({
      id: `policy-${repositoryId}`,
      kind: "explicit_policy" as const,
      repositoryId,
      revision: revision(index === 0 ? "a" : "b"),
      digest: digest(index === 0 ? "a" : "b"),
      locator: `policy://organization-a/${repositoryId}/v1`,
      evidenceRefs: [`evidence:policy:${repositoryId}:v1`],
    })),
    rules: repositoryIds.map((repositoryId) => ({
      id: `allow-${repositoryId}`,
      sourceId: `policy-${repositoryId}`,
      repositoryId,
      pathPattern: "**",
      actions: ["change"] as const,
      effect: "allow" as const,
      ownerIds: [`owner-${repositoryId}`],
      rationale: "Approved pilot scope",
    })),
  });
}

function unit(id: string, repositoryId: string, source: string, candidate: string) {
  return {
    id,
    title: `Migrate ${repositoryId}`,
    ownerId: `owner-${repositoryId}`,
    reviewerIds: [`reviewer-${repositoryId}`],
    dependsOn: [],
    snapshot: {
      repositoryId,
      revision: revision(source),
      digest: digest(source),
      evidenceRefs: [`evidence:snapshot:${repositoryId}`],
    },
    candidateRevision: revision(candidate),
    candidateDigest: digest(candidate),
    recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
    changedPaths: ["package.json"],
  };
}

function campaign(units = [unit("unit-a", "repo-a", "a", "c")]) {
  return {
    organizationId: "organization-a",
    campaignId: "campaign-a",
    constraints: constraints(units.map((candidate) => candidate.snapshot.repositoryId)),
    units,
  };
}

async function post(
  instance: Hono<ApiEnv>,
  path: string,
  key: string,
  body: unknown,
  tenantId = "tenant-a",
) {
  return instance.request(path, {
    method: "POST",
    headers: /\/(?:attempts|observations)(?:\/|$)/.test(path)
      ? workerHeaders(key, tenantId)
      : headers(key, tenantId),
    body: JSON.stringify(body),
  });
}

function completion(unitId: string, token: string, generation: number, source: string, candidate: string) {
  return {
    unitId,
    leaseGeneration: generation,
    leaseToken: token,
    sourceRevision: revision(source),
    sourceDigest: digest(source),
    candidateRevision: revision(candidate),
    candidateDigest: digest(candidate),
    verificationPassed: true,
    actualCostUsd: 0.25,
  };
}

function observation(unitId: string, state: "draft" | "merged", source: string, candidate: string) {
  return {
    unitId,
    state,
    baseRevision: revision(source),
    headRevision: revision(candidate),
    checks: "success",
    checkRevision: revision(candidate),
    approvals: 1,
    approvalRevision: revision(candidate),
    conversationsResolved: true,
    reviewerEditLines: 1,
    legacyItemsRemoved: 2,
    evidenceRefs: [`evidence:scm:${unitId}:${state}`],
  };
}

describe("Transformer pilot execution API", () => {
  it("rejects human plan executors from worker result endpoints", async () => {
    const instance = app(open(databasePath()));
    expect((await post(instance, "/transformer/executions", "create-worker-auth", campaign())).status).toBe(201);
    const denied = await instance.request(
      "/transformer/executions/campaign-a/attempts/claim",
      {
        method: "POST",
        headers: headers("human-claim"),
        body: JSON.stringify({ leaseToken: "lease-token-human-00000001" }),
      },
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      error: "transformer_worker_principal_denied",
    });
  });

  it("defaults deny, requires authenticated identity, and restores exact campaign state after restart", async () => {
    const path = databasePath();
    const deniedService = open(path, "");
    const denied = await post(app(deniedService), "/transformer/executions", "create-denied", campaign());
    expect(denied.status).toBe(403);
    close(deniedService);

    const first = open(path);
    const firstApp = app(first);
    const unauthenticated = await firstApp.request("/transformer/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(campaign()),
    });
    expect(unauthenticated.status).toBe(401);

    const created = await post(firstApp, "/transformer/executions", "create", campaign());
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe("/transformer/executions/campaign-a");
    const createdBody = await created.json() as { revision: number; units: Array<{ snapshot: { revision: string } }> };
    expect(createdBody).toMatchObject({ revision: 1, units: [{ snapshot: { revision: revision("a") } }] });
    close(first);

    const restarted = open(path);
    const restartedApp = app(restarted);
    const restored = await restartedApp.request("/transformer/executions/campaign-a", {
      headers: headers("read-restored"),
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual(createdBody);
    const otherTenant = await restartedApp.request("/transformer/executions/campaign-a", {
      headers: headers("read-other", "tenant-b"),
    });
    expect(otherTenant.status).toBe(404);
  });

  it("admits fenced worker attempts and blocks retry resume until the exception is resolved", async () => {
    const instance = app(open(databasePath()));
    expect((await post(instance, "/transformer/executions", "create", campaign())).status).toBe(201);

    const token = "lease-token-unit-a-00000001";
    const claimed = await post(
      instance,
      "/transformer/executions/campaign-a/attempts/claim",
      "claim-a",
      { leaseToken: token },
    );
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ lease: { unitId: "unit-a", attemptNumber: 1, leaseGeneration: 1 } });

    const crashed = await post(
      instance,
      "/transformer/executions/campaign-a/attempts/crash",
      "crash-a",
      { unitId: "unit-a" },
    );
    const crashedBody = await crashed.json() as { exceptions: Array<{ id: string }>; state: string };
    expect(crashedBody.state).toBe("paused");

    expect((await post(
      instance,
      "/transformer/executions/campaign-a/control",
      "authorize-retry",
      { action: "authorize_retry", unitId: "unit-a" },
    )).status).toBe(200);
    const blocked = await post(
      instance,
      "/transformer/executions/campaign-a/control",
      "resume-blocked",
      { action: "resume" },
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "transformer_pilot_resume_blocked" });

    expect((await post(
      instance,
      "/transformer/executions/campaign-a/control",
      "resolve-crash",
      {
        action: "resolve_exception",
        exceptionId: crashedBody.exceptions[0]!.id,
        resolution: "Replacement worker passed health checks",
      },
    )).status).toBe(200);
    expect((await post(
      instance,
      "/transformer/executions/campaign-a/control",
      "resume",
      { action: "resume" },
    )).status).toBe(200);

    const retry = await post(
      instance,
      "/transformer/executions/campaign-a/attempts/claim",
      "claim-retry",
      { leaseToken: "lease-token-unit-a-00000002" },
    );
    expect(await retry.json()).toMatchObject({ lease: { unitId: "unit-a", attemptNumber: 2, leaseGeneration: 2 } });
  });

  it("persists observed SCM state and a reverse-order rollback plan without performing delivery", async () => {
    const path = databasePath();
    const service = open(path);
    const instance = app(service);
    const units = [
      unit("unit-a", "repo-a", "a", "c"),
      unit("unit-b", "repo-b", "b", "d"),
    ];
    expect((await post(instance, "/transformer/executions", "create", campaign(units))).status).toBe(201);

    for (const [unitId, token, source, candidate] of [
      ["unit-a", "lease-token-unit-a-00000001", "a", "c"],
      ["unit-b", "lease-token-unit-b-00000001", "b", "d"],
    ] as const) {
      const claim = await post(
        instance,
        "/transformer/executions/campaign-a/attempts/claim",
        `claim-${unitId}`,
        { leaseToken: token },
      );
      const lease = await claim.json() as { lease: { leaseGeneration: number } };
      expect((await post(
        instance,
        "/transformer/executions/campaign-a/attempts/complete",
        `complete-${unitId}`,
        completion(unitId, token, lease.lease.leaseGeneration, source, candidate),
      )).status).toBe(200);
    }

    const delivery = await post(
      instance,
      "/transformer/executions/campaign-a/drafts/authorize",
      "authorize-drafts",
      {},
    );
    expect(delivery.status).toBe(200);
    expect(await delivery.json()).toMatchObject({
      delivery: "external",
      actions: [
        { type: "open_draft", draft: true, autoMerge: false, autoDeploy: false },
        { type: "open_draft", draft: true, autoMerge: false, autoDeploy: false },
      ],
    });

    const observed = await post(
      instance,
      "/transformer/executions/campaign-a/observations",
      "observe-partial",
      {
        wave: 1,
        observations: [
          observation("unit-a", "merged", "a", "c"),
          observation("unit-b", "draft", "b", "d"),
        ],
      },
    );
    expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({
      state: "paused",
      units: [{ id: "unit-a", state: "merged" }, { id: "unit-b", state: "accepted" }],
      exceptions: [expect.objectContaining({ code: "partial_wave_merge", state: "open" })],
    });

    const planned = await post(
      instance,
      "/transformer/executions/campaign-a/rollback-plan",
      "plan-rollback",
      {},
    );
    expect(planned.status).toBe(201);
    const plan = await planned.json() as { delivery: string; actions: Array<Record<string, unknown>> };
    expect(plan).toMatchObject({
      delivery: "external",
      actions: [
        { unitId: "unit-b", type: "close_draft", draft: true, autoMerge: false, autoDeploy: false },
        { unitId: "unit-a", type: "open_revert_draft", draft: true, autoMerge: false, autoDeploy: false },
      ],
    });
    close(service);

    const restarted = open(path);
    const persisted = await app(restarted).request(
      "/transformer/executions/campaign-a/rollback-plan",
      { headers: headers("read-rollback") },
    );
    expect(persisted.status).toBe(200);
    expect(await persisted.json()).toEqual(plan);
  });
});
