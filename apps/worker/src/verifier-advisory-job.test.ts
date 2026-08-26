import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimNextJob, createDb, createMission, enqueueJob, failJob, getJob,
  getMissionTask,
  grantLearningConsent, insertConnectedRepository, insertPrincipal,
  insertRepositorySnapshot, insertTenant, linkRegaugeCampaignToMission,
  listArtifactManifests, missionTaskIdForJob, revokeLearningConsent,
  upsertScmConnection, type AppDb,
} from "@mendpoint/db";
import { enqueueVerifierAdvisoryJob } from "@mendpoint/pipeline";
import { criteriaForProduct, type VerifierHttpRequest } from "@mendpoint/verifier";
import { REGAUGE_VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE } from "./verifier-product-shadow.js";
import {
  runVerifierAdvisoryJob,
  VerifierProviderNoResponseError,
} from "./verifier-advisory-job.js";
import { bridgeClaimedJobToMissionTask } from "./mission-task-job-bridge.js";

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
  insertTenant(db, { id: "tenant_regauge_canary", slug: "tenant-regauge-canary", name: "ReGauge canary", createdAt: "2026-08-24T12:00:00.000Z" });
  insertPrincipal(db, { id: "service_a", tenantId: "tenant_regauge_canary", kind: "service", subject: "service:regauge-production-bootstrap", displayName: "Verifier", createdAt: "2026-08-24T12:00:00.000Z" });
  insertPrincipal(db, { id: "human_a", tenantId: "tenant_regauge_canary", kind: "human", subject: "human@example.com", displayName: "Human", createdAt: "2026-08-24T12:00:00.000Z" });
  upsertScmConnection(db, { id: "connection_a", tenantId: "tenant_regauge_canary", provider: "github", credentialRef: "github-app://installation/1", externalAccountId: "1", displayName: "Canary", createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" });
  insertConnectedRepository(db, { id: "repo_a", tenantId: "tenant_regauge_canary", connectionId: "connection_a", remoteId: "123", owner: "gondalaimafia", name: "mendpoint-canary-drill-20260801", defaultBranch: "main", selectedBranch: "codex/regauge-canary-baseline", environment: "production", retentionDays: 30, status: "ready", createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" });
  insertRepositorySnapshot(db, { id: "snapshot_a", tenantId: "tenant_regauge_canary", repositoryId: "repo_a", requestedRef: "codex/regauge-canary-baseline", resolvedSha: "a".repeat(40), manifestSha256: "b".repeat(64), storagePath: root, fileManifestVersion: 1, createdAt: "2026-08-24T12:00:00.000Z", expiresAt: "2026-11-20T23:59:59.000Z" });
  createMission(db, { id: "mission_a", tenantId: "tenant_regauge_canary", product: "regauge", triggerKind: "migration_objective", objective: "Upgrade Node", ownerPrincipalId: "service_a", repositoryId: "repo_a", snapshotId: "snapshot_a", eventId: "mission-created", idempotencyKey: "mission-created", correlationId: "campaign_regauge_canary_20260814", createdAt: "2026-08-24T12:00:00.000Z" });
  linkRegaugeCampaignToMission(db, { tenantId: "tenant_regauge_canary", missionId: "mission_a", regaugeCampaignId: "campaign_regauge_canary_20260814", actorPrincipalId: "service_a", eventId: "mission-linked", idempotencyKey: "mission-linked", correlationId: "campaign_regauge_canary_20260814", createdAt: "2026-08-24T12:00:00.000Z" });
  grantLearningConsent(db, { id: "consent_a", tenantId: "tenant_regauge_canary", consentVersion: 1, purpose: REGAUGE_VERIFIER_EXTERNAL_MODEL_CONSENT_PURPOSE, residencyRegion: "cn", authorizedByPrincipalId: "human_a", supersedesConsentId: null, effectiveAt: "2026-08-24T12:00:00.000Z", expiresAt: "2026-11-20T23:59:59.000Z", reason: "Bound advisory verification", idempotencyKey: "consent-a", createdAt: "2026-08-24T12:00:00.000Z" });
  return db;
}

function completion() {
  return { tenantId: "tenant_regauge_canary", missionId: "mission_a", taskId: "campaign_regauge_canary_20260814:unit_a", product: "regauge" as const, repositoryId: "repo_a", snapshotId: "snapshot_a", snapshotDigest: digest("snapshot"), objective: "Verify the completed migration.", risk: "high" as const, allowedChangedPaths: ["package.json"], candidateId: "candidate_a", candidateDigest: digest("candidate"), changedPaths: ["package.json"], observableSummary: "The exact migration passed deterministic verification.", deterministicEvidenceDigest: digest("evidence"), deterministicEvidenceRefs: ["evidence:test"], observedAt: "2026-08-24T12:01:00.000Z" };
}

function substantiveEvidence() {
  const content = JSON.stringify({
    path: "package.json",
    before: '{"engines":{"node":">=18"}}',
    after: '{"engines":{"node":">=20"}}',
  });
  return {
    schemaVersion: 1 as const,
    tenantId: "tenant_regauge_canary", repositoryId: "repo_a", snapshotId: "snapshot_a",
    snapshotDigest: digest("snapshot"), candidateId: "candidate_a", candidateDigest: digest("candidate"),
    changedPaths: ["package.json"],
    sources: [{ id: "candidate_diff_package_json", kind: "repository_excerpt" as const,
      digest: digest(content), locator: "snapshot_a:package.json", content }],
  };
}

function enqueue(db: AppDb) {
  return enqueueVerifierAdvisoryJob(db, {
    completion: completion(), substantiveEvidence: substantiveEvidence(),
    producerPrincipalId: "service_a", createdAt: "2026-08-24T12:01:00.000Z",
  });
}

function env(): Record<string, string> {
  return {
    DEEPSEEK_VERIFIER_ENABLED: "true", DEEPSEEK_API_KEY: "secret",
    MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "advisory",
    MENDPOINT_AGENT_VERIFIER_SCORING_MODE: "nonthinking_logprobs",
    MENDPOINT_AGENT_VERIFIER_EVALUATIONS: "1", MENDPOINT_AGENT_VERIFIER_PIVOTS: "1",
    MENDPOINT_AGENT_VERIFIER_MAXIMUM_CANDIDATES: "1", MENDPOINT_AGENT_VERIFIER_MAXIMUM_COST_USD: "0.05",
    MENDPOINT_AGENT_VERIFIER_TIMEOUT_MS: "8000", MENDPOINT_AGENT_VERIFIER_MAXIMUM_RETRIES: "0",
    MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: JSON.stringify({ schemaVersion: "2026-08-17.v1", entries: [{ tenantId: "tenant_regauge_canary", products: ["regauge"], dataClassification: "confidential", requiredRegion: "cn", processingRegion: "cn", consentId: "consent_a", evidenceRef: "github-environment:regauge-production", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentActive: true }] }),
    MENDPOINT_AGENT_VERIFIER_PRICING_JSON: JSON.stringify({ version: "deepseek-v4-flash-2026-08-24", currency: "USD", effectiveAt: "2026-08-24T00:00:00.000Z", inputPerMillion: 0.14, cachedInputPerMillion: 0.0028, outputPerMillion: 0.28 }),
    MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON: JSON.stringify({ policyEnvelopeId: "regauge-deepseek-v4-flash-advisory-20260824", tenantId: "tenant_regauge_canary", version: 1, repositoryScope: ["gondalaimafia/mendpoint-canary-drill-20260801"], branchScope: ["codex/regauge-canary-baseline"], forbiddenZones: [], allowedTools: ["deepseek-verifier"], allowedModelClasses: ["rented_specialist"], externalProcessingAllowed: true, residency: "cn", riskCeiling: "high", reviewRequired: true, deploymentAllowed: false, trainingDataAllowed: false, retentionDays: 90, createdAt: "2026-08-24T00:00:00.000Z" }),
  };
}

describe("verifier advisory job runner", () => {
  it("retries a lost provider call and closes only after telemetry is durable", async () => {
    const db = setup();
    const queued = enqueue(db);
    const first = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    let providerAvailable = false;
    const transport = vi.fn(async () => {
      if (!providerAvailable) throw new VerifierProviderNoResponseError("connection_refused_before_send");
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
    expect(listArtifactManifests(db, "tenant_regauge_canary", "agent_verifier_telemetry")).toHaveLength(0);
    const failure = failJob(db, first.id, "request_timeout", "2026-08-24T12:01:03.000Z", { workerId: "worker-a", leaseGeneration: first.lease_generation, errorCode: "transient_dependency", retryable: true, baseDelayMs: 1_000, maxDelayMs: 1_000 });
    expect(failure.status).toBe("pending");

    providerAvailable = true;
    const second = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-b", leaseMs: 60_000, now: "2026-08-24T12:01:04.000Z" })!;
    await expect(runVerifierAdvisoryJob({ db, job: second, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:05.000Z" }))
      .resolves.toMatchObject({ status: "verified", jobId: queued.jobId, telemetryDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    expect(listArtifactManifests(db, "tenant_regauge_canary", "agent_verifier_telemetry")).toHaveLength(1);
    expect(transport.mock.calls.length).toBeGreaterThan(1);
    expect(getMissionTask(db, "tenant_regauge_canary", missionTaskIdForJob(queued.jobId)))
      .toMatchObject({ status: "human_review_required", handoffReason: "architecture_decision_required" });
  });

  it("retries an Undici connection timeout that proves the provider was never reached", async () => {
    const db = setup();
    enqueue(db);
    const first = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    let providerAvailable = false;
    const transport = vi.fn(async (_request: VerifierHttpRequest) => {
      if (!providerAvailable) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connection timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
        });
      }
      return successfulProviderResponse();
    });

    await expect(runVerifierAdvisoryJob({ db, job: first, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:02.000Z" }))
      .rejects.toThrow("verifier_advisory_provider_retryable:api_failure");
    expect(listArtifactManifests(db, "tenant_regauge_canary", "agent_verifier_provider_no_response")).toHaveLength(1);
    failJob(db, first.id, "connect_timeout", "2026-08-24T12:01:03.000Z", { workerId: "worker-a", leaseGeneration: first.lease_generation, errorCode: "transient_dependency", retryable: true, baseDelayMs: 1_000, maxDelayMs: 1_000 });

    providerAvailable = true;
    const second = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-b", leaseMs: 60_000, now: "2026-08-24T12:01:04.000Z" })!;
    await expect(runVerifierAdvisoryJob({ db, job: second, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:05.000Z" }))
      .resolves.toMatchObject({ status: "verified" });
    expect(transport.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not mark an earlier successful provider receipt retryable after a later no-dispatch failure", async () => {
    const db = setup();
    enqueue(db);
    const first = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    let call = 0;
    let providerAvailable = false;
    const transport = vi.fn(async (_request: VerifierHttpRequest) => {
      call++;
      if (call === 1 || providerAvailable) return successfulProviderResponse();
      throw new VerifierProviderNoResponseError("connection_refused_before_send");
    });

    await expect(runVerifierAdvisoryJob({ db, job: first, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:02.000Z" }))
      .rejects.toThrow("verifier_advisory_provider_retryable:api_failure");
    const firstRequestId = transport.mock.calls[0]![0].headers["x-mendpoint-request-id"];
    expect(firstRequestId).toBeTruthy();
    failJob(db, first.id, "connect_refused", "2026-08-24T12:01:03.000Z", { workerId: "worker-a", leaseGeneration: first.lease_generation, errorCode: "transient_dependency", retryable: true, baseDelayMs: 1_000, maxDelayMs: 1_000 });

    providerAvailable = true;
    const second = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-b", leaseMs: 60_000, now: "2026-08-24T12:01:04.000Z" })!;
    await expect(runVerifierAdvisoryJob({ db, job: second, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:05.000Z" }))
      .resolves.toMatchObject({ status: "verified" });
    expect(transport.mock.calls.filter(([request]) =>
      request.headers["x-mendpoint-request-id"] === firstRequestId)).toHaveLength(1);
  });

  it("rejects backend-local retries on the durable ReGauge transport", async () => {
    const db = setup();
    enqueue(db);
    const job = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    const transport = vi.fn(async (_request: VerifierHttpRequest) => successfulProviderResponse());

    await expect(runVerifierAdvisoryJob({
      db,
      job,
      env: { ...env(), MENDPOINT_AGENT_VERIFIER_MAXIMUM_RETRIES: "1" },
      transport: { request: transport },
      now: () => "2026-08-24T12:01:02.000Z",
    })).rejects.toThrow("verifier_advisory_durable_retries_must_be_zero");
    expect(transport).not.toHaveBeenCalled();
  });

  it("refreshes the fenced job lease before every provider request", async () => {
    const db = setup();
    enqueue(db);
    const job = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 900_000, now: "2026-08-24T12:01:01.000Z" })!;
    const transport = vi.fn(async (_request: VerifierHttpRequest) => successfulProviderResponse());
    const refreshProviderLease = vi.fn(() => true);

    await expect(runVerifierAdvisoryJob({
      db,
      job,
      env: env(),
      transport: { request: transport },
      refreshProviderLease,
      now: () => "2026-08-24T12:01:02.000Z",
    })).resolves.toMatchObject({ status: "verified" });
    expect(refreshProviderLease).toHaveBeenCalledTimes(transport.mock.calls.length);
    expect(refreshProviderLease.mock.calls.length).toBeGreaterThan(0);
  });

  it("does not create an intent or call the provider when lease refresh fails", async () => {
    const db = setup();
    enqueue(db);
    const job = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 900_000, now: "2026-08-24T12:01:01.000Z" })!;
    const transport = vi.fn(async (_request: VerifierHttpRequest) => successfulProviderResponse());

    await expect(runVerifierAdvisoryJob({
      db,
      job,
      env: env(),
      transport: { request: transport },
      refreshProviderLease: () => false,
      now: () => "2026-08-24T12:01:02.000Z",
    })).rejects.toThrow("verifier_advisory_provider_retryable:api_failure");
    expect(transport).not.toHaveBeenCalled();
    expect(listArtifactManifests(db, "tenant_regauge_canary", "agent_verifier_provider_request_intent")).toHaveLength(0);
  });

  it("does not supersede earlier paid work when a later request loses its lease before intent", async () => {
    const db = setup();
    enqueue(db);
    const first = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 900_000, now: "2026-08-24T12:01:01.000Z" })!;
    const transport = vi.fn(async (_request: VerifierHttpRequest) => successfulProviderResponse());
    let refreshCount = 0;

    await expect(runVerifierAdvisoryJob({
      db,
      job: first,
      env: env(),
      transport: { request: transport },
      refreshProviderLease: () => ++refreshCount === 1,
      now: () => "2026-08-24T12:01:02.000Z",
    })).rejects.toThrow("verifier_advisory_provider_retryable:api_failure");

    expect(transport).toHaveBeenCalledTimes(1);
    const firstRequestId = transport.mock.calls[0]![0].headers["x-mendpoint-request-id"];
    expect(listArtifactManifests(
      db,
      "tenant_regauge_canary",
      "agent_verifier_provider_retryable_response",
    )).toHaveLength(0);

    failJob(db, first.id, "lease_lost", "2026-08-24T12:01:03.000Z", { workerId: "worker-a", leaseGeneration: first.lease_generation, errorCode: "transient_dependency", retryable: true, baseDelayMs: 1_000, maxDelayMs: 1_000 });
    const second = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-b", leaseMs: 900_000, now: "2026-08-24T12:01:04.000Z" })!;
    await expect(runVerifierAdvisoryJob({
      db,
      job: second,
      env: env(),
      transport: { request: transport },
      refreshProviderLease: () => true,
      now: () => "2026-08-24T12:01:05.000Z",
    })).resolves.toMatchObject({ status: "verified" });
    expect(transport.mock.calls.filter(([request]) =>
      request.headers["x-mendpoint-request-id"] === firstRequestId)).toHaveLength(1);
  });

  it.each([
    { label: "connection reset", error: Object.assign(new Error("socket reset after write"), { code: "ECONNRESET" }) },
    { label: "generic timeout", error: Object.assign(new Error("socket timed out"), { code: "ETIMEDOUT" }) },
    { label: "broken pipe", error: Object.assign(new Error("socket write failed"), { code: "EPIPE" }) },
    { label: "Undici socket error", error: Object.assign(new Error("socket failed"), { code: "UND_ERR_SOCKET" }) },
    { label: "Undici headers timeout", error: Object.assign(new Error("response headers timed out"), { code: "UND_ERR_HEADERS_TIMEOUT" }) },
    { label: "Undici body timeout", error: Object.assign(new Error("response body timed out"), { code: "UND_ERR_BODY_TIMEOUT" }) },
    { label: "Undici abort", error: Object.assign(new Error("request aborted"), { code: "UND_ERR_ABORTED" }) },
    { label: "AbortError", error: new DOMException("aborted", "AbortError") },
    { label: "backend deadline", error: new Error("verifier_backend_timeout") },
  ])("fails closed without retrying an ambiguous provider outcome: $label", async ({ error: providerError }) => {
    const db = setup();
    enqueue(db);
    const job = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    const transport = vi.fn(async (_request: VerifierHttpRequest) => { throw providerError; });

    await expect(runVerifierAdvisoryJob({ db, job, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:02.000Z" }))
      .rejects.toThrow("verifier_advisory_provider_outcome_unknown");
    expect(listArtifactManifests(db, "tenant_regauge_canary", "agent_verifier_provider_no_response")).toHaveLength(0);
    const calls = transport.mock.calls.length;

    await expect(runVerifierAdvisoryJob({ db, job, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:03.000Z" }))
      .rejects.toThrow("verifier_advisory_provider_outcome_unknown");
    expect(transport).toHaveBeenCalledTimes(calls);
  });

  it("seals a local deadline as outcome unknown instead of repeating provider work", async () => {
    const db = setup();
    enqueue(db);
    const job = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    const transport = vi.fn(async (_request: VerifierHttpRequest) => new Promise<never>(() => undefined));
    const shortDeadline = { ...env(), MENDPOINT_AGENT_VERIFIER_TIMEOUT_MS: "1" };

    await expect(runVerifierAdvisoryJob({ db, job, env: shortDeadline, transport: { request: transport }, now: () => "2026-08-24T12:01:02.000Z" }))
      .rejects.toThrow("verifier_advisory_provider_outcome_unknown");
    expect(listArtifactManifests(db, "tenant_regauge_canary", "agent_verifier_provider_no_response")).toHaveLength(0);
    expect(transport).toHaveBeenCalledTimes(1);

    await expect(runVerifierAdvisoryJob({ db, job, env: env(), transport: { request: async () => successfulProviderResponse() }, now: () => "2026-08-24T12:01:03.000Z" }))
      .rejects.toThrow("verifier_advisory_provider_outcome_unknown");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("atomically reconciles job completion and the review-first MissionTask handoff", async () => {
    const db = setup();
    const queued = enqueue(db);
    const job = claimNextJob(db, ["verifier.advisory.verify"], {
      tenantId: "tenant_regauge_canary",
      workerId: "worker-a",
      leaseMs: 60_000,
      now: "2026-08-24T12:01:01.000Z",
    })!;
    bridgeClaimedJobToMissionTask(db, job, "2026-08-24T12:01:01.000Z");
    const transport = vi.fn(async (_request: VerifierHttpRequest) => successfulProviderResponse());

    await expect(runVerifierAdvisoryJob({
      db,
      job,
      env: env(),
      transport: { request: transport },
      now: () => "2026-08-24T12:01:02.000Z",
      operationHooks: {
        afterMissionHandoffBeforeCommit: () => { throw new Error("simulated_settlement_crash"); },
      },
    })).rejects.toThrow("simulated_settlement_crash");
    expect(getJob(db, queued.jobId, "tenant_regauge_canary")?.status).toBe("running");
    expect(getMissionTask(db, "tenant_regauge_canary", missionTaskIdForJob(queued.jobId))?.status)
      .toBe("agent_working");
    const providerCalls = transport.mock.calls.length;

    await expect(runVerifierAdvisoryJob({
      db,
      job,
      env: env(),
      transport: { request: transport },
      now: () => "2026-08-24T12:01:03.000Z",
    })).resolves.toMatchObject({ status: "already_verified" });
    expect(transport).toHaveBeenCalledTimes(providerCalls);
    expect(getJob(db, queued.jobId, "tenant_regauge_canary")?.status).toBe("done");
    expect(getMissionTask(db, "tenant_regauge_canary", missionTaskIdForJob(queued.jobId)))
      .toMatchObject({ status: "human_review_required", handoffReason: "architecture_decision_required" });
  });

  it("rejects and withholds the mission-review handoff when the lease is stolen after the provider returns", async () => {
    const db = setup();
    const queued = enqueue(db);
    const job = claimNextJob(db, ["verifier.advisory.verify"], {
      tenantId: "tenant_regauge_canary",
      workerId: "worker-a",
      leaseMs: 60_000,
      now: "2026-08-24T12:01:01.000Z",
    })!;
    bridgeClaimedJobToMissionTask(db, job, "2026-08-24T12:01:01.000Z");
    const transport = vi.fn(async (_request: VerifierHttpRequest) => successfulProviderResponse());
    // Advisory scoring issues one provider request per criterion. Stealing the
    // lease before the final request would trip the per-request lease guard and
    // surface as a retryable provider failure, so steal only after the last
    // receipt is durable, in the window before the runner settles the job.
    const finalProviderRequest = criteriaForProduct("regauge").length;

    await expect(runVerifierAdvisoryJob({
      db,
      job,
      env: env(),
      transport: { request: transport },
      now: () => "2026-08-24T12:01:02.000Z",
      operationHooks: {
        // Steal the lease after the last provider receipt is durable but before
        // the runner settles the job. The post-provider fence must reject the
        // stale lease rather than completing and handing off to mission review.
        afterProviderReceipt: () => {
          if (transport.mock.calls.length < finalProviderRequest) return;
          failJob(db, job.id, "lease_stolen", "2026-08-24T12:01:01.500Z", {
            workerId: "worker-a",
            leaseGeneration: job.lease_generation,
            errorCode: "transient_dependency",
            retryable: true,
            baseDelayMs: 1_000,
            maxDelayMs: 1_000,
          });
        },
      },
    })).rejects.toThrow("verifier_advisory_lease_lost");

    // The stolen lease must leave the job un-completed and, decisively, the
    // MissionTask must NOT have been handed off to human review.
    expect(getJob(db, queued.jobId, "tenant_regauge_canary")?.status).not.toBe("done");
    expect(getMissionTask(db, "tenant_regauge_canary", missionTaskIdForJob(queued.jobId))?.status)
      .not.toBe("human_review_required");
  });

  it("fails closed without reissuing when a process dies after the provider returns but before a receipt is durable", async () => {
    const db = setup();
    enqueue(db);
    const first = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    const transport = vi.fn(async (_request: VerifierHttpRequest) => successfulProviderResponse());

    await expect(runVerifierAdvisoryJob({
      db, job: first, env: env(), transport: { request: transport },
      now: () => "2026-08-24T12:01:02.000Z",
      operationHooks: { afterProviderReturn: () => { throw new Error("simulated_crash"); } },
    })).rejects.toThrow("verifier_advisory_provider_outcome_unknown");
    const providerCallsAfterReturn = transport.mock.calls.length;
    expect(providerCallsAfterReturn).toBeGreaterThan(0);
    failJob(db, first.id, "simulated_crash", "2026-08-24T12:01:03.000Z", { workerId: "worker-a", leaseGeneration: first.lease_generation, errorCode: "transient_dependency", retryable: true, baseDelayMs: 1_000, maxDelayMs: 1_000 });
    const second = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-b", leaseMs: 60_000, now: "2026-08-24T12:01:04.000Z" })!;
    await expect(runVerifierAdvisoryJob({ db, job: second, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:05.000Z" }))
      .rejects.toThrow("verifier_advisory_provider_outcome_unknown");
    expect(transport).toHaveBeenCalledTimes(providerCallsAfterReturn);
  });

  it("recovers a durable provider response after a crash without repeating provider work", async () => {
    const db = setup();
    enqueue(db);
    const first = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    const transport = vi.fn(async (_request: VerifierHttpRequest) => successfulProviderResponse());

    await expect(runVerifierAdvisoryJob({
      db, job: first, env: env(), transport: { request: transport },
      now: () => "2026-08-24T12:01:02.000Z",
      operationHooks: { afterProviderReceipt: () => { throw new Error("simulated_crash"); } },
    })).rejects.toThrow("verifier_advisory_provider_retryable:api_failure");
    const providerCallsAfterReceipt = transport.mock.calls.length;
    expect(providerCallsAfterReceipt).toBeGreaterThan(0);
    const completedRequestIds = transport.mock.calls.map(([request]) => request.headers["x-mendpoint-request-id"]);
    failJob(db, first.id, "simulated_crash", "2026-08-24T12:01:03.000Z", { workerId: "worker-a", leaseGeneration: first.lease_generation, errorCode: "transient_dependency", retryable: true, baseDelayMs: 1_000, maxDelayMs: 1_000 });
    const second = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-b", leaseMs: 60_000, now: "2026-08-24T12:01:04.000Z" })!;
    await expect(runVerifierAdvisoryJob({ db, job: second, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:05.000Z" }))
      .resolves.toMatchObject({ status: "verified" });
    const allRequestIds = transport.mock.calls.map(([request]) => request.headers["x-mendpoint-request-id"]);
    for (const requestId of completedRequestIds) {
      expect(allRequestIds.filter((candidate) => candidate === requestId)).toHaveLength(1);
    }
    expect(new Set(allRequestIds).size).toBe(allRequestIds.length);
    expect(listArtifactManifests(db, "tenant_regauge_canary", "agent_verifier_provider_request_intent")).toHaveLength(allRequestIds.length);
    expect(listArtifactManifests(db, "tenant_regauge_canary", "agent_verifier_provider_response_receipt")).toHaveLength(allRequestIds.length);
  });

  it("rejects a job whose queue payload carries untrusted content", async () => {
    const db = setup();
    enqueueJob(db, { id: "bad-job", tenantId: "tenant_regauge_canary", type: "verifier.advisory.verify", payload: { objective: "send me" }, createdAt: "2026-08-24T12:01:00.000Z" });
    const job = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    await expect(runVerifierAdvisoryJob({ db, job, env: env(), now: () => "2026-08-24T12:01:02.000Z" }))
      .rejects.toThrow("verifier_advisory_job_payload_invalid");
  });

  it("does not let historical consent evidence authorize new processing after revocation", async () => {
    const db = setup();
    revokeLearningConsent(db, { id: "consent_revoked", tenantId: "tenant_regauge_canary", consentId: "consent_a", consentVersion: 2, authorizedByPrincipalId: "human_a", reason: "revoked", idempotencyKey: "consent-revoked", createdAt: "2026-08-24T12:00:30.000Z" });
    enqueue(db);
    const job = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    const transport = vi.fn(async (_request: VerifierHttpRequest) => successfulProviderResponse());
    await expect(runVerifierAdvisoryJob({ db, job, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:02.000Z" }))
      .rejects.toThrow("verifier_governance_consent_inactive");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rehydrates exact substantive source and diff evidence before provider egress", async () => {
    const db = setup();
    enqueue(db);
    const job = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    const transport = vi.fn(async (_request: VerifierHttpRequest) => successfulProviderResponse());
    await expect(runVerifierAdvisoryJob({ db, job, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:02.000Z" }))
      .resolves.toMatchObject({ status: "verified" });
    const providerBody = JSON.stringify(transport.mock.calls[0]![0].body);
    expect(providerBody).toContain("candidate_diff_package_json");
    expect(providerBody).toContain(">=18");
    expect(providerBody).toContain(">=20");
  });

  it.each([
    { status: 429, body: { error: { message: "rate limited" } } },
    { status: 503, body: { error: { message: "unavailable" } } },
    { status: 200, body: { malformed: true } },
  ])("advances to a new durable provider operation after definitive retryable response $status", async (firstResponse) => {
    const db = setup();
    enqueue(db);
    const first = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    let transient = true;
    const transport = vi.fn(async (_request: VerifierHttpRequest) => transient
      ? { status: firstResponse.status, headers: {}, body: firstResponse.body }
      : successfulProviderResponse());
    await expect(runVerifierAdvisoryJob({ db, job: first, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:02.000Z" }))
      .rejects.toThrow(/verifier_advisory_provider_retryable/);
    const firstCallCount = transport.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);
    failJob(db, first.id, "provider_retryable", "2026-08-24T12:01:03.000Z", { workerId: "worker-a", leaseGeneration: first.lease_generation, errorCode: "transient_dependency", retryable: true, baseDelayMs: 1_000, maxDelayMs: 1_000 });
    transient = false;
    const second = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-b", leaseMs: 60_000, now: "2026-08-24T12:01:04.000Z" })!;
    await expect(runVerifierAdvisoryJob({ db, job: second, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:05.000Z" }))
      .resolves.toMatchObject({ status: "verified" });
    expect(transport.mock.calls.length).toBeGreaterThan(firstCallCount);
    const operations = listArtifactManifests(db, "tenant_regauge_canary", "agent_verifier_provider_request_intent");
    expect(new Set(operations.map((artifact) => artifact.id)).size).toBe(operations.length);
  });

  it("fails closed before provider egress when the campaign scope drifts", async () => {
    const db = setup();
    const foreign = { ...completion(), taskId: "campaign_other:unit_a" };
    enqueueVerifierAdvisoryJob(db, { completion: foreign, substantiveEvidence: { ...substantiveEvidence(), changedPaths: foreign.changedPaths }, producerPrincipalId: "service_a", createdAt: foreign.observedAt });
    const job = claimNextJob(db, ["verifier.advisory.verify"], { tenantId: "tenant_regauge_canary", workerId: "worker-a", leaseMs: 60_000, now: "2026-08-24T12:01:01.000Z" })!;
    const transport = vi.fn(async () => ({ status: 200, headers: {}, body: {} }));
    await expect(runVerifierAdvisoryJob({ db, job, env: env(), transport: { request: transport }, now: () => "2026-08-24T12:01:02.000Z" }))
      .rejects.toThrow("verifier_advisory_scope_invalid");
    expect(transport).not.toHaveBeenCalled();
  });
});

function successfulProviderResponse() {
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
}
