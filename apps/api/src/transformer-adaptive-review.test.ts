import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  getAdaptiveCandidate,
  getAdaptiveDeliveryByCandidate,
  getAdaptiveRegenerationByCandidate,
  getJob,
  getLearningRecordRedactedContent,
  grantLearningConsent,
  insertPrincipal,
  markAdaptiveRegenerationScheduled,
  recordAdaptiveCandidate,
  type AppDb,
} from "@mendpoint/db";
import {
  createOrganizationConstraintContract,
  discardAdaptiveCandidate,
  NODE_RUNTIME_18_TO_20_RECIPE,
  readAdaptiveCandidateArtifact,
  recipeReference,
  recipeFilesDigest,
  sealAdaptiveCandidate,
  TransformerPilotExecutionStore,
  transformerAttemptId,
  type RecipeFiles,
} from "@mendpoint/transformer";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import { processTransformerAdaptiveRegenerations } from "@mendpoint/worker/transformer-adaptive-regeneration";
import type { ApiEnv } from "./auth.js";
import { registerTransformerAdaptiveReviewRoutes } from "./transformer-adaptive-review.js";

const NOW = "2026-08-06T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];
const pilotStores: TransformerPilotExecutionStore[] = [];
let savedDataDir: string | undefined;

const RECIPE_FILES: RecipeFiles = Object.freeze({
  "package.json": '{\n  "engines": { "node": ">=18" }\n}\n',
  "src/index.ts": "export const value = 1;\n",
});
const CONVERGED_FILES: RecipeFiles = Object.freeze({
  "package.json": '{\n  "engines": { "node": ">=20" }\n}\n',
  "src/index.ts": "export const value = 1;\n",
});

type ActorKey = "human-a" | "human-a2" | "apikey-human-a" | "human-b";

function reviewBody(decision: "approve" | "reject" | "regenerate"): string {
  return JSON.stringify({ decision, rationale: "Verified the exact proposed files" });
}

const IDENTITIES: Record<ActorKey, {
  principal: { id: string; tenantId: string; role: "owner" };
  trustPrincipalId?: string;
  apiKeyId?: string;
}> = {
  "human-a": {
    principal: { id: "human:reviewer@a.com", tenantId: "tenant-a", role: "owner" },
    trustPrincipalId: "trust-human-a",
  },
  "human-a2": {
    principal: { id: "human:reviewer2@a.com", tenantId: "tenant-a", role: "owner" },
    trustPrincipalId: "trust-human-a2",
  },
  "apikey-human-a": {
    principal: { id: "human:reviewer@a.com", tenantId: "tenant-a", role: "owner" },
    trustPrincipalId: "trust-human-a",
    apiKeyId: "api-key-1",
  },
  "human-b": {
    principal: { id: "human:reviewer@b.com", tenantId: "tenant-b", role: "owner" },
    trustPrincipalId: "trust-human-b",
  },
};

function fixture(
  audit: Parameters<typeof registerTransformerAdaptiveReviewRoutes>[2] = () => {},
  regenerationAllowed = true,
  learningEnv?: NodeJS.ProcessEnv,
) {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-adaptive-api-"));
  const dataDir = mkdtempSync(join(tmpdir(), "mendpoint-adaptive-api-data-"));
  process.env.MENDPOINT_DATA_DIR = dataDir;
  const db = createDb(join(directory, "api.sqlite"));
  opened.push({ db, directory });
  opened.push({ db, directory: dataDir });
  db.raw
    .prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?),
              ('tenant-b', 'tenant-b', 'Tenant B', 'team', 'active', 10, ?)`,
    )
    .run(NOW, NOW);
  insertPrincipal(db, {
    id: "trust-human-a",
    tenantId: "tenant-a",
    kind: "human",
    subject: "reviewer@a.com",
    displayName: "Reviewer A",
    createdAt: NOW,
  });
  insertPrincipal(db, {
    id: "trust-human-a2",
    tenantId: "tenant-a",
    kind: "human",
    subject: "reviewer2@a.com",
    displayName: "Reviewer A2",
    createdAt: NOW,
  });
  insertPrincipal(db, {
    id: "trust-human-b",
    tenantId: "tenant-b",
    kind: "human",
    subject: "reviewer@b.com",
    displayName: "Reviewer B",
    createdAt: NOW,
  });

  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const actor = c.req.header("X-Test-Actor") as ActorKey | undefined;
    if (actor && IDENTITIES[actor]) {
      const identity = IDENTITIES[actor];
      c.set("principal", identity.principal);
      c.set("requestId", `request-${actor}`);
      if (identity.trustPrincipalId) c.set("trustPrincipalId", identity.trustPrincipalId);
      if (identity.apiKeyId) c.set("apiKeyId", identity.apiKeyId);
    }
    return next();
  });
  registerTransformerAdaptiveReviewRoutes(app, db, audit, {
    regenerationGate: () => ({
      allowed: regenerationAllowed,
      reasons: regenerationAllowed ? [] : ["tenant_not_allowed"],
    }),
    ...(learningEnv ? { learningEnv } : {}),
  });
  return { app, db };
}

function seedCandidate(
  db: AppDb,
  tenantId: string,
  overrides: {
    files?: RecipeFiles;
    unitId?: string;
    expiresAt?: string;
    reviewTier?: "standard" | "escalated" | "blocked";
  } = {},
): { id: string; sealPath: string; sealSha256: string; candidateDigest: string } {
  const files = overrides.files ?? CONVERGED_FILES;
  const divergedFromDigest = recipeFilesDigest(RECIPE_FILES);
  const candidateDigest = recipeFilesDigest(files);
  const unitId = overrides.unitId ?? "unit-1";
  const seal = sealAdaptiveCandidate({
    tenantId,
    campaignId: "campaign-1",
    unitId,
    attemptId: "tfattempt_abc",
    repositoryId: "repo-1",
    snapshotId: "snapshot-1",
    baseBranch: "main",
    expectedBaseRevision: "e".repeat(40),
    divergedFromDigest,
    candidateDigest,
    failingCommandId: "verify:typecheck",
    changedPaths: ["package.json"],
    files,
    fileModes: Object.freeze(Object.fromEntries(
      Object.keys(files).map((path) => [path, path === "package.json" ? "100755" : "100644"]),
    ) as Record<string, "100644" | "100755">),
    review: {
      schemaVersion: 1,
      edits: [{
        path: "package.json",
        changeType: "modify",
        beforeContent: RECIPE_FILES["package.json"]!,
        beforeDigest: `sha256:${createHash("sha256").update(RECIPE_FILES["package.json"]!).digest("hex")}`,
        beforeMode: "100755",
        afterDigest: `sha256:${createHash("sha256").update(files["package.json"]!).digest("hex")}`,
        afterMode: "100755",
        semanticCategory: "dependencies",
        rationale: "Raise the declared runtime to the verified target.",
        risk: "low",
        confidence: 96,
      }],
      verification: {
        passed: true,
        commandId: "verify:typecheck",
        summary: "The objective verification passed on the sealed candidate.",
        outputDigest: `sha256:${createHash("sha256").update("typecheck passed").digest("hex")}`,
      },
      overallRisk: "low",
      confidence: 96,
    },
  });
  const record = recordAdaptiveCandidate(db, {
    tenantId,
    campaignId: "campaign-1",
    unitId,
    attemptId: "tfattempt_abc",
    repositoryId: "repo-1",
    snapshotId: "snapshot-1",
    baseBranch: "main",
    expectedBaseRevision: "e".repeat(40),
    divergedFromDigest,
    candidateDigest,
    failingCommandId: "verify:typecheck",
    sealedPath: seal.path,
    sealedSha256: seal.sha256,
    changedPaths: ["package.json"],
    ...(overrides.reviewTier ? { reviewTier: overrides.reviewTier } : {}),
    expiresAt: overrides.expiresAt ?? "2099-01-01T00:00:00.000Z",
    now: NOW,
  });
  return { id: record.id, sealPath: seal.path, sealSha256: seal.sha256, candidateDigest };
}

beforeEach(() => {
  savedDataDir = process.env.MENDPOINT_DATA_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedDataDir === undefined) delete process.env.MENDPOINT_DATA_DIR;
  else process.env.MENDPOINT_DATA_DIR = savedDataDir;
  while (pilotStores.length) pilotStores.pop()?.close();
  while (opened.length) {
    const entry = opened.pop();
    if (entry) {
      try {
        entry.db.raw.close();
      } catch {
        /* ignore double close */
      }
      try {
        rmSync(entry.directory, { recursive: true, force: true });
      } catch {
        /* ignore Windows lock races */
      }
    }
  }
});

describe("transformer adaptive candidate review routes", () => {
  it("sanitizes an unmapped database failure during review", async () => {
    const sentinel = "SQLITE_BUSY at C:\\customers\\acme\\adaptive-private.sqlite";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, db } = fixture(() => { throw new Error(sentinel); });
    const seeded = seedCandidate(db, "tenant-a");

    const response = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Test-Actor": "human-a",
      },
      body: reviewBody("reject"),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "internal_error",
      requestId: "request-human-a",
    });
    expect(log.mock.calls.flat().join(" ")).not.toContain(sentinel);
  });

  it("lets a direct human approve and states the divergence explicitly", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    const res = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("approved");
    expect(body.kind).toBe("adaptive");
    expect(body.divergedFromDigest).toBe(recipeFilesDigest(RECIPE_FILES));
    expect(String(body.statement)).toContain("diverged from the approved recipe output");
    expect(String(body.statement)).toContain(recipeFilesDigest(RECIPE_FILES));
    expect(String(body.statement)).toContain("verify:typecheck");
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)).toMatchObject({
      status: "approved",
      reviewRationale: "Verified the exact proposed files",
    });
    const delivery = getAdaptiveDeliveryByCandidate(db, "tenant-a", seeded.id);
    expect(delivery).toMatchObject({
      status: "delivery_pending",
      repositoryId: "repo-1",
      snapshotId: "snapshot-1",
      baseBranch: "main",
      expectedBaseRevision: "e".repeat(40),
    });
    expect(getJob(db, delivery!.jobId)).toMatchObject({
      type: "transformer.adaptive.deliver",
      status: "pending",
    });
    const detailRes = await app.request(`/transformer/adaptive-candidates/${seeded.id}`, {
      headers: { "X-Test-Actor": "human-a" },
    });
    expect(detailRes.status).toBe(200);
    expect(await detailRes.json()).toMatchObject({
      status: "approved",
      delivery: {
        id: delivery!.id,
        status: "delivery_pending",
        jobId: delivery!.jobId,
      },
    });
  });

  it("surfaces the standard tier by default and keeps single-approval delivery unchanged", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    const detailRes = await app.request(`/transformer/adaptive-candidates/${seeded.id}`, {
      headers: { "X-Test-Actor": "human-a" },
    });
    expect(await detailRes.json()).toMatchObject({
      reviewTier: "standard",
      escalationSignOffRequired: false,
    });
    const res = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    expect(res.status).toBe(202);
    expect((await res.json())).toMatchObject({ status: "approved", reviewTier: "standard" });
    expect(getAdaptiveDeliveryByCandidate(db, "tenant-a", seeded.id)?.status).toBe(
      "delivery_pending",
    );
  });

  it("escalated: refuses a single standard approval until a distinct second human signs off", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a", { reviewTier: "escalated" });

    // A single approval is refused; nothing is delivered and review stays open.
    const refused = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: "transformer_adaptive_candidate_escalation_required",
    });
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("review_pending");
    expect(getAdaptiveDeliveryByCandidate(db, "tenant-a", seeded.id)).toBeUndefined();

    // The escalation sign-off requires a direct human, never an API key.
    const apiKeySignoff = await app.request(
      `/transformer/adaptive-candidates/${seeded.id}/escalation-sign-off`,
      {
        method: "POST",
        headers: { "X-Test-Actor": "apikey-human-a", "content-type": "application/json" },
        body: JSON.stringify({ rationale: "Second sign-off attempt via API key." }),
      },
    );
    expect(apiKeySignoff.status).toBe(403);

    // A second, distinct human records the escalation sign-off (no approval yet).
    const signoff = await app.request(
      `/transformer/adaptive-candidates/${seeded.id}/escalation-sign-off`,
      {
        method: "POST",
        headers: { "X-Test-Actor": "human-a2", "content-type": "application/json" },
        body: JSON.stringify({ rationale: "Senior review: the high-risk change is safe." }),
      },
    );
    expect(signoff.status).toBe(200);
    expect(await signoff.json()).toMatchObject({
      status: "review_pending",
      reviewTier: "escalated",
      escalationReviewerPrincipalId: "human:reviewer2@a.com",
    });
    expect(getAdaptiveDeliveryByCandidate(db, "tenant-a", seeded.id)).toBeUndefined();

    // The signer cannot also be the approver: two distinct humans are required.
    const selfApprove = await app.request(
      `/transformer/adaptive-candidates/${seeded.id}/review`,
      {
        method: "POST",
        headers: { "X-Test-Actor": "human-a2", "content-type": "application/json" },
        body: reviewBody("approve"),
      },
    );
    expect(selfApprove.status).toBe(409);
    expect(await selfApprove.json()).toMatchObject({
      error: "transformer_adaptive_candidate_escalation_required",
    });

    // A distinct approver finalizes through the unchanged standard path.
    const approve = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    expect(approve.status).toBe(202);
    expect(await approve.json()).toMatchObject({ status: "approved", reviewTier: "escalated" });
    expect(getAdaptiveDeliveryByCandidate(db, "tenant-a", seeded.id)?.status).toBe(
      "delivery_pending",
    );
  });

  it("blocked: cannot be approved and never enqueues a delivery, but can be rejected", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a", { reviewTier: "blocked" });

    const blocked = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: "transformer_adaptive_candidate_blocked",
    });
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("review_pending");
    expect(getAdaptiveDeliveryByCandidate(db, "tenant-a", seeded.id)).toBeUndefined();

    // A blocked candidate can still be rejected (a rejection delivers nothing).
    const rejected = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("reject"),
    });
    expect(rejected.status).toBe(200);
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("rejected");
  });

  it("records an attributed regeneration request while retaining immutable evidence", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    const response = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: JSON.stringify({
        decision: "regenerate",
        rationale: "Preserve behavior and use a safer dependency transition.",
      }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "superseded",
      reviewDecision: "regenerate",
      reviewerPrincipalId: "human:reviewer@a.com",
      reviewRationale: "Preserve behavior and use a safer dependency transition.",
      generation: 1,
      regeneration: {
        status: "pending",
        reviewerPrincipalId: "human:reviewer@a.com",
        rationale: "Preserve behavior and use a safer dependency transition.",
        externalProcessingAuthorizationRequired: true,
        authorizationMessage: "Explicit customer authorization is required before review feedback can be sent to the configured model.",
      },
      statement: "Regeneration request recorded. Explicit customer authorization is required before review feedback can be sent to the configured model.",
    });
    expect(readAdaptiveCandidateArtifact({
      tenantId: "tenant-a",
      path: seeded.sealPath,
      sha256: seeded.sealSha256,
    }).candidateDigest).toBe(seeded.candidateDigest);

    const list = await app.request("/transformer/adaptive-candidates", {
      headers: { "X-Test-Actor": "human-a" },
    });
    expect(await list.json()).toMatchObject({
      attention: [],
      history: [{
        id: seeded.id,
        status: "superseded",
        reviewDecision: "regenerate",
        regeneration: {
          status: "pending",
          externalProcessingAuthorizationRequired: true,
        },
      }],
    });
  });

  it("carries an API regeneration through the pilot state into a linked successor", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    const store = new TransformerPilotExecutionStore();
    pilotStores.push(store);
    const gateConfig = JSON.stringify({
      schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
      tenantAllowlist: ["tenant-a"],
      environmentAllowlist: ["staging"],
      grants: [{
        tenantId: "tenant-a",
        environment: "staging",
        boundaries: ["worker_action", "delivery"],
        acceptanceEvidenceRefs: ["acceptance:regeneration:v1"],
        productionDeliveryApprovalRefs: [],
      }],
    });
    const constraints = createOrganizationConstraintContract({
      tenantId: "tenant-a",
      organizationId: "organization-a",
      version: 1,
      effectiveAt: "2026-08-06T11:59:00.000Z",
      sources: [{
        id: "policy-repo-1",
        kind: "explicit_policy",
        repositoryId: "repo-1",
        revision: "a".repeat(40),
        digest: `sha256:${"a".repeat(64)}`,
        locator: "policy://organization-a/repo-1/v1",
        evidenceRefs: ["evidence://policy/repo-1/v1"],
      }],
      rules: [{
        id: "allow-repo-1",
        sourceId: "policy-repo-1",
        repositoryId: "repo-1",
        pathPattern: "**",
        actions: ["change"],
        effect: "allow",
        ownerIds: ["owner-repo-1"],
        rationale: "Approved migration scope",
      }],
    });
    store.createCampaign({
      tenantId: "tenant-a",
      organizationId: "organization-a",
      environment: "staging",
      campaignId: "campaign-1",
      constraints,
      units: [{
        id: "unit-1",
        title: "Migrate repo-1",
        ownerId: "owner-repo-1",
        reviewerIds: ["reviewer-repo-1"],
        dependsOn: [],
        snapshot: {
          snapshotId: "snapshot-1",
          repositoryId: "repo-1",
          revision: "e".repeat(40),
          manifestSha256: "a".repeat(64),
          digest: `sha256:${"a".repeat(64)}`,
          evidenceRefs: ["evidence://snapshot/repo-1"],
        },
        candidateRevision: "f".repeat(40),
        candidateDigest: recipeFilesDigest(RECIPE_FILES),
        recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
        changedPaths: ["package.json"],
      }],
      observedAt: "2026-08-06T12:00:00.000Z",
      evidenceRefs: ["evidence://campaign/approved"],
      idempotencyKey: "create-campaign-1",
      gateConfig,
    });
    const leaseToken = "regeneration-original-lease-token";
    const originalLease = store.claimNextAttempt({
      tenantId: "tenant-a",
      campaignId: "campaign-1",
      observedAt: "2026-08-06T12:01:00.000Z",
      evidenceRefs: ["evidence://attempt/original"],
      idempotencyKey: "claim-original",
      leaseToken,
      leaseDurationMs: 3_600_000,
      gateConfig,
    })!;
    store.recordAdaptiveCandidateHandoff({
      tenantId: "tenant-a",
      campaignId: "campaign-1",
      unitId: "unit-1",
      attemptId: transformerAttemptId(originalLease),
      attemptNumber: originalLease.attemptNumber,
      leaseGeneration: originalLease.leaseGeneration,
      leaseToken,
      repositoryId: "repo-1",
      snapshotId: "snapshot-1",
      baseBranch: "main",
      expectedBaseRevision: "e".repeat(40),
      divergedFromDigest: recipeFilesDigest(RECIPE_FILES),
      candidateDigest: seeded.candidateDigest,
      failingCommandId: "verify:typecheck",
      changedPaths: ["package.json"],
      fileModes: { "package.json": "100755" },
      sealedPath: seeded.sealPath,
      sealedSha256: seeded.sealSha256,
      expiresAt: "2099-01-01T00:00:00.000Z",
      observedAt: "2026-08-06T12:01:30.000Z",
      evidenceRefs: ["evidence://candidate/original"],
      idempotencyKey: "handoff-original",
      gateConfig,
    });
    store.markAdaptiveCandidateHandoffImported({
      tenantId: "tenant-a",
      campaignId: "campaign-1",
      unitId: "unit-1",
      attemptId: transformerAttemptId(originalLease),
      candidateId: seeded.id,
      sealedSha256: seeded.sealSha256,
      observedAt: "2026-08-06T12:01:40.000Z",
      evidenceRefs: ["evidence://candidate/imported"],
      idempotencyKey: "handoff-original-imported",
      gateConfig,
    });
    store.recordAttemptFailure({
      tenantId: "tenant-a",
      campaignId: "campaign-1",
      unitId: "unit-1",
      leaseGeneration: originalLease.leaseGeneration,
      leaseToken,
      code: "worker_crash",
      errorCode: "transformer_worker_crashed_after_candidate_import",
      accounting: {
        plannerCalls: 1,
        modelCalls: 1,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        actualCostUsd: 0.001,
        wallTimeMs: 1_000,
      },
      observedAt: "2026-08-06T12:02:00.000Z",
      evidenceRefs: ["evidence://attempt/failed"],
      idempotencyKey: "fail-original",
      gateConfig,
    });

    const rationale = "Preserve behavior and use a safer dependency transition with the existing scripts unchanged.";
    const response = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: JSON.stringify({ decision: "regenerate", rationale }),
    });
    expect(response.status).toBe(202);
    const regeneration = getAdaptiveRegenerationByCandidate(db, "tenant-a", seeded.id)!;
    const scheduledAt = new Date(Date.parse(regeneration.requestedAt) + 1_000).toISOString();

    const pilotBeforeReconciliation = store.getCampaign("tenant-a", "campaign-1")!;
    expect(processTransformerAdaptiveRegenerations(db, store, { observedAt: scheduledAt }))
      .toEqual({ considered: 1, blocked: 1, indeterminate: 0, scheduled: 0, failed: 0, errors: [] });
    expect(processTransformerAdaptiveRegenerations(db, store, {
      observedAt: new Date(Date.parse(scheduledAt) + 500).toISOString(),
    })).toEqual({ considered: 1, blocked: 1, indeterminate: 0, scheduled: 0, failed: 0, errors: [] });
    expect(store.getCampaign("tenant-a", "campaign-1")).toEqual(pilotBeforeReconciliation);
    expect(getAdaptiveRegenerationByCandidate(db, "tenant-a", seeded.id)).toMatchObject({
      status: "pending",
      attemptCount: 0,
      lastErrorCode: "external_processing_authorization_required",
    });

    const originatingException = pilotBeforeReconciliation.exceptions.find(
      (exception) => exception.state === "open" && exception.unitId === "unit-1",
    )!;
    expect(originatingException.code).toBe("worker_crash");
    expect(() => store.control({
      tenantId: "tenant-a",
      campaignId: "campaign-1",
      observedAt: regeneration.requestedAt,
      evidenceRefs: [`transformer-adaptive-candidate:${seeded.id}`],
      idempotencyKey: `${regeneration.id}:wrong-exception`,
      action: "authorize_regeneration",
      unitId: "unit-1",
      exceptionId: "exception-9999",
      candidateId: seeded.id,
      reviewerPrincipalId: "human:reviewer@a.com",
      rationale,
      rationaleDigest: regeneration.rationaleDigest,
    })).toThrow("transformer_pilot_regeneration_exception_missing");
    expect(store.getCampaign("tenant-a", "campaign-1")).toEqual(pilotBeforeReconciliation);
    const resumed = store.control({
      tenantId: "tenant-a",
      campaignId: "campaign-1",
      observedAt: regeneration.requestedAt,
      evidenceRefs: [
        `transformer-adaptive-candidate:${seeded.id}`,
        `transformer-adaptive-review:${regeneration.rationaleDigest}`,
        "reviewer:human:reviewer@a.com",
      ],
      idempotencyKey: regeneration.id,
      action: "authorize_regeneration",
      unitId: "unit-1",
      exceptionId: originatingException.id,
      candidateId: seeded.id,
      reviewerPrincipalId: "human:reviewer@a.com",
      rationale,
      rationaleDigest: regeneration.rationaleDigest,
    });
    markAdaptiveRegenerationScheduled(db, {
      tenantId: "tenant-a",
      id: regeneration.id,
      observedAt: scheduledAt,
    });
    expect(resumed.state).toBe("running");
    expect(resumed.exceptions).toEqual([
      expect.objectContaining({ unitId: "unit-1", state: "resolved", resolution: rationale }),
    ]);
    expect(resumed.units[0]).toMatchObject({
      retryAuthorized: true,
      adaptiveCandidateHandoffHistory: [expect.objectContaining({ sealedSha256: seeded.sealSha256 })],
      regenerationReview: expect.objectContaining({
        candidateId: seeded.id,
        reviewerPrincipalId: "human:reviewer@a.com",
        rationale,
        rationaleDigest: regeneration.rationaleDigest,
      }),
    });
    expect("adaptiveCandidateHandoff" in resumed.units[0]!).toBe(false);
    const replayed = store.control({
      tenantId: "tenant-a",
      campaignId: "campaign-1",
      observedAt: regeneration.requestedAt,
      evidenceRefs: [
        `transformer-adaptive-candidate:${seeded.id}`,
        `transformer-adaptive-review:${regeneration.rationaleDigest}`,
        "reviewer:human:reviewer@a.com",
      ],
      idempotencyKey: regeneration.id,
      action: "authorize_regeneration",
      unitId: "unit-1",
      exceptionId: originatingException.id,
      candidateId: seeded.id,
      reviewerPrincipalId: "human:reviewer@a.com",
      rationale,
      rationaleDigest: regeneration.rationaleDigest,
    });
    expect(replayed).toEqual(resumed);
    expect(store.listEvents("tenant-a", "campaign-1")
      .filter((event) => event.type === "campaign.authorize_regeneration")).toHaveLength(1);

    const successorToken = "regeneration-successor-lease-token";
    const successorLease = store.claimNextAttempt({
      tenantId: "tenant-a",
      campaignId: "campaign-1",
      observedAt: new Date(Date.parse(scheduledAt) + 1_000).toISOString(),
      evidenceRefs: ["evidence://attempt/successor"],
      idempotencyKey: "claim-successor",
      leaseToken: successorToken,
      leaseDurationMs: 3_600_000,
      gateConfig,
    })!;
    expect(successorLease.regenerationReview).toMatchObject({
      candidateId: seeded.id,
      reviewerPrincipalId: "human:reviewer@a.com",
      rationale,
    });
    const successorDigest = `sha256:${"9".repeat(64)}`;
    store.recordAdaptiveCandidateHandoff({
      tenantId: "tenant-a",
      campaignId: "campaign-1",
      unitId: "unit-1",
      attemptId: transformerAttemptId(successorLease),
      attemptNumber: successorLease.attemptNumber,
      leaseGeneration: successorLease.leaseGeneration,
      leaseToken: successorToken,
      repositoryId: "repo-1",
      snapshotId: "snapshot-1",
      baseBranch: "main",
      expectedBaseRevision: "e".repeat(40),
      divergedFromDigest: recipeFilesDigest(RECIPE_FILES),
      candidateDigest: successorDigest,
      failingCommandId: "verify:typecheck",
      changedPaths: ["package.json"],
      fileModes: { "package.json": "100755" },
      sealedPath: join(tmpdir(), "successor-candidate.json"),
      sealedSha256: `sha256:${"8".repeat(64)}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      observedAt: new Date(Date.parse(scheduledAt) + 2_000).toISOString(),
      evidenceRefs: ["evidence://candidate/successor"],
      idempotencyKey: "handoff-successor",
      gateConfig,
    });
    const successor = recordAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      campaignId: "campaign-1",
      unitId: "unit-1",
      attemptId: transformerAttemptId(successorLease),
      repositoryId: "repo-1",
      snapshotId: "snapshot-1",
      baseBranch: "main",
      expectedBaseRevision: "e".repeat(40),
      divergedFromDigest: recipeFilesDigest(RECIPE_FILES),
      candidateDigest: successorDigest,
      failingCommandId: "verify:typecheck",
      sealedPath: join(tmpdir(), "successor-candidate.json"),
      sealedSha256: `sha256:${"8".repeat(64)}`,
      changedPaths: ["package.json"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      now: new Date(Date.parse(scheduledAt) + 2_000).toISOString(),
    });
    expect(successor).toMatchObject({
      generation: 2,
      supersedesCandidateId: seeded.id,
    });
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)).toMatchObject({
      supersededByCandidateId: successor.id,
    });
    expect(getAdaptiveRegenerationByCandidate(db, "tenant-a", seeded.id)).toMatchObject({
      status: "completed",
      supersedingCandidateId: successor.id,
    });
  });

  it("fails regeneration closed when the Transformer control gate denies it", async () => {
    const { app, db } = fixture(() => {}, false);
    const seeded = seedCandidate(db, "tenant-a");
    const response = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("regenerate"),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "transformer_adaptive_regeneration_not_authorized",
      reasons: ["tenant_not_allowed"],
    });
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("review_pending");
  });

  it("returns the exact bounded proposed file preview", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    const res = await app.request(`/transformer/adaptive-candidates/${seeded.id}`, {
      headers: { "X-Test-Actor": "human-a" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      repositoryId: "repo-1",
      snapshotId: "snapshot-1",
      baseBranch: "main",
      expectedBaseRevision: "e".repeat(40),
      changedFileCount: 1,
      sealVerified: true,
      previewComplete: true,
      reviewEvidenceComplete: true,
      omittedPaths: [],
      files: [{
        path: "package.json",
        action: "write",
        proposedContent: CONVERGED_FILES["package.json"],
        mode: "100755",
        bytes: Buffer.byteLength(CONVERGED_FILES["package.json"]!, "utf8"),
      }],
      semanticReview: {
        groups: [{
          category: "dependencies",
          edits: [{
            path: "package.json",
            changeType: "modify",
            beforeContent: RECIPE_FILES["package.json"],
            afterContent: CONVERGED_FILES["package.json"],
            beforeMode: "100755",
            afterMode: "100755",
            rationale: "Raise the declared runtime to the verified target.",
            risk: "low",
            confidence: 96,
          }],
        }],
        verification: {
          passed: true,
          commandId: "verify:typecheck",
        },
        overallRisk: "low",
        confidence: 96,
      },
    });
  });

  it("rejects an unreviewable file before candidate persistence", () => {
    const { db } = fixture();
    expect(() => seedCandidate(db, "tenant-a", {
      files: {
        ...CONVERGED_FILES,
        "package.json": "x".repeat(256 * 1024 + 1),
      },
    })).toThrow("adaptive_candidate_file_too_large");
  });

  it("measures the exact serialized response budget for escaping-heavy content", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a", {
      files: {
        ...CONVERGED_FILES,
        "package.json": "\u0000".repeat(256 * 1024),
      },
    });
    const detail = await app.request(`/transformer/adaptive-candidates/${seeded.id}`, {
      headers: { "X-Test-Actor": "human-a" },
    });
    const serialized = await detail.text();
    expect(detail.status).toBe(200);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(JSON.parse(serialized)).toMatchObject({
      evidenceStatus: "verified",
      previewComplete: true,
      omittedPaths: [],
      files: [expect.objectContaining({ path: "package.json" })],
    });
    const approval = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    expect(approval.status).toBe(202);
    expect(await approval.json()).toMatchObject({
      status: "approved",
      delivery: { status: "delivery_pending" },
    });
  });

  it("rejects an API-key request carrying a synthesized human actor", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    const res = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "apikey-human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("human_review_required");
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("review_pending");
  });

  it("never marks an approved candidate promoted before draft delivery is proven", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    const res = await app.request(`/transformer/adaptive-candidates/${seeded.id}/promote`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("delivery_pending");
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("approved");
  });

  it("requires a direct human for promotion", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    const res = await app.request(`/transformer/adaptive-candidates/${seeded.id}/promote`, {
      method: "POST",
      headers: { "X-Test-Actor": "apikey-human-a" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("human_promotion_required");
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("approved");
  });

  it("rolls review state back when its audit event cannot be recorded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, db } = fixture(() => {
      throw new Error("audit unavailable");
    });
    const seeded = seedCandidate(db, "tenant-a");
    const res = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "internal_error",
      requestId: "request-human-a",
    });
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("review_pending");
  });

  it("keeps promotion disabled even when an approved delivery is queued", async () => {
    let failAudit = false;
    const { app, db } = fixture(() => {
      if (failAudit) throw new Error("audit unavailable");
    });
    const seeded = seedCandidate(db, "tenant-a");
    await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    failAudit = true;
    const res = await app.request(`/transformer/adaptive-candidates/${seeded.id}/promote`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a" },
    });
    expect(res.status).toBe(409);
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("approved");
  });

  it("expires a pending candidate instead of approving it", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a", {
      expiresAt: "2026-08-06T00:00:00.000Z",
    });
    const res = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    expect(res.status).toBe(410);
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("expired");
  });

  it("lists only the current tenant adaptive candidates", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    const res = await app.request("/transformer/adaptive-candidates", {
      headers: { "X-Test-Actor": "human-a" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attention: Array<{ id: string; changedFileCount: number; changedPaths?: string[] }>;
      history: unknown[];
      nextHistoryCursor: string | null;
    };
    expect(body.attention.map((candidate) => candidate.id)).toEqual([seeded.id]);
    expect(body.attention[0]).toMatchObject({ changedFileCount: 1 });
    expect(body.attention[0]?.changedPaths).toBeUndefined();
    expect(body.history).toEqual([]);
    expect(body.nextHistoryCursor).toBeNull();
  });

  it("lists delivery state and normalizes due candidates for customer history", async () => {
    const { app, db } = fixture();
    const approved = seedCandidate(db, "tenant-a", { unitId: "approved-unit" });
    await app.request(`/transformer/adaptive-candidates/${approved.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    const expired = seedCandidate(db, "tenant-a", {
      unitId: "expired-unit",
      expiresAt: "2026-08-06T00:00:00.000Z",
    });

    const res = await app.request("/transformer/adaptive-candidates?historyLimit=100", {
      headers: { "X-Test-Actor": "human-a" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attention: Array<{ id: string; status: string; delivery?: { status: string } }>;
      history: Array<{ id: string; status: string; delivery?: { status: string } }>;
    };
    expect(body.attention.find((candidate) => candidate.id === approved.id)).toMatchObject({
      status: "approved",
      delivery: { status: "delivery_pending" },
    });
    expect(body.history.find((candidate) => candidate.id === expired.id)).toMatchObject({
      status: "expired",
    });
  });

  it("keeps older attention visible and returns terminal history through exact cursor pages", async () => {
    const { app, db } = fixture();
    const pending = seedCandidate(db, "tenant-a", { unitId: "attention-pending" });
    const approved = seedCandidate(db, "tenant-a", { unitId: "attention-approved" });
    await app.request(`/transformer/adaptive-candidates/${approved.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    db.raw.prepare(
      `UPDATE regauge_adaptive_candidates
       SET created_at = '2026-08-01T00:00:00.000Z', updated_at = '2026-08-01T00:00:00.000Z'
       WHERE id IN (?, ?)`,
    ).run(pending.id, approved.id);
    const expectedHistory = new Set<string>();
    for (let index = 0; index < 105; index += 1) {
      const observedAt = new Date(Date.parse("2026-08-02T00:00:00.000Z") + index * 1_000)
        .toISOString();
      const row = recordAdaptiveCandidate(db, {
        tenantId: "tenant-a",
        campaignId: "campaign-1",
        unitId: `history-${index.toString().padStart(3, "0")}`,
        attemptId: `tfattempt_history_${index.toString().padStart(3, "0")}`,
        repositoryId: "repo-1",
        snapshotId: "snapshot-1",
        baseBranch: "main",
        expectedBaseRevision: "e".repeat(40),
        divergedFromDigest: recipeFilesDigest(RECIPE_FILES),
        candidateDigest: recipeFilesDigest(CONVERGED_FILES),
        failingCommandId: "verify:typecheck",
        sealedPath: `/unused/history-${index}.json`,
        sealedSha256: `sha256:${index.toString(16).padStart(64, "0")}`,
        changedPaths: ["package.json"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        now: observedAt,
      });
      db.raw.prepare(
        `UPDATE regauge_adaptive_candidates
         SET status = 'rejected', review_decision = 'reject',
             reviewer_principal_id = 'human:reviewer@a.com', reviewed_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = 'tenant-a'`,
      ).run(observedAt, observedAt, row.id);
      expectedHistory.add(row.id);
    }
    recordAdaptiveCandidate(db, {
      tenantId: "tenant-b",
      campaignId: "campaign-b",
      unitId: "history-tenant-b",
      attemptId: "tfattempt_history_tenant_b",
      repositoryId: "repo-b",
      snapshotId: "snapshot-b",
      baseBranch: "main",
      expectedBaseRevision: "d".repeat(40),
      divergedFromDigest: recipeFilesDigest(RECIPE_FILES),
      candidateDigest: recipeFilesDigest(CONVERGED_FILES),
      failingCommandId: "verify:typecheck",
      sealedPath: "/unused/tenant-b.json",
      sealedSha256: `sha256:${"f".repeat(64)}`,
      changedPaths: ["package.json"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      now: "2026-08-03T00:00:00.000Z",
    });

    const visited: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ historyLimit: "17" });
      if (cursor) query.set("historyCursor", cursor);
      const response = await app.request(`/transformer/adaptive-candidates?${query}`, {
        headers: { "X-Test-Actor": "human-a" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        attention: Array<{ id: string }>;
        history: Array<{ id: string }>;
        nextHistoryCursor: string | null;
      };
      expect(body.attention.map((candidate) => candidate.id).sort())
        .toEqual([approved.id, pending.id].sort());
      expect(body.history.length).toBeLessThanOrEqual(17);
      visited.push(...body.history.map((candidate) => candidate.id));
      cursor = body.nextHistoryCursor;
    } while (cursor);

    expect(visited).toHaveLength(105);
    expect(new Set(visited).size).toBe(105);
    expect(new Set(visited)).toEqual(expectedHistory);
  });

  it("refuses to promote a candidate that has not been approved", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    const res = await app.request(`/transformer/adaptive-candidates/${seeded.id}/promote`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a" },
    });
    expect(res.status).toBe(409);
  });

  it("cleans up the sealed artifact on rejection", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    const res = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("reject"),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).status).toBe("rejected");
    expect(() =>
      readAdaptiveCandidateArtifact({
        tenantId: "tenant-a",
        path: seeded.sealPath,
        sha256: seeded.sealSha256,
      }),
    ).toThrow("adaptive_candidate_seal_missing");
  });

  it("reports intentional retention cleanup without claiming seal corruption", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("reject"),
    });
    const detail = await app.request(`/transformer/adaptive-candidates/${seeded.id}`, {
      headers: { "X-Test-Actor": "human-a" },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      status: "rejected",
      sealVerified: false,
      evidenceStatus: "retention_cleaned",
      evidenceErrorCode: null,
      previewComplete: false,
      files: [],
    });
  });

  it("reverifies and serves retained evidence after successful promotion", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    db.raw.prepare(
      `UPDATE regauge_adaptive_candidates
       SET status = 'promoted', promoted_at = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(NOW, NOW, seeded.id, "tenant-a");
    db.raw.prepare(
      `UPDATE regauge_adaptive_deliveries
       SET status = 'delivered', branch_name = ?, base_revision = ?, commit_sha = ?,
           draft_pr = 1, draft_pr_number = 42, draft_pr_url = ?, delivered_at = ?, updated_at = ?
       WHERE candidate_id = ? AND tenant_id = ?`,
    ).run(
      "mendpoint/adaptive-unit-1",
      "e".repeat(40),
      "f".repeat(40),
      "https://github.com/example/repo/pull/42",
      NOW,
      NOW,
      seeded.id,
      "tenant-a",
    );

    const detail = await app.request(`/transformer/adaptive-candidates/${seeded.id}`, {
      headers: { "X-Test-Actor": "human-a" },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      status: "promoted",
      sealVerified: true,
      evidenceStatus: "verified",
      evidenceErrorCode: null,
      previewComplete: true,
      files: [{ path: "package.json", proposedContent: CONVERGED_FILES["package.json"] }],
      delivery: {
        status: "delivered",
        draftPrNumber: 42,
        draftPrUrl: "https://github.com/example/repo/pull/42",
      },
    });
  });

  it("reports promoted evidence as retention cleaned only after its deadline", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    db.raw.prepare(
      `UPDATE regauge_adaptive_candidates
       SET status = 'promoted', review_decision = 'approve',
           reviewer_principal_id = 'human:reviewer@a.com', reviewed_at = ?,
           promoted_at = ?, expires_at = '2026-01-01T00:00:00.000Z', updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(NOW, NOW, NOW, seeded.id, "tenant-a");
    discardAdaptiveCandidate({
      tenantId: "tenant-a",
      path: seeded.sealPath,
      sha256: seeded.sealSha256,
    });

    const detail = await app.request(`/transformer/adaptive-candidates/${seeded.id}`, {
      headers: { "X-Test-Actor": "human-a" },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      status: "promoted",
      sealVerified: false,
      evidenceStatus: "retention_cleaned",
      evidenceErrorCode: null,
      previewComplete: false,
      files: [],
    });
  });

  it("treats missing promoted evidence before its deadline as corruption", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a", {
      unitId: "promoted-tampered",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    db.raw.prepare(
      `UPDATE regauge_adaptive_candidates
       SET status = 'promoted', review_decision = 'approve',
           reviewer_principal_id = 'human:reviewer@a.com', reviewed_at = ?,
           promoted_at = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(NOW, NOW, NOW, seeded.id, "tenant-a");
    discardAdaptiveCandidate({
      tenantId: "tenant-a",
      path: seeded.sealPath,
      sha256: seeded.sealSha256,
    });

    const detail = await app.request(`/transformer/adaptive-candidates/${seeded.id}`, {
      headers: { "X-Test-Actor": "human-a" },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      status: "promoted",
      sealVerified: false,
      evidenceStatus: "corrupt",
      evidenceErrorCode: "adaptive_candidate_seal_missing",
    });
  });

  it("distinguishes unexpected promoted seal corruption from retention cleanup", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    db.raw.prepare(
      `UPDATE regauge_adaptive_candidates
       SET status = 'promoted', promoted_at = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(NOW, NOW, seeded.id, "tenant-a");
    writeFileSync(seeded.sealPath, "corrupt");

    const detail = await app.request(`/transformer/adaptive-candidates/${seeded.id}`, {
      headers: { "X-Test-Actor": "human-a" },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      status: "promoted",
      sealVerified: false,
      evidenceStatus: "corrupt",
      evidenceErrorCode: "adaptive_candidate_seal_digest_mismatch",
      previewComplete: false,
      files: [],
    });
  });

  it("fails closed on approval when the sealed artifact is tampered with", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    const tampered = JSON.parse(readFileSync(seeded.sealPath, "utf8")) as Record<string, unknown>;
    (tampered.files as Record<string, string>)["package.json"] =
      Buffer.from("malicious\n", "utf8").toString("base64");
    writeFileSync(seeded.sealPath, JSON.stringify(tampered));
    const res = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    expect(res.status).toBe(409);
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("review_pending");
  });

  it("fails closed when the sealed artifact no longer matches its database binding", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    db.raw
      .prepare("UPDATE regauge_adaptive_candidates SET failing_command_id = ? WHERE id = ?")
      .run("verify:different", seeded.id);
    const res = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, unknown>).error).toBe(
      "adaptive_candidate_record_binding_mismatch",
    );
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("review_pending");
  });

  it("isolates tenants: another tenant cannot see or approve the candidate", async () => {
    const { app, db } = fixture();
    const seeded = seedCandidate(db, "tenant-a");
    const getRes = await app.request(`/transformer/adaptive-candidates/${seeded.id}`, {
      headers: { "X-Test-Actor": "human-b" },
    });
    expect(getRes.status).toBe(404);
    const reviewRes = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-b", "content-type": "application/json" },
      body: reviewBody("approve"),
    });
    expect(reviewRes.status).toBe(404);
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("review_pending");
  });
});

describe("transformer adaptive review: rejected-outcome negative capture", () => {
  const LEARNING_ON: NodeJS.ProcessEnv = { MENDPOINT_REGAUGE_LEARNING_ENABLED: "1" };
  const REJECTED_PURPOSE = "transformer-adaptive-rejected-outcomes";

  function seedReviewerAndConsent(db: AppDb): void {
    // The auth principal id used by "human-a" must exist as a principal so the
    // learning record's admittedByPrincipalId resolves.
    insertPrincipal(db, {
      id: "human:reviewer@a.com",
      tenantId: "tenant-a",
      kind: "human",
      subject: "reviewer-auth@a.com",
      displayName: "Reviewer Auth A",
      createdAt: NOW,
    });
    grantLearningConsent(db, {
      id: "learn-consent-rejected",
      tenantId: "tenant-a",
      consentVersion: 1,
      purpose: REJECTED_PURPOSE,
      residencyRegion: "us-east",
      authorizedByPrincipalId: "trust-human-a",
      effectiveAt: NOW,
      expiresAt: "2099-01-01T00:00:00.000Z",
      reason: "Authorized negative-outcome capture",
      idempotencyKey: "grant-rejected",
      createdAt: NOW,
    });
  }

  function rejectedRecords(db: AppDb): Array<{ id: string }> {
    return db.raw
      .prepare("SELECT id FROM learning_records WHERE tenant_id = ? AND purpose = ?")
      .all("tenant-a", REJECTED_PURPOSE) as Array<{ id: string }>;
  }

  it("captures a redacted, labeled negative record on reject when enabled and consented", async () => {
    const { app, db } = fixture(() => {}, true, LEARNING_ON);
    seedReviewerAndConsent(db);
    const seeded = seedCandidate(db, "tenant-a");

    const response = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("reject"),
    });
    expect(response.status).toBe(200);
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("rejected");

    const rows = rejectedRecords(db);
    expect(rows).toHaveLength(1);
    const content = getLearningRecordRedactedContent(db, "tenant-a", rows[0]!.id);
    const doc = JSON.parse(content!) as Record<string, unknown>;
    expect(doc.decision).toBe("rejected");
    expect(doc.rejectionRationale).toBe("Verified the exact proposed files");
  });

  it("captures nothing on reject when the loop is disabled (byte-identical to today)", async () => {
    // learningEnv = {} => capture gate is off; the reject/discard flow is unchanged.
    const { app, db } = fixture(() => {}, true, {});
    seedReviewerAndConsent(db);
    const seeded = seedCandidate(db, "tenant-a");

    const response = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("reject"),
    });
    expect(response.status).toBe(200);
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("rejected");
    expect(rejectedRecords(db)).toHaveLength(0);
  });

  it("captures nothing on reject when enabled but the rejected-outcome consent is absent", async () => {
    const { app, db } = fixture(() => {}, true, LEARNING_ON);
    // Reviewer principal exists, but NO rejected-outcome consent is granted.
    insertPrincipal(db, {
      id: "human:reviewer@a.com",
      tenantId: "tenant-a",
      kind: "human",
      subject: "reviewer-auth@a.com",
      displayName: "Reviewer Auth A",
      createdAt: NOW,
    });
    const seeded = seedCandidate(db, "tenant-a");

    const response = await app.request(`/transformer/adaptive-candidates/${seeded.id}/review`, {
      method: "POST",
      headers: { "X-Test-Actor": "human-a", "content-type": "application/json" },
      body: reviewBody("reject"),
    });
    expect(response.status).toBe(200);
    expect(getAdaptiveCandidate(db, "tenant-a", seeded.id)?.status).toBe("rejected");
    expect(rejectedRecords(db)).toHaveLength(0);
  });
});
