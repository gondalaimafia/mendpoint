import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  applyRecipe,
  createOrganizationConstraintContract,
  recipeFilesDigest,
  recipeReference,
} from "@mendpoint/transformer";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import { createFilesystemTransformerArtifactBackend } from "@mendpoint/worker/transformer-shared-artifact-backends";
import { createTransformerMultinodeService, type TransformerMultinodeTransport } from "@mendpoint/worker/transformer-multinode-service";
import type { ApiEnv } from "./auth.js";
import { TransformerPilotExecutionService } from "./transformer-pilot-executions.js";
import { createTransformerAttemptCoordinatorRoutes } from "./transformer-attempt-coordinator.js";
import { buildDedicatedRegaugeCompletionInput } from "./regauge-verifier-shadow.js";

const roots: string[] = [];
const services: TransformerPilotExecutionService[] = [];
afterEach(() => { while (services.length) services.pop()?.close(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const revision = (character: string) => character.repeat(40);
const draftApproval = "approval:regauge:exact";
const gate = JSON.stringify({ schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION, tenantAllowlist: ["tenant-a"], environmentAllowlist: ["test"], grants: [{ tenantId: "tenant-a", environment: "test", boundaries: ["api_control_plane", "worker_action", "delivery", "ui"], acceptanceEvidenceRefs: ["acceptance:transformer-pilot:v1"], productionDeliveryApprovalRefs: [draftApproval] }] });

describe("real Transformer multi-node coordinator", () => {
  it("exposes only server-produced verifier observations to the authenticated worker scope", async () => {
    const service = new TransformerPilotExecutionService(":memory:", { rawGateConfig: gate, environment: "test" });
    services.push(service);
    const readVerifierObservations = vi.fn(() => [{ telemetryDigest: `sha256:${"a".repeat(64)}` }]);
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", { id: "api-key:worker", tenantId: "tenant-a", role: "agent" });
      c.set("authScopes", ["transformer:worker"]);
      await next();
    });
    app.route("/v1/regauge/attempt-coordinator", createTransformerAttemptCoordinatorRoutes({
      enabled: true, store: service.store, gateConfig: gate,
      readVerifierObservations,
      loadExactSource: () => { throw new Error("must_not_load"); },
    }));
    const response = await app.request("/v1/regauge/attempt-coordinator/verifier-observations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-a", campaignId: "campaign-a" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: [{ telemetryDigest: `sha256:${"a".repeat(64)}` }] });
    expect(readVerifierObservations).toHaveBeenCalledWith({ tenantId: "tenant-a", campaignId: "campaign-a" });
  });

  it("binds draft authorization to server owned campaign, repository, revision, approval, and expiry authority", async () => {
    const service = new TransformerPilotExecutionService(":memory:", {
      rawGateConfig: gate,
      environment: "test",
    });
    services.push(service);
    const authorize = vi.spyOn(service.store, "authorizeCurrentWaveDrafts").mockReturnValue([]);
    const campaign = {
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      environment: "test",
      units: [{
        id: "unit-a",
        state: "executed",
        snapshot: {
          repositoryId: "repository-a",
          snapshotId: "snapshot-a",
          revision: revision("a"),
        },
      }],
    };
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", { id: "api-key:worker", tenantId: "tenant-a", role: "agent" });
      c.set("authScopes", ["transformer:worker"]);
      await next();
    });
    app.route("/v1/regauge/attempt-coordinator", createTransformerAttemptCoordinatorRoutes({
      enabled: true,
      store: service.store,
      now: () => "2026-08-22T05:00:00.000Z",
      gateConfig: gate,
      draftAuthorization: {
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        remoteRepositoryId: 84,
        sourceRevision: revision("a"),
        environment: "test",
        productionApprovalRef: draftApproval,
        activationExpiresAt: "2026-08-22T05:10:00.000Z",
        maximumDrafts: 1,
      },
      loadExactSource: () => { throw new Error("must_not_load"); },
      resolveDraftRepository: () => ({
        owner: "acme",
        repo: "repo-a",
        baseBranch: "main",
        installationId: 42,
        remoteRepositoryId: 84,
      }),
    }));
    vi.spyOn(service.store, "getCampaign").mockReturnValue(campaign as never);
    const request = (campaignId: string, extra: Record<string, unknown> = {}) => app.request(
      `/v1/regauge/attempt-coordinator/operations/authorizeCurrentWaveDrafts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId: "tenant-a",
          campaignId,
          evidenceRefs: ["evidence:runner"],
          idempotencyKey: "regauge-draft-authorize-exact",
          ...extra,
        }),
      },
    );

    expect((await request("campaign-b")).status).toBe(403);
    expect((await request("campaign-a", {
      productionDeliveryApprovalRefs: ["approval:regauge:caller-authored"],
    })).status).toBe(400);
    const accepted = await request("campaign-a");
    expect(accepted.status).toBe(200);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      productionDeliveryApprovalRefs: [draftApproval],
    }));
  });

  it("rejects durable draft authorization after the server owned activation expiry", async () => {
    const service = new TransformerPilotExecutionService(":memory:", {
      rawGateConfig: gate,
      environment: "test",
    });
    services.push(service);
    const authorize = vi.spyOn(service.store, "authorizeCurrentWaveDrafts").mockReturnValue([]);
    vi.spyOn(service.store, "getCampaign").mockReturnValue({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      units: [{ state: "executed", snapshot: {
        repositoryId: "repository-a",
        snapshotId: "snapshot-a",
        revision: revision("a"),
      } }],
    } as never);
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", { id: "api-key:worker", tenantId: "tenant-a", role: "agent" });
      c.set("authScopes", ["transformer:worker"]);
      await next();
    });
    app.route("/v1/regauge/attempt-coordinator", createTransformerAttemptCoordinatorRoutes({
      enabled: true,
      store: service.store,
      now: () => "2026-08-22T05:10:00.000Z",
      gateConfig: gate,
      draftAuthorization: {
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        remoteRepositoryId: 84,
        sourceRevision: revision("a"),
        environment: "test",
        productionApprovalRef: draftApproval,
        activationExpiresAt: "2026-08-22T05:10:00.000Z",
        maximumDrafts: 1,
      },
      loadExactSource: () => { throw new Error("must_not_load"); },
      resolveDraftRepository: () => ({
        owner: "acme",
        repo: "repo-a",
        baseBranch: "main",
        installationId: 42,
        remoteRepositoryId: 84,
      }),
    }));
    const response = await app.request(
      "/v1/regauge/attempt-coordinator/operations/authorizeCurrentWaveDrafts",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId: "tenant-a",
          campaignId: "campaign-a",
          evidenceRefs: ["evidence:runner"],
          idempotencyKey: "regauge-draft-authorize-expired",
        }),
      },
    );
    expect(response.status).toBe(403);
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each([
    ["tomorrow", "malformed"],
    ["2026-08-22T06:31:00.000Z", "longer than the protected window"],
  ])("boots without %s draft authority and refuses authorization", async (activationExpiresAt) => {
    const service = new TransformerPilotExecutionService(":memory:", {
      rawGateConfig: gate,
      environment: "test",
    });
    services.push(service);
    const authorize = vi.spyOn(service.store, "authorizeCurrentWaveDrafts").mockReturnValue([]);
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", { id: "api-key:worker", tenantId: "tenant-a", role: "agent" });
      c.set("authScopes", ["transformer:worker"]);
      await next();
    });
    app.route("/v1/regauge/attempt-coordinator", createTransformerAttemptCoordinatorRoutes({
      enabled: true,
      store: service.store,
      now: () => "2026-08-22T05:00:00.000Z",
      gateConfig: gate,
      draftAuthorization: {
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        remoteRepositoryId: 84,
        sourceRevision: revision("a"),
        environment: "test",
        productionApprovalRef: draftApproval,
        activationExpiresAt,
        maximumDrafts: 1,
      },
      loadExactSource: () => { throw new Error("must_not_load"); },
    }));
    const response = await app.request(
      "/v1/regauge/attempt-coordinator/operations/authorizeCurrentWaveDrafts",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId: "tenant-a",
          campaignId: "campaign-a",
          evidenceRefs: ["evidence:runner"],
          idempotencyKey: "regauge-draft-authorize-invalid",
        }),
      },
    );
    expect(response.status).toBe(403);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("refuses enabled startup without server-owned gate authority", () => {
    const service = new TransformerPilotExecutionService(":memory:", { rawGateConfig: gate, environment: "test" });
    services.push(service);
    expect(() => createTransformerAttemptCoordinatorRoutes({
      enabled: true,
      store: service.store,
      loadExactSource: () => { throw new Error("must_not_load"); },
    })).toThrow("transformer_gate_config_missing");
  });

  it("does not report worker readiness before the exact campaign exists", async () => {
    const service = new TransformerPilotExecutionService(":memory:", { rawGateConfig: gate, environment: "test" });
    services.push(service);
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", { id: "api-key:worker", tenantId: "tenant-a", role: "agent" });
      c.set("authScopes", ["transformer:worker"]);
      await next();
    });
    app.route("/v1/regauge/attempt-coordinator", createTransformerAttemptCoordinatorRoutes({
      enabled: true,
      store: service.store,
      gateConfig: gate,
      loadExactSource: () => { throw new Error("must_not_load"); },
    }));

    const response = await app.request("/v1/regauge/attempt-coordinator/readyz", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-a", campaignId: "campaign-missing" }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "coordinator_campaign_not_ready" });
  });

  it("delivers an authenticated terminal checkpoint after the executor deployment changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-real-multinode-")); roots.push(root);
    let coordinatorNow = "2026-08-12T12:00:00.000Z";
    const service = new TransformerPilotExecutionService(join(root, "pilot.sqlite"), { rawGateConfig: gate, environment: "test", now: () => coordinatorNow });
    services.push(service);
    const files = { "package.json": '{"engines":{"node":">=18 <19"},"scripts":{"test":"node test.js"}}\n' };
    const applied = applyRecipe(NODE_RUNTIME_18_TO_20_RECIPE, files);
    const snapshotDigest = recipeFilesDigest(files);
    const constraint = createOrganizationConstraintContract({ tenantId: "tenant-a", organizationId: "org-a", version: 1, effectiveAt: "2026-08-12T11:59:00.000Z", sources: [{ id: "policy-a", kind: "explicit_policy", repositoryId: "repo-a", revision: revision("a"), digest: `sha256:${"a".repeat(64)}`, locator: "policy://org-a/repo-a/v1", evidenceRefs: ["evidence:policy:a"] }], rules: [{ id: "allow-a", sourceId: "policy-a", repositoryId: "repo-a", pathPattern: "**", actions: ["change"], effect: "allow", ownerIds: ["owner-a"], rationale: "Approved test scope" }] });
    service.store.createCampaign({ tenantId: "tenant-a", organizationId: "org-a", campaignId: "campaign-a", environment: "test", constraints: constraint, units: [{ id: "unit-a", title: "Migrate node", ownerId: "owner-a", reviewerIds: ["reviewer-a"], dependsOn: [], snapshot: { snapshotId: "snapshot-a", repositoryId: "repo-a", revision: revision("a"), manifestSha256: "a".repeat(64), digest: snapshotDigest, evidenceRefs: ["evidence:snapshot:a"] }, candidateRevision: revision("c"), candidateDigest: applied.outputDigest, recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE), changedPaths: ["package.json"] }], observedAt: "2026-08-12T12:00:00.000Z", evidenceRefs: ["evidence:create"], idempotencyKey: "create-a", gateConfig: gate });
    const app = new Hono<ApiEnv>();
    let failFirstAdvisoryDispatch = true;
    const completedObserver = vi.fn(async (completion) => {
      expect(buildDedicatedRegaugeCompletionInput(completion, "mission-regauge-a")).toMatchObject({
        tenantId: "tenant-a",
        missionId: "mission-regauge-a",
        taskId: "campaign-a:unit-a",
        candidateDigest: applied.outputDigest,
        deterministicEvidenceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      if (failFirstAdvisoryDispatch) {
        failFirstAdvisoryDispatch = false;
        throw new Error("simulated_advisory_queue_failure");
      }
      return;
    });
    app.use("*", async (c, next) => { c.set("requestId", "request-real"); c.set("principal", { id: "api-key:worker", tenantId: c.req.header("x-test-tenant") ?? "tenant-a", role: "agent" }); c.set("authScopes", ["transformer:worker"]); await next(); });
    app.route("/v1/regauge/attempt-coordinator", createTransformerAttemptCoordinatorRoutes({
      enabled: true,
      store: service.store,
      now: () => coordinatorNow,
      gateConfig: gate,
      draftAuthorization: {
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        environment: "test",
        remoteRepositoryId: 84,
        sourceRevision: revision("a"),
        productionApprovalRef: draftApproval,
        activationExpiresAt: new Date(Date.parse(coordinatorNow) + 60 * 60_000).toISOString(),
        maximumDrafts: 1,
      },
      verifierAdvisoryScope: { tenantId: "tenant-a", campaignId: "campaign-a" },
      observeCompletedAttempt: completedObserver,
      loadExactSource: () => ({ repositoryId: "repo-a", revision: revision("a"), digest: snapshotDigest, files, fileModes: { "package.json": "100644" } }),
      resolveDraftRepository: () => ({ owner: "acme", repo: "repo-a", baseBranch: "main", installationId: 42, remoteRepositoryId: 84 }),
    }));
    const readyResponse = await app.request("/v1/regauge/attempt-coordinator/readyz", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-tenant": "tenant-a" },
      body: JSON.stringify({ tenantId: "tenant-a", campaignId: "campaign-a" }),
    });
    expect(readyResponse.status).toBe(200);
    let loseCompletionResponse = true;
    let loseDraftCompletionResponse = true;
    const completionHttpStatuses: number[] = [];
    const draftAuthorizationRequests: unknown[] = [];
    const transport: TransformerMultinodeTransport = { request: async ({ path, body }) => {
      if (path.endsWith("authorizeCurrentWaveDrafts")) draftAuthorizationRequests.push(body);
      const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-test-tenant": "tenant-a" }, body: JSON.stringify(body) });
      if (path.endsWith("completeWithHead")) completionHttpStatuses.push(response.status);
      const parsed = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(parsed.error));
      if (path.endsWith("completeWithHead") && loseCompletionResponse) { loseCompletionResponse = false; throw new Error("simulated_response_loss"); }
      if (path.endsWith("completeDraftDelivery") && loseDraftCompletionResponse) { loseDraftCompletionResponse = false; throw new Error("simulated_draft_response_loss"); }
      return parsed;
    } };
    let draftCalls = 0;
    let loseScmResponse = true;
    const draftBranches: string[] = [];
    let observationCalls = 0;
    const artifactBackend = createFilesystemTransformerArtifactBackend({ root: join(root, "artifacts"), maxStoredBytes: 8 * 1024 * 1024 });
    const runnerConfig: Parameters<typeof createTransformerMultinodeService>[0] = { enabled: true, mode: "checkpoint_required", workerId: "worker-a", tenantId: "tenant-a", campaignId: "campaign-a", environment: "test", evidenceRoot: join(root, "evidence"), candidateRoot: join(root, "candidates"), leaseDurationMs: 3_600_000, executorDigest: `sha256:${"e".repeat(64)}`, encryptionKey: new Uint8Array(32).fill(1), operationSecret: new Uint8Array(32).fill(2), evidenceRefs: ["evidence:runner"], gateConfig: gate, now: () => coordinatorNow, commandRunner: async () => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false, durationMs: 1 }), deliverDraft: async (intent, target) => {
      draftCalls += 1;
      draftBranches.push(intent.branch);
      expect(target).toEqual({ owner: "acme", repo: "repo-a", baseBranch: "main", installationId: 42, remoteRepositoryId: 84 });
      expect(intent.files).toEqual([{ path: "package.json", content: expect.stringContaining('"node": ">=20 <21"'), mode: "100644" }]);
      if (loseScmResponse) { loseScmResponse = false; throw new Error("simulated_scm_response_loss"); }
      return { number: 7, url: "https://github.com/acme/repo-a/pull/7", branch: intent.branch, title: intent.title, draft: true, baseBranch: intent.baseBranch, baseSha: intent.expectedBaseSha, commitSha: revision("d") };
    }, observeDraft: async (input, target) => {
      observationCalls += 1;
      expect(target).toEqual({ owner: "acme", repo: "repo-a", baseBranch: "main", installationId: 42, remoteRepositoryId: 84 });
      expect(input).toMatchObject({ pullRequestNumber: 7, expectedBaseSha: revision("a"), expectedHeadSha: revision("d") });
      return {
        state: "draft",
        baseRevision: revision("a"),
        headRevision: revision("d"),
        checks: "failure",
        checkRevision: revision("d"),
        approvals: 0,
        approvalRevision: null,
        conversationsResolved: true,
        failures: [{ kind: "check_run" as const, id: "9", publisherId: 77, name: "unit", state: "failure" as const,
          title: "failed", summary: null, text: null, detailsUrl: null }],
        checkIdentities: ["check:77:unit"],
        checkResults: [{ identity: "check:77:unit", state: "failure" as const }],
        reviewFeedback: { verdict: "none" as const, changeRequests: [], comments: [] },
        evidenceRefs: ["github:check-run:77:9:completed:failure"],
      };
    } };
    const runner = createTransformerMultinodeService(runnerConfig, transport, artifactBackend);
    const result = await runner.runOnce();
    expect(result).toMatchObject({ status: "completed" });
    await vi.waitFor(() => expect(completedObserver).toHaveBeenCalledTimes(2));
    expect(completionHttpStatuses).toEqual([200, 200]);
    expect(failFirstAdvisoryDispatch).toBe(false);
    expect(service.store.listPendingVerifierAdvisoryDispatches("tenant-a", 10)).toHaveLength(1);
    expect(loseCompletionResponse).toBe(false);
    expect(service.store.getCampaign("tenant-a", "campaign-a")?.units[0]).toMatchObject({ candidateDigest: applied.outputDigest });
    await expect(runner.runOnce()).resolves.toMatchObject({ status: "idle" });
    rmSync(join(root, "candidates"), { recursive: true, force: true });
    await expect(runner.runDeliveryOnce()).rejects.toThrow("simulated_scm_response_loss");
    expect(draftAuthorizationRequests).toEqual([
      expect.objectContaining({
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        evidenceRefs: ["evidence:runner"],
        idempotencyKey: expect.stringMatching(/^regauge-draft-authorize-/),
      }),
    ]);
    await expect(runner.runDeliveryOnce()).resolves.toEqual({ status: "idle" });
    coordinatorNow = new Date(Date.parse(coordinatorNow) + 2 * 60 * 60 * 1_000).toISOString();
    const replacement = createTransformerMultinodeService({
      ...runnerConfig,
      workerId: "worker-b",
      executorDigest: `sha256:${"f".repeat(64)}`,
    }, transport, artifactBackend);
    await expect(replacement.runDeliveryOnce()).resolves.toEqual({ status: "delivered", deliveryId: expect.any(String), pullRequestUrl: "https://github.com/acme/repo-a/pull/7", commitSha: revision("d") });
    expect(loseDraftCompletionResponse).toBe(false);
    expect(draftCalls).toBe(2);
    expect(draftBranches[1]).toBe(draftBranches[0]);
    expect(service.store.getCampaign("tenant-a", "campaign-a")?.units[0]?.draftDelivery).toMatchObject({ status: "delivered", pullRequestNumber: 7, commitSha: revision("d") });
    await expect(replacement.runDeliveryOnce()).resolves.toEqual({ status: "idle" });
    expect(draftCalls).toBe(2);
    await expect(replacement.runObservationOnce()).resolves.toEqual({ status: "observed", wave: 1, campaignState: "paused" });
    expect(observationCalls).toBe(1);
    expect(service.store.getCampaign("tenant-a", "campaign-a")).toMatchObject({
      state: "paused",
      exceptions: [expect.objectContaining({ code: "ci_failure", unitId: "unit-a", state: "open" })],
    });
    await expect(replacement.runObservationOnce()).resolves.toEqual({ status: "idle" });
    expect(observationCalls).toBe(1);
  }, 15_000);

  it("denies missing worker auth and tenant mismatch before source loading", async () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-auth-multinode-")); roots.push(root);
    const service = new TransformerPilotExecutionService(join(root, "pilot.sqlite"), { rawGateConfig: gate, environment: "test" }); services.push(service);
    let loaded = false;
    const app = new Hono<ApiEnv>();
    app.route("/v1/transformer/attempt-coordinator", createTransformerAttemptCoordinatorRoutes({ enabled: true, store: service.store, gateConfig: gate, loadExactSource: () => { loaded = true; throw new Error("must_not_load"); } }));
    const response = await app.request("/v1/transformer/attempt-coordinator/source", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantId: "tenant-b", lease: {} }) });
    expect(response.status).toBe(401);
    expect(loaded).toBe(false);
  });

  it("rejects a stale or uncommitted source lease before materialization", async () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-stale-source-")); roots.push(root);
    const service = new TransformerPilotExecutionService(join(root, "pilot.sqlite"), { rawGateConfig: gate, environment: "test" }); services.push(service);
    let loaded = false;
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => { c.set("requestId", "request-stale"); c.set("principal", { id: "api-key:worker", tenantId: "tenant-a", role: "agent" }); c.set("authScopes", ["transformer:worker"]); await next(); });
    app.route("/v1/transformer/attempt-coordinator", createTransformerAttemptCoordinatorRoutes({ enabled: true, store: service.store, gateConfig: gate, loadExactSource: () => { loaded = true; throw new Error("must_not_load"); } }));
    const response = await app.request("/v1/transformer/attempt-coordinator/source", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantId: "tenant-a", leaseToken: "stale-token", lease: { tenantId: "tenant-a", campaignId: "missing-campaign", unitId: "unit-a", leaseGeneration: 1, snapshot: { repositoryId: "repo-a", revision: revision("a"), digest: `sha256:${"a".repeat(64)}` } } }) });
    expect(response.status).toBe(409);
    expect(loaded).toBe(false);
  });
});
