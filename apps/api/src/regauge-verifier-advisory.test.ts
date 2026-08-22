import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  grantLearningConsent,
  insertPrincipal,
  insertTenant,
  listArtifactManifests,
  type AppDb,
} from "@mendpoint/db";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  recipeReference,
  type TransformerAttemptCheckpointCompletionResult,
} from "@mendpoint/transformer";
import { VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE } from "@mendpoint/worker/verifier-product-advisory";
import {
  buildDedicatedRegaugeCompletionInput,
  observeDedicatedRegaugeCompletionForAdvisory,
} from "./regauge-verifier-advisory.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const sha = (value: string) => value.repeat(40);
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

afterEach(() => {
  while (dbs.length) dbs.pop()!.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function db(): AppDb {
  const root = mkdtempSync(join(tmpdir(), "regauge-verifier-advisory-"));
  roots.push(root);
  const value = createDb(join(root, "app.sqlite"));
  dbs.push(value);
  insertTenant(value, { id: "tenant_regauge_canary", slug: "tenant-regauge-canary", name: "ReGauge canary", createdAt: "2026-08-21T12:00:00.000Z" });
  insertPrincipal(value, { id: "verifier_service", tenantId: "tenant_regauge_canary", kind: "service", subject: "service:regauge-production-bootstrap", displayName: "DeepSeek verifier", createdAt: "2026-08-21T12:00:00.000Z" });
  insertPrincipal(value, { id: "human_approver", tenantId: "tenant_regauge_canary", kind: "human", subject: "human@example.com", displayName: "Human approver", createdAt: "2026-08-21T12:00:00.000Z" });
  return value;
}

function completed(): TransformerAttemptCheckpointCompletionResult {
  return {
    campaign: {
      schemaVersion: "2026-08-11.v1",
      tenantId: "tenant_regauge_canary",
      organizationId: "org-canary",
      environment: "production",
      campaignId: "campaign_regauge_canary_20260814",
      revision: 3,
      state: "running",
      constraintVersion: 1,
      constraintDigest: digest("constraint"),
      gateEvidenceRefs: ["evidence:gate"],
      units: [{
        id: "unit-a", title: "Migrate Node", ownerId: "owner-a", reviewerIds: ["reviewer-a"],
        dependsOn: [], wave: 1,
        snapshot: { snapshotId: "snapshot-a", repositoryId: "repo-a", revision: sha("a"), manifestSha256: "a".repeat(64), digest: digest("snapshot"), evidenceRefs: ["evidence:snapshot"] },
        candidateRevision: sha("c"), candidateDigest: digest("candidate"),
        recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE), changedPaths: ["package.json"],
        state: "executed", attemptNumber: 1, leaseGeneration: 1, retryAuthorized: false,
        executionEvidenceRefs: ["evidence:verification"], scmEvidenceRefs: [],
        executedAt: "2026-08-21T12:01:00.000Z", verificationPassed: true, actualCostUsd: 0.02,
        adaptiveAccounting: { attempts: 1, plannerCalls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostUsd: 0, wallTimeMs: 100 },
      }],
      exceptions: [],
      adaptiveBudget: { maximum: { attempts: 1, plannerCalls: 1, modelCalls: 1, inputTokens: 100, outputTokens: 100, totalTokens: 200, actualCostUsd: 1, wallTimeMs: 10_000 }, used: { attempts: 1, plannerCalls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, actualCostUsd: 0, wallTimeMs: 100 } },
      createdAt: "2026-08-21T12:00:00.000Z", updatedAt: "2026-08-21T12:01:00.000Z",
    },
    receipt: {
      schemaVersion: 1,
      tenantId: "tenant_regauge_canary",
      campaignId: "campaign_regauge_canary_20260814",
      unitId: "unit-a",
      episodeId: "episode-a",
      completionDigest: digest("completion"),
      campaignRevision: 3,
      observedAt: "2026-08-21T12:01:00.000Z",
      checkpointHead: { schemaVersion: 1, tenantId: "tenant_regauge_canary", campaignId: "campaign_regauge_canary_20260814", unitId: "unit-a", episodeId: "episode-a", stateDigest: digest("state"), envelopeStorageKey: "checkpoint/a", envelopeDigest: digest("envelope"), generation: 2, attemptNumber: 1, writerLeaseGeneration: 1, writerLeaseTokenDigest: digest("lease") },
    },
  } as unknown as TransformerAttemptCheckpointCompletionResult;
}

function env(): Record<string, string> {
  return {
    DEEPSEEK_VERIFIER_ENABLED: "true",
    DEEPSEEK_API_KEY: "secret",
    MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "advisory",
    MENDPOINT_AGENT_VERIFIER_EVALUATIONS: "1",
    MENDPOINT_AGENT_VERIFIER_PIVOTS: "1",
    MENDPOINT_AGENT_VERIFIER_MAXIMUM_CANDIDATES: "1",
    MENDPOINT_AGENT_VERIFIER_MAXIMUM_COST_USD: "0.05",
    MENDPOINT_AGENT_VERIFIER_TIMEOUT_MS: "8000",
    MENDPOINT_AGENT_VERIFIER_MAXIMUM_RETRIES: "0",
    MENDPOINT_AGENT_VERIFIER_PRINCIPAL_ID: "verifier_service",
    MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: JSON.stringify({ schemaVersion: "2026-08-17.v1", entries: [{ tenantId: "tenant_regauge_canary", products: ["regauge"], dataClassification: "confidential", requiredRegion: "cn", processingRegion: "cn", consentId: "consent-regauge", evidenceRef: "github-environment:regauge-production", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentActive: true }] }),
    MENDPOINT_AGENT_VERIFIER_PRICING_JSON: JSON.stringify({ version: "deepseek-v4-flash-2026-08-21", currency: "USD", effectiveAt: "2026-08-21T00:00:00.000Z", inputPerMillion: 0.14, cachedInputPerMillion: 0.0028, outputPerMillion: 0.28 }),
  };
}

describe("dedicated ReGauge verifier production advisory", () => {
  it("derives the shadow input only from the exact completed campaign and receipt", () => {
    expect(buildDedicatedRegaugeCompletionInput(completed())).toEqual({
      tenantId: "tenant_regauge_canary",
      missionId: "campaign_regauge_canary_20260814",
      taskId: "campaign_regauge_canary_20260814:unit-a",
      product: "regauge",
      repositoryId: "repo-a",
      snapshotDigest: digest("snapshot"),
      objective: "Execute the bound node-runtime-18-to-20 migration for unit unit-a.",
      risk: "high",
      allowedChangedPaths: ["package.json"],
      candidateId: expect.stringMatching(/^regauge_[a-f0-9]{32}$/),
      candidateDigest: digest("candidate"),
      changedPaths: ["package.json"],
      observableSummary: "The exact checkpoint completion passed deterministic verification for 1 changed path.",
      deterministicEvidenceDigest: digest("completion"),
      deterministicEvidenceRefs: ["evidence:verification"],
      observedAt: "2026-08-21T12:01:00.000Z",
    });
  });

  it("rejects a completion that is not exact deterministic success", () => {
    const value = completed();
    for (const changed of [
      { ...value, receipt: { ...value.receipt, tenantId: "other-tenant" } },
      { ...value, receipt: { ...value.receipt, campaignRevision: 2 } },
      { ...value, campaign: { ...value.campaign, updatedAt: "2026-08-21T12:02:00.000Z" } },
      { ...value, campaign: { ...value.campaign, units: [{ ...value.campaign.units[0]!, verificationPassed: false }] } },
    ] as unknown as TransformerAttemptCheckpointCompletionResult[]) {
      expect(() => buildDedicatedRegaugeCompletionInput(changed))
        .toThrow("regauge_verifier_advisory_completion_invalid");
    }
  });

  it("replays one exact completion without a second provider request or telemetry artifact", async () => {
    const store = db();
    grantLearningConsent(store, { id: "consent-regauge", tenantId: "tenant_regauge_canary", consentVersion: 1, purpose: VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE, residencyRegion: "cn", authorizedByPrincipalId: "human_approver", supersedesConsentId: null, effectiveAt: "2026-08-21T12:00:00.000Z", expiresAt: null, reason: "Approve bounded DeepSeek shadow verification.", idempotencyKey: "consent-regauge", createdAt: "2026-08-21T12:00:00.000Z" });
    const transport = vi.fn(async () => ({ status: 200, headers: {}, body: { id: "response-a", model: "deepseek-v4-flash", choices: [{ finish_reason: "stop", message: { content: "<score>A</score>" }, logprobs: { content: [{ token: "A", logprob: -0.1, top_logprobs: [{ token: "A", logprob: -0.1 }, { token: "T", logprob: -2 }] }] } }], usage: { prompt_tokens: 10, completion_tokens: 1 } } }));
    const request = { db: store, env: env(), completion: completed(), transport: { request: transport } } as const;

    await observeDedicatedRegaugeCompletionForAdvisory(request);
    await observeDedicatedRegaugeCompletionForAdvisory(request);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(listArtifactManifests(store, "tenant_regauge_canary", "agent_verifier_telemetry")).toHaveLength(1);
  });

  it("makes zero provider calls when protected operator governance denies external egress", async () => {
    const store = db();
    grantLearningConsent(store, { id: "consent-regauge", tenantId: "tenant_regauge_canary", consentVersion: 1, purpose: VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE, residencyRegion: "cn", authorizedByPrincipalId: "human_approver", supersedesConsentId: null, effectiveAt: "2026-08-21T12:00:00.000Z", expiresAt: null, reason: "Approve bounded DeepSeek shadow verification.", idempotencyKey: "consent-regauge", createdAt: "2026-08-21T12:00:00.000Z" });
    const denied = env();
    denied.MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON = JSON.stringify({ schemaVersion: "2026-08-17.v1", entries: [{ tenantId: "tenant_regauge_canary", products: ["regauge"], dataClassification: "confidential", requiredRegion: "cn", processingRegion: "cn", consentId: "pending-durable-consent", evidenceRef: "github-environment:regauge-production", externalModelAllowed: false, mayLeaveTenantBoundary: false, consentActive: false }] });
    const transport = vi.fn();

    await expect(observeDedicatedRegaugeCompletionForAdvisory({
      db: store,
      env: denied,
      completion: completed(),
      transport: { request: transport },
    })).rejects.toThrow("verifier_governance_external_model_denied");

    expect(transport).not.toHaveBeenCalled();
    expect(listArtifactManifests(store, "tenant_regauge_canary", "agent_verifier_telemetry")).toHaveLength(0);
  });
});
