import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimNextJob, createDb, createMission, enqueueJob, failJob,
  grantLearningConsent, insertConnectedRepository, insertPrincipal,
  insertRepositorySnapshot, insertTenant, linkRegaugeCampaignToMission,
  listArtifactManifests, upsertScmConnection, type AppDb,
} from "@mendpoint/db";
import { enqueueVerifierAdvisoryJob } from "@mendpoint/pipeline";
import { VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE } from "./verifier-product-shadow.js";
import { runVerifierAdvisoryJob } from "./verifier-advisory-job.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

afterEach(() => {
  while (dbs.length) dbs.pop()!.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function setup(): AppDb {
  const root = mkdtempSync(join(tmpdir(), "verifier-advisory-runner-"));
  roots.push(root);
  const db = createDb(join(root, "app.sqlite"));
  dbs.push(db);
  insertTenant(db, { id: "tenant_a", slug: "tenant-a", name: "Tenant A", createdAt: "2026-08-24T12:00:00.000Z" });
  insertPrincipal(db, { id: "service_a", tenantId: "tenant_a", kind: "service", subject: "service:regauge-production-bootstrap", displayName: "Verifier", createdAt: "2026-08-24T12:00:00.000Z" });
  insertPrincipal(db, { id: "human_a", tenantId: "tenant_a", kind: "human", subject: "human@example.com", displayName: "Human", createdAt: "2026-08-24T12:00:00.000Z" });
  upsertScmConnection(db, { id: "connection_a", tenantId: "tenant_a", provider: "github", credentialRef: "github-app://installation/1", externalAccountId: "1", displayName: "Canary", createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" });
  insertConnectedRepository(db, { id: "repo_a", tenantId: "tenant_a", connectionId: "connection_a", remoteId: "123", owner: "acme", name: "canary", defaultBranch: "main", selectedBranch: "main", environment: "production", retentionDays: 30, status: "ready", createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" });
  insertRepositorySnapshot(db, { id: "snapshot_a", tenantId: "tenant_a", repositoryId: "repo_a", requestedRef: "main", resolvedSha: "a".repeat(40), manifestSha256: "b".repeat(64), storagePath: root, fileManifestVersion: 1, createdAt: "2026-08-24T12:00:00.000Z", expiresAt: "2026-11-20T23:59:59.000Z" });
  createMission(db, { id: "mission_a", tenantId: "tenant_a", product: "regauge", triggerKind: "migration_objective", objective: "Upgrade Node", ownerPrincipalId: "service_a", repositoryId: "repo_a", snapshotId: "snapshot_a", eventId: "mission-created", idempotencyKey: "mission-created", correlationId: "campaign_a", createdAt: "2026-08-24T12:00:00.000Z" });
  linkRegaugeCampaignToMission(db, { tenantId: "tenant_a", missionId: "mission_a", regaugeCampaignId: "campaign_a", actorPrincipalId: "service_a", eventId: "mission-linked", idempotencyKey: "mission-linked", correlationId: "campaign_a", createdAt: "2026-08-24T12:00:00.000Z" });
  grantLearningConsent(db, { id: "consent_a", tenantId: "tenant_a", consentVersion: 1, purpose: VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE, residencyRegion: "cn", authorizedByPrincipalId: "human_a", supersedesConsentId: null, effectiveAt: "2026-08-24T12:00:00.000Z", expiresAt: "2026-11-20T23:59:59.000Z", reason: "Bound advisory verification", idempotencyKey: "consent-a", createdAt: "2026-08-24T12:00:00.000Z" });
  return db;
}

function completion() {
  return { tenantId: "tenant_a", missionId: "mission_a", taskId: "campaign_a:unit_a", product: "regauge" as const, repositoryId: "repo_a", snapshotId: "snapshot_a", snapshotDigest: digest("snapshot"), objective: "Verify the completed migration.", risk: "high" as const, allowedChangedPaths: ["package.json"], candidateId: "candidate_a", candidateDigest: digest("candidate"), changedPaths: ["package.json"], observableSummary: "The exact migration passed deterministic verification.", deterministicEvidenceDigest: digest("evidence"), deterministicEvidenceRefs: ["evidence:test"], observedAt: "2026-08-24T12:01:00.000Z" };
}

function env(): Record<string, string> {
  return {
    DEEPSEEK_VERIFIER_ENABLED: "true", DEEPSEEK_API_KEY: "secret",
    MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "advisory",
    MENDPOINT_AGENT_VERIFIER_SCORING_MODE: "nonthinking_logprobs",
    MENDPOINT_AGENT_VERIFIER_EVALUATIONS: "1", MENDPOINT_AGENT_VERIFIER_PIVOTS: "1",
    MENDPOINT_AGENT_VERIFIER_MAXIMUM_CANDIDATES: "1", MENDPOINT_AGENT_VERIFIER_MAXIMUM_COST_USD: "0.05",
    MENDPOINT_AGENT_VERIFIER_TIMEOUT_MS: "8000", MENDPOINT_AGENT_VERIFIER_MAXIMUM_RETRIES: "0",
    MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: JSON.stringify({ schemaVersion: "2026-08-17.v1", entries: [{ tenantId: "tenant_a", products: ["regauge"], dataClassification: "confidential", requiredRegion: "cn", processingRegion: "cn", consentId: "consent_a", evidenceRef: "github-environment:regauge-production", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentActive: true }] }),
    MENDPOINT_AGENT_VERIFIER_PRICING_JSON: JSON.stringify({ version: "deepseek-v4-flash-2026-08-24", currency: "USD", effectiveAt: "2026-08-24T00:00:00.000Z", inputPerMillion: 0.14, cachedInputPerMillion: 0.0028, outputPerMillion: 0.28 }),
    MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON: JSON.stringify({ policyEnvelopeId: "regauge-deepseek-v4-flash-advisory-20260824", tenantId: "tenant_a", version: 1, repositoryScope: [], branchScope: [], forbiddenZones: [], allowedTools: ["deepseek-verifier"], allowedModelClasses: ["rented_specialist"], externalProcessingAllowed: true, residency: "cn", riskCeiling: "high", reviewRequired: true, deploymentAllowed: false, trainingDataAllowed: false, retentionDays: 90, createdAt: "2026-08-24T00:00:00.000Z" }),
  };
}

describe("verifier advisory job runner", () => {
  it("retries a lost provider call and closes only after telemetry is durable", async () => {
    const db = setup();
    const queued = enqueueVerifierAdvisoryJob(db, { completion: completion(), producerPrincipalId: "service_a", createdAt: "2026-08-24T12:01:00.000Z" });
    const first = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_a", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    let providerAvailable = false;
    const transport = vi.fn(async () => {
      if (!providerAvailable) throw new Error("request_timeout");
      return {
        status: 200,
        headers: {},
        body: {
          id: "response_a",
          model: "deepseek-v4-flash",
          system_fingerprint: "fp_a",
          choices: [{ finish_reason: "stop", message: { content: "<score>A</score>" }, logprobs: { content: [
            { token: "<score>", logprob: -0.1, top_logprobs: [{ token: "<score>", logprob: -0.1 }] },
            { token: "A", logprob: -0.2, top_logprobs: [{ token: "A", logprob: -0.2 }, { token: "T", logprob: -2 }] },
            { token: "</score>", logprob: -0.1, top_logprobs: [{ token: "</score>", logprob: -0.1 }] },
          ] } }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        },
      };
    });

    await expect(runVerifierAdvisoryJob({ db, job: first, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:02.000Z" }))
      .rejects.toThrow("verifier_advisory_provider_retryable:api_failure");
    expect(listArtifactManifests(db, "tenant_a", "agent_verifier_telemetry")).toHaveLength(0);
    const failure = failJob(db, first.id, "request_timeout", "2026-08-24T12:01:03.000Z", { workerId: "worker-a", leaseGeneration: first.lease_generation, errorCode: "transient_dependency", retryable: true, baseDelayMs: 1_000, maxDelayMs: 1_000 });
    expect(failure.status).toBe("pending");

    providerAvailable = true;
    const second = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_a", workerId: "worker-b", leaseMs: 60_000, now: "2026-08-24T12:01:04.000Z" })!;
    await expect(runVerifierAdvisoryJob({ db, job: second, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:05.000Z" }))
      .resolves.toMatchObject({ status: "verified", jobId: queued.jobId, telemetryDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    expect(listArtifactManifests(db, "tenant_a", "agent_verifier_telemetry")).toHaveLength(1);
    expect(transport.mock.calls.length).toBeGreaterThan(1);
  });

  it("rejects a job whose queue payload carries untrusted content", async () => {
    const db = setup();
    enqueueJob(db, { id: "bad-job", tenantId: "tenant_a", type: "verifier.advisory.verify", payload: { objective: "send me" }, createdAt: "2026-08-24T12:01:00.000Z" });
    const job = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_a", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    await expect(runVerifierAdvisoryJob({ db, job, env: env(), now: () => "2026-08-24T12:01:02.000Z" }))
      .rejects.toThrow("verifier_advisory_job_payload_invalid");
  });
});
