import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb, createMission, getJob, getMission, insertConnectedRepository,
  insertPrincipal, insertRepositorySnapshot, insertTenant,
  linkRegaugeCampaignToMission, listArtifactManifests, upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import {
  NODE_RUNTIME_18_TO_20_RECIPE, recipeReference,
  type TransformerAttemptCheckpointCompletionResult,
} from "@mendpoint/transformer";
import {
  buildDedicatedRegaugeCompletionInput,
  enqueueDedicatedRegaugeCompletionForAdvisory,
} from "./regauge-verifier-shadow.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const sha = (value: string) => value.repeat(40);
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const observedAt = "2026-08-24T12:01:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()!.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function db(): AppDb {
  const root = mkdtempSync(join(tmpdir(), "regauge-verifier-advisory-"));
  roots.push(root);
  const value = createDb(join(root, "app.sqlite"));
  dbs.push(value);
  insertTenant(value, { id: "tenant_regauge_canary", slug: "tenant-regauge-canary", name: "ReGauge canary", createdAt: "2026-08-24T12:00:00.000Z" });
  insertPrincipal(value, { id: "verifier_service", tenantId: "tenant_regauge_canary", kind: "service", subject: "service:regauge-production-bootstrap", displayName: "DeepSeek verifier", createdAt: "2026-08-24T12:00:00.000Z" });
  upsertScmConnection(value, { id: "connection-a", tenantId: "tenant_regauge_canary", provider: "github", credentialRef: "github-app://installation/1", externalAccountId: "1", displayName: "Canary", createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" });
  insertConnectedRepository(value, { id: "repo-a", tenantId: "tenant_regauge_canary", connectionId: "connection-a", remoteId: "123456", owner: "gondalaimafia", name: "mendpoint-canary-drill-20260801", defaultBranch: "main", selectedBranch: "main", environment: "production", retentionDays: 30, status: "ready", createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" });
  insertRepositorySnapshot(value, { id: "snapshot-a", tenantId: "tenant_regauge_canary", repositoryId: "repo-a", requestedRef: "main", resolvedSha: sha("a"), manifestSha256: "a".repeat(64), storagePath: root, fileManifestVersion: 1, createdAt: "2026-08-24T12:00:00.000Z", expiresAt: "2026-11-20T23:59:59.000Z" });
  createMission(value, { id: "mission-regauge-a", tenantId: "tenant_regauge_canary", product: "regauge", triggerKind: "migration_objective", objective: "Upgrade Node", ownerPrincipalId: "verifier_service", repositoryId: "repo-a", snapshotId: "snapshot-a", eventId: "mission-created", idempotencyKey: "mission-created", correlationId: "campaign_regauge_canary_20260814", createdAt: "2026-08-24T12:00:00.000Z" });
  linkRegaugeCampaignToMission(value, { tenantId: "tenant_regauge_canary", missionId: "mission-regauge-a", regaugeCampaignId: "campaign_regauge_canary_20260814", actorPrincipalId: "verifier_service", eventId: "mission-linked", idempotencyKey: "mission-linked", correlationId: "campaign_regauge_canary_20260814", createdAt: "2026-08-24T12:00:00.000Z" });
  return value;
}

function completed(): TransformerAttemptCheckpointCompletionResult {
  return {
    campaign: {
      schemaVersion: "2026-08-11.v1", tenantId: "tenant_regauge_canary", organizationId: "org-canary", environment: "production", campaignId: "campaign_regauge_canary_20260814", revision: 3, state: "running", constraintVersion: 1, constraintDigest: digest("constraint"), gateEvidenceRefs: ["evidence:gate"],
      units: [{ id: "unit-a", title: "Migrate Node", ownerId: "owner-a", reviewerIds: ["reviewer-a"], dependsOn: [], wave: 1, snapshot: { snapshotId: "snapshot-a", repositoryId: "repo-a", revision: sha("a"), manifestSha256: "a".repeat(64), digest: digest("snapshot"), evidenceRefs: ["evidence:snapshot"] }, candidateRevision: sha("c"), candidateDigest: digest("candidate"), recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE), changedPaths: ["package.json"], state: "executed", attemptNumber: 1, leaseGeneration: 1, retryAuthorized: false, executionEvidenceRefs: ["evidence:verification"], scmEvidenceRefs: [], executedAt: observedAt, verificationPassed: true, actualCostUsd: 0.02, adaptiveAccounting: { attempts: 1, plannerCalls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostUsd: 0, wallTimeMs: 100 } }],
      exceptions: [], adaptiveBudget: { maximum: { attempts: 1, plannerCalls: 1, modelCalls: 1, inputTokens: 100, outputTokens: 100, totalTokens: 200, actualCostUsd: 1, wallTimeMs: 10_000 }, used: { attempts: 1, plannerCalls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostUsd: 0, wallTimeMs: 100 } }, createdAt: "2026-08-24T12:00:00.000Z", updatedAt: observedAt,
    },
    receipt: { schemaVersion: 1, tenantId: "tenant_regauge_canary", campaignId: "campaign_regauge_canary_20260814", unitId: "unit-a", episodeId: "episode-a", completionDigest: digest("completion"), campaignRevision: 3, observedAt, checkpointHead: { schemaVersion: 1, tenantId: "tenant_regauge_canary", campaignId: "campaign_regauge_canary_20260814", unitId: "unit-a", episodeId: "episode-a", stateDigest: digest("state"), envelopeStorageKey: "checkpoint/a", envelopeDigest: digest("envelope"), generation: 2, attemptNumber: 1, writerLeaseGeneration: 1, writerLeaseTokenDigest: digest("lease") } },
  } as unknown as TransformerAttemptCheckpointCompletionResult;
}

function env(): Record<string, string> {
  return {
    MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: JSON.stringify({ schemaVersion: "2026-08-17.v1", entries: [{ tenantId: "tenant_regauge_canary", products: ["regauge"], dataClassification: "confidential", requiredRegion: "cn", processingRegion: "cn", consentId: "consent-regauge", evidenceRef: "github-environment:regauge-production", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentActive: true }] }),
    MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON: JSON.stringify({ policyEnvelopeId: "regauge-deepseek-v4-flash-advisory-20260824", tenantId: "tenant_regauge_canary", version: 1, repositoryScope: [], branchScope: [], forbiddenZones: [], allowedTools: ["deepseek-verifier"], allowedModelClasses: ["rented_specialist"], externalProcessingAllowed: true, residency: "cn", riskCeiling: "high", reviewRequired: true, deploymentAllowed: false, trainingDataAllowed: false, retentionDays: 90, createdAt: "2026-08-24T00:00:00.000Z" }),
  };
}

describe("dedicated ReGauge advisory dispatch", () => {
  it("derives the input from exact completion evidence and the durable Mission id", () => {
    expect(buildDedicatedRegaugeCompletionInput(completed(), "mission-regauge-a")).toEqual({
      tenantId: "tenant_regauge_canary", missionId: "mission-regauge-a", taskId: "campaign_regauge_canary_20260814:unit-a", product: "regauge", repositoryId: "repo-a", snapshotId: "snapshot-a", snapshotDigest: digest("snapshot"), objective: "Execute the bound node-runtime-18-to-20 migration for unit unit-a.", risk: "high", allowedChangedPaths: ["package.json"], candidateId: expect.stringMatching(/^regauge_[a-f0-9]{32}$/), candidateDigest: digest("candidate"), changedPaths: ["package.json"], observableSummary: "The exact checkpoint completion passed deterministic verification for 1 changed path.", deterministicEvidenceDigest: digest("completion"), deterministicEvidenceRefs: ["evidence:verification"], observedAt,
    });
  });

  it("binds policy authority and enqueues exactly one identifier only job on replay", () => {
    const store = db();
    const first = enqueueDedicatedRegaugeCompletionForAdvisory({ db: store, env: env(), completion: completed() });
    const second = enqueueDedicatedRegaugeCompletionForAdvisory({ db: store, env: env(), completion: completed() });
    expect(second).toEqual({ ...first, status: "duplicate" });
    expect(getMission(store, "tenant_regauge_canary", "mission-regauge-a")?.policyEnvelopeVersion).toBe("1");
    const job = getJob(store, first.jobId, "tenant_regauge_canary")!;
    expect(job.type).toBe("verifier.advisory.verify");
    expect(job.payload_json).not.toContain("package.json");
    expect(listArtifactManifests(store, "tenant_regauge_canary", "agent_verifier_advisory_input")).toHaveLength(1);
  });

  it("fails closed before enqueue when Mission or policy authority does not match", () => {
    const store = db();
    expect(() => enqueueDedicatedRegaugeCompletionForAdvisory({ db: store, env: { ...env(), MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON: "{}" }, completion: completed() }))
      .toThrow("verifier_advisory_policy_invalid");
    const wrong = completed();
    (wrong.campaign as { campaignId: string }).campaignId = "other-campaign";
    expect(() => enqueueDedicatedRegaugeCompletionForAdvisory({ db: store, env: env(), completion: wrong }))
      .toThrow("regauge_verifier_advisory_mission_missing");
  });
});
