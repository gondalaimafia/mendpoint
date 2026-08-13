import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
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

const roots: string[] = [];
const services: TransformerPilotExecutionService[] = [];
afterEach(() => { while (services.length) services.pop()?.close(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const revision = (character: string) => character.repeat(40);
const gate = JSON.stringify({ schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION, tenantAllowlist: ["tenant-a"], environmentAllowlist: ["test"], grants: [{ tenantId: "tenant-a", environment: "test", boundaries: ["api_control_plane", "worker_action", "delivery", "ui"], acceptanceEvidenceRefs: ["acceptance:transformer-pilot:v1"], productionDeliveryApprovalRefs: [] }] });

describe("real Transformer multi-node coordinator", () => {
  it("refuses enabled startup without server-owned gate authority", () => {
    const service = new TransformerPilotExecutionService(":memory:", { rawGateConfig: gate, environment: "test" });
    services.push(service);
    expect(() => createTransformerAttemptCoordinatorRoutes({
      enabled: true,
      store: service.store,
      loadExactSource: () => { throw new Error("must_not_load"); },
    })).toThrow("transformer_gate_config_missing");
  });

  it("runs the actual recipe and verifier through authenticated remote coordinator and exact fenced source", async () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-real-multinode-")); roots.push(root);
    let coordinatorNow = new Date().toISOString();
    const service = new TransformerPilotExecutionService(join(root, "pilot.sqlite"), { rawGateConfig: gate, environment: "test", now: () => coordinatorNow });
    services.push(service);
    const files = { "package.json": '{"engines":{"node":">=18 <19"},"scripts":{"test":"node test.js"}}\n' };
    const applied = applyRecipe(NODE_RUNTIME_18_TO_20_RECIPE, files);
    const snapshotDigest = recipeFilesDigest(files);
    const constraint = createOrganizationConstraintContract({ tenantId: "tenant-a", organizationId: "org-a", version: 1, effectiveAt: "2026-08-12T11:59:00.000Z", sources: [{ id: "policy-a", kind: "explicit_policy", repositoryId: "repo-a", revision: revision("a"), digest: `sha256:${"a".repeat(64)}`, locator: "policy://org-a/repo-a/v1", evidenceRefs: ["evidence:policy:a"] }], rules: [{ id: "allow-a", sourceId: "policy-a", repositoryId: "repo-a", pathPattern: "**", actions: ["change"], effect: "allow", ownerIds: ["owner-a"], rationale: "Approved test scope" }] });
    service.store.createCampaign({ tenantId: "tenant-a", organizationId: "org-a", campaignId: "campaign-a", environment: "test", constraints: constraint, units: [{ id: "unit-a", title: "Migrate node", ownerId: "owner-a", reviewerIds: ["reviewer-a"], dependsOn: [], snapshot: { snapshotId: "snapshot-a", repositoryId: "repo-a", revision: revision("a"), manifestSha256: "a".repeat(64), digest: snapshotDigest, evidenceRefs: ["evidence:snapshot:a"] }, candidateRevision: revision("c"), candidateDigest: applied.outputDigest, recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE), changedPaths: ["package.json"] }], observedAt: "2026-08-12T12:00:00.000Z", evidenceRefs: ["evidence:create"], idempotencyKey: "create-a", gateConfig: gate });
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => { c.set("requestId", "request-real"); c.set("principal", { id: "api-key:worker", tenantId: c.req.header("x-test-tenant") ?? "tenant-a", role: "agent" }); c.set("authScopes", ["transformer:worker"]); await next(); });
    app.route("/v1/transformer/attempt-coordinator", createTransformerAttemptCoordinatorRoutes({
      enabled: true,
      store: service.store,
      now: () => coordinatorNow,
      gateConfig: gate,
      loadExactSource: () => ({ repositoryId: "repo-a", revision: revision("a"), digest: snapshotDigest, files, fileModes: { "package.json": "100644" } }),
      resolveDraftRepository: () => ({ owner: "acme", repo: "repo-a", baseBranch: "main", installationId: 42, remoteRepositoryId: 84 }),
    }));
    let loseCompletionResponse = true;
    let loseDraftCompletionResponse = true;
    const transport: TransformerMultinodeTransport = { request: async ({ path, body }) => {
      const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-test-tenant": "tenant-a" }, body: JSON.stringify(body) });
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
    const runnerConfig: Parameters<typeof createTransformerMultinodeService>[0] = { enabled: true, mode: "checkpoint_required", workerId: "worker-a", tenantId: "tenant-a", campaignId: "campaign-a", environment: "test", evidenceRoot: join(root, "evidence"), candidateRoot: join(root, "candidates"), leaseDurationMs: 3_600_000, executorDigest: `sha256:${"e".repeat(64)}`, encryptionKey: new Uint8Array(32).fill(1), operationSecret: new Uint8Array(32).fill(2), evidenceRefs: ["evidence:runner"], gateConfig: gate, commandRunner: async () => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false, durationMs: 1 }), deliverDraft: async (intent, target) => {
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
        evidenceRefs: ["github:check-run:9:completed:failure"],
      };
    } };
    const runner = createTransformerMultinodeService(runnerConfig, transport, artifactBackend);
    const result = await runner.runOnce();
    expect(result).toMatchObject({ status: "completed" });
    expect(loseCompletionResponse).toBe(false);
    expect(service.store.getCampaign("tenant-a", "campaign-a")?.units[0]).toMatchObject({ candidateDigest: applied.outputDigest });
    await expect(runner.runOnce()).resolves.toMatchObject({ status: "idle" });
    service.store.authorizeCurrentWaveDrafts({ tenantId: "tenant-a", campaignId: "campaign-a", observedAt: coordinatorNow, evidenceRefs: ["evidence:human-review"], idempotencyKey: "authorize-draft-a", gateConfig: gate });
    rmSync(join(root, "candidates"), { recursive: true, force: true });
    await expect(runner.runDeliveryOnce()).rejects.toThrow("simulated_scm_response_loss");
    await expect(runner.runDeliveryOnce()).resolves.toEqual({ status: "idle" });
    coordinatorNow = new Date(Date.parse(coordinatorNow) + 2 * 60 * 60 * 1_000).toISOString();
    const replacement = createTransformerMultinodeService({ ...runnerConfig, workerId: "worker-b" }, transport, artifactBackend);
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
