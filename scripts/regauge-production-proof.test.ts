import { describe, expect, it, vi } from "vitest";
import {
  establishRegaugeMachineContinuity,
  observeRegaugeDraftCanary,
  observeRegaugeVerifierEvidence,
  planRegaugeWorkerStart,
  runRegaugeReadinessSoak,
  verifyRegaugeMachineContinuity,
} from "./regauge-production-proof.js";

const installationId = 151_614_362;
const repositoryId = 84;
const baseRevision = "b".repeat(40);
const headRevision = "a".repeat(40);
const approvalRef = "approval:regauge:tenant-a:campaign-a:repository:84:revision:baseline:draft:1:run:9:attempt:1";
const runEvidenceRef = "evidence:github:run:9:attempt:1:revision:exact-head";
const currentEvidenceRefs = [runEvidenceRef] as const;
const releaseRevision = "d".repeat(40);
const volumeId = "vol_regauge";
const activationRunId = "33293506997";

function machinePair(workerState = "started") {
  return [{
    id: "coordinator-a",
    instance_id: "instance-coordinator-a",
    state: "started",
    config: {
      metadata: { fly_process_group: "coordinator" },
      env: {
        MENDPOINT_RELEASE_REVISION: releaseRevision,
        MENDPOINT_REGAUGE_COORDINATOR_ACTIVATION_RUN_ID: activationRunId,
      },
      mounts: [{ volume: volumeId, path: "/data" }],
    },
    image_ref: { labels: { GH_SHA: releaseRevision } },
    checks: [{ name: "regauge_coordinator", status: "passing" }],
  }, {
    id: "worker-a",
    instance_id: "instance-worker-a",
    state: workerState,
    config: {
      metadata: { fly_process_group: "worker" },
      env: {
        MENDPOINT_RELEASE_REVISION: releaseRevision,
        MENDPOINT_REGAUGE_ACTIVATION_RUN_ID: activationRunId,
      },
      mounts: [],
    },
    image_ref: { labels: { GH_SHA: releaseRevision } },
    checks: [{ name: "regauge_worker", status: "passing" }],
  }];
}

function deliveredDraftResult() {
  return {
    draft: {
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      wave: 1,
      deliveryId: "delivery-a",
      pullRequestNumber: 17,
      pullRequestUrl: "https://github.com/acme/repo/pull/17",
      baseBranch: "main",
      baseRevision,
      branchName: "mendpoint/regauge/unit-a",
      commitSha: headRevision,
      evidenceRefs: [...currentEvidenceRefs, "github:draft:17"],
      productionDeliveryApprovalRefs: [approvalRef],
    },
    target: { owner: "acme", repo: "repo", baseBranch: "main", installationId, remoteRepositoryId: repositoryId },
  };
}

function exactDraftObservation(overrides: Record<string, unknown> = {}) {
  return {
    state: "draft",
    baseRevision,
    headRevision,
    checks: "running",
    checkRevision: null,
    approvals: 0,
    approvalRevision: null,
    conversationsResolved: true,
    failures: [],
    checkIdentities: [],
    checkResults: [],
    reviewFeedback: { verdict: "none", changeRequests: [], comments: [] },
    repositoryId,
    installationId,
    matchingOpenDrafts: 1,
    changedPaths: ["src/example.ts"],
    remoteTreeSha: "c".repeat(40),
    evidenceRefs: ["github:repository:84"],
    ...overrides,
  } as const;
}

describe("Regauge production proof", () => {
  it("plans only a bounded worker start after exact pre-start topology validation", () => {
    expect(planRegaugeWorkerStart({
      machines: machinePair("stopped"),
      expectedRevision: releaseRevision,
      expectedVolumeId: volumeId,
      expectedRunId: activationRunId,
    })).toMatchObject({ workerId: "worker-a", workerState: "stopped", action: "start" });
    expect(planRegaugeWorkerStart({
      machines: machinePair("starting"),
      expectedRevision: releaseRevision,
      expectedVolumeId: volumeId,
      expectedRunId: activationRunId,
    })).toMatchObject({ workerState: "starting", action: "wait" });
    expect(planRegaugeWorkerStart({
      machines: machinePair("started"),
      expectedRevision: releaseRevision,
      expectedVolumeId: volumeId,
      expectedRunId: activationRunId,
    })).toMatchObject({ workerState: "started", action: "observe" });

    expect(() => planRegaugeWorkerStart({
      machines: [...machinePair("stopped"), machinePair("started")[1]],
      expectedRevision: releaseRevision,
      expectedVolumeId: volumeId,
      expectedRunId: activationRunId,
    })).toThrow("regauge_production_machine_topology_invalid");
    expect(() => planRegaugeWorkerStart({
      machines: machinePair("stopping"),
      expectedRevision: releaseRevision,
      expectedVolumeId: volumeId,
      expectedRunId: activationRunId,
    })).toThrow("regauge_production_worker_state_invalid");
  });

  it("rejects machine replacement, restart, or worker health drift during continuity", () => {
    const expected = establishRegaugeMachineContinuity({
      machines: machinePair(),
      expectedRevision: releaseRevision,
      expectedVolumeId: volumeId,
      expectedRunId: activationRunId,
    });
    expect(verifyRegaugeMachineContinuity({ machines: machinePair(), expected })).toEqual(expected);

    const restarted = machinePair();
    restarted[1]!.instance_id = "instance-worker-b";
    expect(() => verifyRegaugeMachineContinuity({ machines: restarted, expected }))
      .toThrow("regauge_production_machine_continuity_invalid");

    const unhealthy = machinePair();
    unhealthy[1]!.checks = [{ name: "regauge_worker", status: "critical" }];
    expect(() => verifyRegaugeMachineContinuity({ machines: unhealthy, expected }))
      .toThrow("regauge_production_machine_topology_invalid");
  });

  it("accepts only an exact tenant and campaign draft observation from GitHub", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      result: [deliveredDraftResult()],
      serverTime: "2026-08-14T12:00:00.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const observeDraft = vi.fn(async () => exactDraftObservation());

    const evidence = await observeRegaugeDraftCanary({
      coordinatorUrl: "https://mendpoint-regauge-production.fly.dev/",
      token: `me_${"a".repeat(40)}`,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      expectedApprovalRef: approvalRef,
      expectedEvidenceRefs: currentEvidenceRefs,
      expectedOwner: "acme",
      expectedRepository: "repo",
      expectedInstallationId: installationId,
      expectedRepositoryId: repositoryId,
      observeDraft,
      fetchImpl,
    });

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      pullRequests: [{ number: 17, url: "https://github.com/acme/repo/pull/17" }],
    });
    expect(observeDraft).toHaveBeenCalledWith(expect.objectContaining({
      owner: "acme",
      repo: "repo",
      pullRequestNumber: 17,
      expectedBaseBranch: "main",
      expectedBaseSha: baseRevision,
      expectedHeadBranch: "mendpoint/regauge/unit-a",
      expectedHeadSha: headRevision,
      expectedInstallationId: installationId,
      expectedRepositoryId: repositoryId,
      requireExactDraft: true,
      includeDeliveryEvidence: true,
    }), { installationId, repositoryId });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://mendpoint-regauge-production.fly.dev/v1/regauge/attempt-coordinator/draft-observations",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fails closed on empty, foreign, or non GitHub draft evidence", async () => {
    const response = (result: unknown) => vi.fn(async () => new Response(
      JSON.stringify({ result, serverTime: "2026-08-14T12:00:00.000Z" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const input = {
      coordinatorUrl: "https://mendpoint-regauge-production.fly.dev/",
      token: `me_${"a".repeat(40)}`,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      expectedApprovalRef: approvalRef,
      expectedEvidenceRefs: currentEvidenceRefs,
      expectedOwner: "acme",
      expectedRepository: "repo",
      expectedInstallationId: installationId,
      expectedRepositoryId: repositoryId,
      observeDraft: vi.fn(async () => exactDraftObservation()),
    };
    await expect(observeRegaugeDraftCanary({ ...input, fetchImpl: response([]) }))
      .rejects.toThrow("regauge_production_draft_canary_missing");
    await expect(observeRegaugeDraftCanary({
      ...input,
      fetchImpl: response([{ draft: { tenantId: "tenant-b" }, target: {} }]),
    })).rejects.toThrow("regauge_production_draft_canary_invalid");
    await expect(observeRegaugeDraftCanary({
      ...input,
      expectedRepository: "other",
      fetchImpl: response([{
        draft: {
          tenantId: "tenant-a", campaignId: "campaign-a", unitId: "unit-a",
          pullRequestNumber: 17, pullRequestUrl: "https://github.com/acme/repo/pull/17",
          commitSha: "a".repeat(40), evidenceRefs: [...currentEvidenceRefs, "github:draft:17"],
        },
        target: { owner: "acme", repo: "repo" },
      }]),
    })).rejects.toThrow("regauge_production_draft_canary_invalid");
  });

  it("rejects multiple durable drafts before remote observation", async () => {
    const observeDraft = vi.fn(async () => exactDraftObservation());
    await expect(observeRegaugeDraftCanary({
      coordinatorUrl: "https://mendpoint-regauge-production.fly.dev/",
      token: `me_${"a".repeat(40)}`,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      expectedApprovalRef: approvalRef,
      expectedEvidenceRefs: currentEvidenceRefs,
      expectedOwner: "acme",
      expectedRepository: "repo",
      expectedInstallationId: installationId,
      expectedRepositoryId: repositoryId,
      observeDraft,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        result: [deliveredDraftResult(), deliveredDraftResult()],
        serverTime: "2026-08-14T12:00:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } })),
    })).rejects.toThrow("regauge_production_draft_canary_cardinality_invalid");
    expect(observeDraft).not.toHaveBeenCalled();
  });

  it("rejects a durable draft unless GitHub proves one matching open draft", async () => {
    const input = {
      coordinatorUrl: "https://mendpoint-regauge-production.fly.dev/",
      token: `me_${"a".repeat(40)}`,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      expectedApprovalRef: approvalRef,
      expectedEvidenceRefs: currentEvidenceRefs,
      expectedOwner: "acme",
      expectedRepository: "repo",
      expectedInstallationId: installationId,
      expectedRepositoryId: repositoryId,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        result: [deliveredDraftResult()],
        serverTime: "2026-08-14T12:00:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } })),
    };
    await expect(observeRegaugeDraftCanary({
      ...input,
      observeDraft: vi.fn(async () => exactDraftObservation({ state: "closed" })),
    })).rejects.toThrow("regauge_production_draft_canary_remote_invalid");
    await expect(observeRegaugeDraftCanary({
      ...input,
      observeDraft: vi.fn(async () => exactDraftObservation({ matchingOpenDrafts: 2 })),
    })).rejects.toThrow("regauge_production_draft_canary_remote_invalid");
  });

  it("rejects a durable draft authorized by a prior protected run", async () => {
    const stale = deliveredDraftResult();
    stale.draft.evidenceRefs = [
      "evidence:github:run:8:attempt:1:revision:old-head",
      "github:draft:17",
    ];
    stale.draft.productionDeliveryApprovalRefs = [
      "approval:regauge:tenant-a:campaign-a:repository:84:revision:baseline:draft:1:run:8:attempt:1",
    ];
    const baseInput = {
      coordinatorUrl: "https://mendpoint-regauge-production.fly.dev/",
      token: `me_${"a".repeat(40)}`,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      expectedApprovalRef: approvalRef,
      expectedEvidenceRefs: currentEvidenceRefs,
      expectedOwner: "acme",
      expectedRepository: "repo",
      expectedInstallationId: installationId,
      expectedRepositoryId: repositoryId,
      observeDraft: vi.fn(async () => exactDraftObservation()),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        result: [stale],
        serverTime: "2026-08-14T12:00:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } })),
    };
    await expect(observeRegaugeDraftCanary(baseInput))
      .rejects.toThrow("regauge_production_draft_canary_invalid");
    expect(baseInput.observeDraft).not.toHaveBeenCalled();

    await expect(observeRegaugeDraftCanary({
      ...baseInput,
      expectedApprovalRef: "",
    })).rejects.toThrow("regauge_production_draft_canary_authority_invalid");
  });

  it("requires exact durable DeepSeek advisory provider evidence", async () => {
    const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      result: [{
        telemetryDigest: digest("a"), evidencePackDigest: digest("b"),
        provider: "deepseek", model: "deepseek-v4-flash", backendRevision: "deepseek-v4-flash-2026-08-24",
        observedAt: "2026-08-24T12:05:00.000Z", totalTokens: 44, estimatedCostUsd: 0.001,
        latencyMs: 320, scoreEvidenceDigests: [digest("c")], advisoryOnly: true, behaviorChanged: false,
        consentId: "consent_regauge_20260824", consentEffectiveAt: "2026-08-24T11:00:00.000Z",
        consentGrantedAt: "2026-08-24T11:01:00.000Z", consentExpiresAt: "2026-11-20T23:59:59.000Z",
        providerRequestedAt: "2026-08-24T12:04:00.000Z", providerProcessedAt: "2026-08-24T12:05:00.000Z", consentRecordDigest: digest("d"),
      }],
      serverTime: "2026-08-24T12:05:01.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await observeRegaugeVerifierEvidence({
      coordinatorUrl: "https://mendpoint-regauge-production.fly.dev/",
      token: `me_${"a".repeat(40)}`,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      expectedConsentId: "consent_regauge_20260824",
      fetchImpl,
    });
    expect(result.observation).toMatchObject({ provider: "deepseek", model: "deepseek-v4-flash", consentId: "consent_regauge_20260824", providerProcessedAt: "2026-08-24T12:05:00.000Z", advisoryOnly: true, behaviorChanged: false });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://mendpoint-regauge-production.fly.dev/v1/regauge/attempt-coordinator/verifier-observations",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects verifier evidence when durable consent did not predate provider processing", async () => {
    const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      result: [{
        telemetryDigest: digest("a"), evidencePackDigest: digest("b"), provider: "deepseek",
        model: "deepseek-v4-flash", backendRevision: "revision", observedAt: "2026-08-24T12:05:00.000Z",
        totalTokens: 12, estimatedCostUsd: 0.001, latencyMs: 2, scoreEvidenceDigests: [digest("c")],
        consentId: "consent_regauge_20260824", consentEffectiveAt: "2026-08-24T12:05:00.000Z",
        consentGrantedAt: "2026-08-24T12:05:01.000Z", consentExpiresAt: "2026-11-20T23:59:59.000Z",
        providerRequestedAt: "2026-08-24T12:04:00.000Z", providerProcessedAt: "2026-08-24T12:05:00.000Z", consentRecordDigest: digest("d"),
        advisoryOnly: true, behaviorChanged: false,
      }], serverTime: "2026-08-24T12:05:02.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(observeRegaugeVerifierEvidence({
      coordinatorUrl: "https://mendpoint-regauge-production.fly.dev/",
      token: `me_${"a".repeat(40)}`,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      expectedConsentId: "consent_regauge_20260824",
      fetchImpl,
    })).rejects.toThrow("regauge_production_verifier_evidence_invalid");
  });

  it("runs a bounded read only readiness soak against the exact deployment revision", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(
      String(url).endsWith("/version")
        ? { revision: "a".repeat(40) }
        : { status: "ok", checks: [{ name: "env", ok: true }] },
    ), { status: 200, headers: { "content-type": "application/json" } }));
    const report = await runRegaugeReadinessSoak({
      coordinatorUrl: "https://mendpoint-regauge-production.fly.dev/",
      expectedRevision: "a".repeat(40),
      durationSeconds: 3,
      intervalSeconds: 1,
      fetchImpl,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    expect(report).toMatchObject({ status: "completed", passed: true, samples: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]).toMatchObject({ method: "GET" });
    }
  });

  it("fails the soak when readiness or immutable revision drifts", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(
      String(url).endsWith("/version")
        ? { revision: "b".repeat(40) }
        : { status: "degraded", checks: [{ name: "storage", ok: false }] },
    ), { status: 200, headers: { "content-type": "application/json" } }));
    const report = await runRegaugeReadinessSoak({
      coordinatorUrl: "https://mendpoint-regauge-production.fly.dev/",
      expectedRevision: "a".repeat(40),
      durationSeconds: 1,
      intervalSeconds: 1,
      fetchImpl,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    expect(report).toMatchObject({ status: "failed", passed: false, samples: 1, failures: 1 });
  });
});
