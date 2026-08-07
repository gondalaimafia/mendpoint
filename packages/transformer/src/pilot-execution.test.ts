import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import { createOrganizationConstraintContract } from "./organization-constraints.js";
import {
  TransformerPilotExecutionStore,
  type TransformerAttemptFailureCode,
  type TransformerAttemptLease,
  type TransformerPilotCampaignInput,
  type TransformerPilotUnitInput,
  type TransformerScmObservation,
} from "./pilot-execution.js";
import { transformerAttemptId } from "./attempt-runner.js";
import { NODE_RUNTIME_18_TO_20_RECIPE, recipeReference } from "./recipe.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const revision = (character: string) => character.repeat(40);
const time = (minute: number) => `2026-08-02T08:${String(minute).padStart(2, "0")}:00.000Z`;

function gateConfig(): string {
  return JSON.stringify({
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantAllowlist: ["tenant-a"],
    environmentAllowlist: ["staging"],
    grants: [{
      tenantId: "tenant-a",
      environment: "staging",
      boundaries: ["worker_action", "delivery"],
      acceptanceEvidenceRefs: ["acceptance:pilot-a:v1"],
      productionDeliveryApprovalRefs: [],
    }],
  });
}

function constraints(repositoryIds = ["repo-a", "repo-b"]) {
  return createOrganizationConstraintContract({
    tenantId: "tenant-a",
    organizationId: "organization-a",
    version: 7,
    effectiveAt: time(0),
    sources: repositoryIds.map((repositoryId, index) => ({
      id: `policy-${repositoryId}`,
      kind: "explicit_policy" as const,
      repositoryId,
      revision: revision(index ? "b" : "a"),
      digest: digest(index ? "b" : "a"),
      locator: `policy://organization-a/${repositoryId}/v7`,
      evidenceRefs: [`evidence://policy/${repositoryId}/v7`],
    })),
    rules: repositoryIds.map((repositoryId) => ({
      id: `allow-${repositoryId}`,
      sourceId: `policy-${repositoryId}`,
      repositoryId,
      pathPattern: "**",
      actions: ["change"] as const,
      effect: "allow" as const,
      ownerIds: [`owner-${repositoryId}`],
      rationale: "Approved migration scope",
    })),
  });
}

function unit(id: string, repositoryId: string, source: string, candidate: string, dependsOn: string[] = []): TransformerPilotUnitInput {
  return {
    id,
    title: `Migrate ${repositoryId}`,
    ownerId: `owner-${repositoryId}`,
    reviewerIds: [`reviewer-${repositoryId}`],
    dependsOn,
    snapshot: {
      snapshotId: `snapshot-${repositoryId}`,
      repositoryId,
      revision: revision(source),
      manifestSha256: source.repeat(64),
      digest: digest(source),
      evidenceRefs: [`evidence://snapshot/${repositoryId}/${source}`],
    },
    candidateRevision: revision(candidate),
    candidateDigest: digest(candidate),
    recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
    changedPaths: ["package.json"],
  };
}

function runnableCampaign(campaignId: string, repositoryId = "repo-a", source = "a") {
  return {
    tenantId: "tenant-a",
    campaignId,
    environment: "staging",
    repositoryId,
    taskSnapshotId: `snapshot-${repositoryId}`,
    expectedBaseRevision: revision(source),
    sourceArtifactIds: [
      `snapshot-${repositoryId}`,
      `revision:${revision(source)}`,
      `manifest:${source.repeat(64)}`,
      digest(source),
    ],
  };
}

function createInput(units: TransformerPilotUnitInput[]): TransformerPilotCampaignInput {
  return {
    tenantId: "tenant-a",
    organizationId: "organization-a",
    environment: "staging",
    campaignId: "campaign-a",
    constraints: constraints([...new Set(units.map((candidate) => candidate.snapshot.repositoryId))]),
    units,
    observedAt: time(0),
    evidenceRefs: ["evidence://campaign/approved"],
    idempotencyKey: "create-campaign-a",
    gateConfig: gateConfig(),
  };
}

function mutation(minute: number, key: string) {
  return {
    tenantId: "tenant-a",
    campaignId: "campaign-a",
    observedAt: time(minute),
    evidenceRefs: [`evidence://operation/${key}`],
    idempotencyKey: key,
  };
}

function adaptiveAccounting(overrides: Partial<{
  plannerCalls: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  actualCostUsd: number;
  wallTimeMs: number;
}> = {}) {
  return {
    plannerCalls: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    actualCostUsd: 0,
    wallTimeMs: 0,
    ...overrides,
  };
}

function adaptiveHandoff(
  lease: TransformerAttemptLease,
  leaseToken: string,
  key: string,
  overrides: Partial<Parameters<TransformerPilotExecutionStore["recordAdaptiveCandidateHandoff"]>[0]> = {},
): Parameters<TransformerPilotExecutionStore["recordAdaptiveCandidateHandoff"]>[0] {
  return {
    ...mutation(2, key),
    unitId: lease.unitId,
    attemptId: transformerAttemptId(lease),
    attemptNumber: lease.attemptNumber,
    leaseGeneration: lease.leaseGeneration,
    leaseToken,
    repositoryId: lease.snapshot.repositoryId,
    snapshotId: lease.snapshot.snapshotId,
    baseBranch: "main",
    expectedBaseRevision: lease.snapshot.revision,
    divergedFromDigest: lease.candidateDigest,
    candidateDigest: digest("e"),
    failingCommandId: "runtime-declarations",
    changedPaths: ["package.json"],
    fileModes: Object.freeze({ "package.json": "100755" as const }),
    sealedPath: "/data/transformer-adaptive-candidates/tenant-a/approvals/candidate.json",
    sealedSha256: digest("f"),
    expiresAt: time(59),
    gateConfig: gateConfig(),
    ...overrides,
  };
}

function routingBinding(key: string, overrides: Record<string, unknown> = {}) {
  return {
    ...mutation(1, key),
    runId: "run-routing-a",
    envelopeId: "route-routing-a",
    outcomeIdempotencyKey: "outcome-routing-a",
    executorId: "transformer-attempt",
    providerId: "mendpoint-transformer",
    gateConfig: gateConfig(),
    ...overrides,
  };
}

function complete(store: TransformerPilotExecutionStore, unitId: string, minute: number, token: string, generation: number) {
  const candidate = store.getCampaign("tenant-a", "campaign-a")!.units.find((entry) => entry.id === unitId)!;
  return store.completeAttempt({
    ...mutation(minute, `complete-${unitId}-${generation}`),
    unitId,
    leaseGeneration: generation,
    leaseToken: token,
    sourceRevision: candidate.snapshot.revision,
    sourceDigest: candidate.snapshot.digest,
    candidateRevision: candidate.candidateRevision,
    candidateDigest: candidate.candidateDigest,
    verificationPassed: true,
    actualCostUsd: 0.25,
    accounting: adaptiveAccounting({ actualCostUsd: 0.25, wallTimeMs: 60_000 }),
    gateConfig: gateConfig(),
  });
}

function observation(unitId: string, state: "draft" | "merged" | "closed", source: string, candidate: string, overrides: Partial<TransformerScmObservation> = {}): TransformerScmObservation {
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
    reviewerEditLines: 2,
    legacyItemsRemoved: 3,
    evidenceRefs: [`evidence://scm/${unitId}/${state}`],
    ...overrides,
  };
}

function singleDraftCampaign(): TransformerPilotExecutionStore {
  const store = new TransformerPilotExecutionStore();
  store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
  const token = "lease-token-unit-a-00000001";
  const lease = store.claimNextAttempt({
    ...mutation(1, "claim-a"),
    leaseToken: token,
    leaseDurationMs: 3_600_000,
    gateConfig: gateConfig(),
  })!;
  complete(store, "unit-a", 2, token, lease.leaseGeneration);
  store.authorizeCurrentWaveDrafts({
    ...mutation(3, "draft-a"),
    gateConfig: gateConfig(),
  });
  return store;
}

describe("Transformer pilot execution coordinator", () => {
  it("binds a route to the claimed attempt and exposes one exact terminal success settlement", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    store.bindRoutingAttempt(routingBinding("bind-routing-success"));
    const token = "lease-token-routing-success-00001";
    const lease = store.claimNextAttempt({
      ...mutation(2, "claim-routing-success"),
      leaseToken: token,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    complete(store, "unit-a", 3, token, lease.leaseGeneration);

    expect(store.listPendingRoutingSettlements("tenant-a")).toEqual([
      expect.objectContaining({
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        unitId: "unit-a",
        runId: "run-routing-a",
        envelopeId: "route-routing-a",
        outcome: expect.objectContaining({
          idempotencyKey: "outcome-routing-a",
          executorId: "transformer-attempt",
          providerId: "mendpoint-transformer",
          outcome: "succeeded",
          actualCostUsd: null,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          verification: expect.objectContaining({
            verdict: "passed",
            evidenceArtifactIds: expect.arrayContaining([
              "evidence://operation/complete-unit-a-1",
            ]),
          }),
        }),
      }),
    ]);
    expect(store.getCampaign("tenant-a", "campaign-a")!.units[0]!.routingSettlement)
      .toMatchObject({
        attemptNumber: lease.attemptNumber,
        leaseGeneration: lease.leaseGeneration,
        leaseTokenDigest: lease.leaseTokenDigest,
      });

    const settlement = store.listPendingRoutingSettlements("tenant-a")[0]!;
    const markInput = {
      ...mutation(4, "mark-routing-success"),
      unitId: settlement.unitId,
      envelopeId: settlement.envelopeId,
      outcomeIdempotencyKey: settlement.outcome.idempotencyKey,
      gateConfig: gateConfig(),
    };
    const marked = store.markRoutingOutcomeSettled(markInput);
    expect(store.markRoutingOutcomeSettled(markInput)).toEqual(marked);
    expect(store.listPendingRoutingSettlements("tenant-a")).toEqual([]);
    expect(store.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "routing.outcome_settled"
    )).toHaveLength(1);
    store.close();
  });

  it("retains measured failure attribution and exact verification evidence for recovery", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    store.bindRoutingAttempt(routingBinding("bind-routing-failure"));
    const token = "lease-token-routing-failure-0001";
    const lease = store.claimNextAttempt({
      ...mutation(2, "claim-routing-failure"),
      leaseToken: token,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    store.recordAttemptFailure({
      ...mutation(3, "record-routing-failure"),
      unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration,
      leaseToken: token,
      code: "verification_failed",
      errorCode: "recipe_execution_verification_failed:runtime-declarations",
      accounting: adaptiveAccounting({
        plannerCalls: 1,
        modelCalls: 1,
        inputTokens: 50,
        outputTokens: 15,
        totalTokens: 65,
        actualCostUsd: 0.00008,
        wallTimeMs: 60_000,
      }),
      gateConfig: gateConfig(),
    });

    expect(store.listPendingRoutingSettlements("tenant-a")[0]?.outcome).toMatchObject({
      outcome: "failed",
      errorCode: "recipe_execution_verification_failed:runtime-declarations",
      actualCostUsd: 0.00008,
      inputTokens: 50,
      outputTokens: 15,
      totalTokens: 65,
      verification: {
        verdict: "failed",
        evidenceArtifactIds: ["evidence://operation/record-routing-failure"],
        verifierId: "transformer-attempt-verifier",
      },
    });
    store.close();
  });

  it("rejects an adaptive candidate handoff after the exact lease transfers", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const originalToken = "lease-token-adaptive-original-0001";
    const original = store.claimNextAttempt({
      ...mutation(1, "claim-adaptive-original"),
      leaseToken: originalToken,
      gateConfig: gateConfig(),
    })!;
    store.expireAttempt({
      ...mutation(2, "expire-adaptive-original"),
      unitId: original.unitId,
      leaseGeneration: original.leaseGeneration,
      gateConfig: gateConfig(),
    });
    const exceptionId = store.getCampaign("tenant-a", "campaign-a")!.exceptions[0]!.id;
    store.control({
      ...mutation(3, "authorize-adaptive-successor"),
      action: "authorize_retry",
      unitId: original.unitId,
    });
    store.control({
      ...mutation(4, "resolve-adaptive-original"),
      action: "resolve_exception",
      exceptionId,
      resolution: "Successor owns the retry",
    });
    store.control({ ...mutation(5, "resume-adaptive-successor"), action: "resume" });
    const successor = store.claimNextAttempt({
      ...mutation(6, "claim-adaptive-successor"),
      leaseToken: "lease-token-adaptive-successor-0001",
      gateConfig: gateConfig(),
    })!;

    expect(successor.leaseGeneration).toBe(original.leaseGeneration + 1);
    expect(() => store.recordAdaptiveCandidateHandoff(adaptiveHandoff(
      original,
      originalToken,
      "handoff-adaptive-original",
      { observedAt: time(7) },
    ))).toThrow("transformer_pilot_fence_stale");
    expect(store.getCampaign("tenant-a", "campaign-a")!.units[0]!.adaptiveCandidateHandoff)
      .toBeUndefined();
    expect(store.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.adaptive_candidate_handoff"
    )).toEqual([]);
    store.close();
  });

  it("replays an exact adaptive candidate handoff without another state transition", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const token = "lease-token-adaptive-replay-000001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-adaptive-replay"),
      leaseToken: token,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const input = adaptiveHandoff(lease, token, "handoff-adaptive-replay");

    const recorded = store.recordAdaptiveCandidateHandoff(input);
    const replayed = store.recordAdaptiveCandidateHandoff(input);

    expect(replayed).toEqual(recorded);
    expect(replayed.units[0]!.adaptiveCandidateHandoff).toMatchObject({
      attemptId: transformerAttemptId(lease),
      leaseGeneration: lease.leaseGeneration,
      repositoryId: "repo-a",
      snapshotId: "snapshot-repo-a",
      baseBranch: "main",
      expectedBaseRevision: revision("a"),
      divergedFromDigest: digest("c"),
      candidateDigest: digest("e"),
      changedPaths: ["package.json"],
    });
    expect(store.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.adaptive_candidate_handoff"
    )).toHaveLength(1);
    store.close();
  });

  it("rejects a conflicting adaptive candidate handoff replay", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const token = "lease-token-adaptive-conflict-0001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-adaptive-conflict"),
      leaseToken: token,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const input = adaptiveHandoff(lease, token, "handoff-adaptive-conflict");
    store.recordAdaptiveCandidateHandoff(input);

    expect(() => store.recordAdaptiveCandidateHandoff({
      ...input,
      baseBranch: "release",
    })).toThrow("transformer_pilot_idempotency_conflict");
    expect(store.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.adaptive_candidate_handoff"
    )).toHaveLength(1);
    store.close();
  });

  it("keeps the fenced handoff durable across a crash before App DB import", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-pilot-adaptive-handoff-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    let store = new TransformerPilotExecutionStore(path);
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const token = "lease-token-adaptive-crash-0000001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-adaptive-crash"),
      leaseToken: token,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const input = adaptiveHandoff(lease, token, "handoff-adaptive-crash");
    store.recordAdaptiveCandidateHandoff(input);
    store.close();

    store = new TransformerPilotExecutionStore(path);
    expect(store.getCampaign("tenant-a", "campaign-a")!.units[0]!.adaptiveCandidateHandoff)
      .toMatchObject({
        attemptId: transformerAttemptId(lease),
        leaseTokenDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        candidateDigest: digest("e"),
      });
    expect(store.listEvents("tenant-a", "campaign-a").at(-1)).toMatchObject({
      type: "attempt.adaptive_candidate_handoff",
      payload: {
        attemptId: transformerAttemptId(lease),
        candidateDigest: digest("e"),
      },
    });
    expect(store.listAdaptiveCandidateHandoffs("tenant-a", 10, gateConfig())).toHaveLength(1);
    const imported = {
      ...mutation(3, "adaptive-imported-after-crash"),
      unitId: lease.unitId,
      attemptId: transformerAttemptId(lease),
      candidateId: "candidate-after-crash",
      sealedSha256: input.sealedSha256,
      gateConfig: gateConfig(),
    };
    const marked = store.markAdaptiveCandidateHandoffImported(imported);
    expect(store.markAdaptiveCandidateHandoffImported(imported)).toEqual(marked);
    expect(() => store.markAdaptiveCandidateHandoffImported({
      ...imported,
      candidateId: "different-candidate-same-key",
    })).toThrow("transformer_pilot_idempotency_conflict");
    expect(() => store.markAdaptiveCandidateHandoffImported({
      ...imported,
      idempotencyKey: "adaptive-imported-after-crash-different-candidate",
      candidateId: "different-candidate-new-key",
    })).toThrow("transformer_pilot_adaptive_candidate_import_conflict");
    expect(marked.units[0]!.adaptiveCandidateHandoff).toMatchObject({
      candidateId: "candidate-after-crash",
      importedAt: time(3),
    });
    expect(store.listAdaptiveCandidateHandoffs("tenant-a", 10, gateConfig())).toEqual([]);
    store.close();
  });

  it("persists exact snapshots, versioned constraints, evidence, and idempotency across restart", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-pilot-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    let store = new TransformerPilotExecutionStore(path);
    const input = createInput([unit("unit-a", "repo-a", "a", "c")]);
    const created = store.createCampaign(input);
    expect(store.createCampaign(input)).toEqual(created);
    expect(created).toMatchObject({ revision: 1, constraintVersion: 7, constraintDigest: input.constraints.digest });
    store.close();

    store = new TransformerPilotExecutionStore(path);
    expect(store.getCampaign("tenant-a", "campaign-a")?.units[0]?.snapshot).toEqual(input.units[0]!.snapshot);
    expect(store.listEvents("tenant-a", "campaign-a")).toHaveLength(1);
    expect(store.getCampaign("tenant-b", "campaign-a")).toBeUndefined();
    store.close();
  });

  it("fails closed without a gate grant or organization path coverage", () => {
    const store = new TransformerPilotExecutionStore();
    const input = createInput([unit("unit-a", "repo-a", "a", "c")]);
    expect(() => store.createCampaign({ ...input, gateConfig: undefined })).toThrow("transformer_pilot_gate_denied");
    expect(() => store.createCampaign({
      ...input,
      idempotencyKey: "constraint-denied",
      units: [{ ...input.units[0]!, changedPaths: ["protected/secrets.txt"] }],
      constraints: createOrganizationConstraintContract({
        ...input.constraints,
        version: 8,
        rules: [{ ...input.constraints.rules[0]!, pathPattern: "src/**" }],
      }),
    })).toThrow("transformer_pilot_constraint_denied");
    store.close();
  });

  it("runs fenced attempts in dependency waves and permits only draft delivery decisions", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([
      unit("unit-a", "repo-a", "a", "c"),
      unit("unit-b", "repo-b", "b", "d", ["unit-a"]),
    ]));
    const tokenA = "lease-token-unit-a-00000001";
    const leaseA = store.claimNextAttempt({ ...mutation(1, "claim-a"), leaseToken: tokenA, leaseDurationMs: 3_600_000, gateConfig: gateConfig() })!;
    expect(leaseA).toMatchObject({ unitId: "unit-a", attemptNumber: 1, leaseGeneration: 1, constraintVersion: 7 });
    expect(() => complete(store, "unit-a", 2, "lease-token-unit-a-stale-1", 1)).toThrow("transformer_pilot_fence_stale");
    complete(store, "unit-a", 2, tokenA, 1);
    expect(store.claimNextAttempt({ ...mutation(3, "claim-blocked"), leaseToken: "lease-token-unit-b-00000001", gateConfig: gateConfig() })).toBeNull();
    expect(store.authorizeCurrentWaveDrafts({ ...mutation(3, "draft-a"), gateConfig: gateConfig() })).toEqual([
      expect.objectContaining({ type: "open_draft", unitId: "unit-a", draft: true, autoMerge: false, autoDeploy: false }),
    ]);
    store.reconcileWave({ ...mutation(4, "merge-a"), wave: 1, observations: [observation("unit-a", "merged", "a", "c")], gateConfig: gateConfig() });
    expect(store.claimNextAttempt({ ...mutation(5, "claim-b"), leaseToken: "lease-token-unit-b-00000001", gateConfig: gateConfig() })?.unitId).toBe("unit-b");
    store.close();
  });

  it("persists lease expiry across restart and expires only the exact running generation", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-pilot-expiry-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    let store = new TransformerPilotExecutionStore(path);
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-expiring-a"),
      leaseToken: "lease-token-unit-a-expiring-01",
      gateConfig: gateConfig(),
    })!;
    expect(lease.leaseExpiresAt).toBe(time(2));
    store.close();

    store = new TransformerPilotExecutionStore(path);
    expect(store.getCampaign("tenant-a", "campaign-a")?.units[0]?.leaseExpiresAt)
      .toBe(time(2));
    expect(store.listExpiredAttempts(time(2), "tenant-a")).toEqual([{
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      environment: "staging",
    }]);
    expect(() => store.expireAttempt({
      ...mutation(2, "expire-stale-generation"),
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration + 1,
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_fence_stale");
    expect(() => store.expireAttempt({
      ...mutation(1, "expire-too-early"),
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_fence_not_expired");

    const expirationInput = {
      ...mutation(2, "expire-exact-generation"),
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      gateConfig: gateConfig(),
    };
    const expired = store.expireAttempt(expirationInput);
    expect(expired).toMatchObject({
      state: "paused",
      units: [{ id: "unit-a", state: "failed", retryAuthorized: false }],
      exceptions: [{ code: "worker_crash", unitId: "unit-a", state: "open" }],
    });
    const revisionAfterExpiration = expired.revision;
    const eventsAfterExpiration = store.listEvents("tenant-a", "campaign-a").length;
    expect(store.expireAttempt(expirationInput)).toEqual(expired);
    expect(store.getCampaign("tenant-a", "campaign-a")?.revision).toBe(revisionAfterExpiration);
    expect(store.listEvents("tenant-a", "campaign-a")).toHaveLength(eventsAfterExpiration);
    expect(store.getCampaign("tenant-a", "campaign-a")?.exceptions).toHaveLength(1);

    store.control({
      ...mutation(3, "authorize-expired-retry"),
      action: "authorize_retry",
      unitId: "unit-a",
    });
    store.control({
      ...mutation(4, "resolve-expired-exception"),
      action: "resolve_exception",
      exceptionId: expired.exceptions[0]!.id,
      resolution: "Replacement worker is ready",
    });
    store.control({ ...mutation(5, "resume-expired-attempt"), action: "resume" });
    expect(store.listRunnableCampaigns("tenant-a")).toEqual([
      runnableCampaign("campaign-a"),
    ]);
    store.close();
  });

  it("rejects expired live fences and mutations at the deadline", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const token = "lease-token-unit-a-deadline-0001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-deadline-a"),
      leaseToken: token,
      gateConfig: gateConfig(),
    })!;
    const beforeDeadline = "2026-08-02T08:01:59.999Z";
    expect(() => store.assertCurrentAttemptFence({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: token,
      observedAt: beforeDeadline,
    })).not.toThrow();
    expect(() => store.assertCurrentAttemptFence({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: token,
      observedAt: time(2),
    })).toThrow("transformer_pilot_fence_expired");
    expect(() => complete(store, "unit-a", 2, token, lease.leaseGeneration))
      .toThrow("transformer_pilot_fence_expired");
    expect(() => store.recordAttemptFailure({
      ...mutation(2, "failure-at-deadline"),
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: token,
      code: "execution_failed",
      accounting: adaptiveAccounting({ wallTimeMs: 60_000 }),
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_fence_expired");
    expect(store.getCampaign("tenant-a", "campaign-a")).toMatchObject({
      state: "running",
      units: [{ state: "running", leaseGeneration: lease.leaseGeneration }],
      exceptions: [],
    });
    store.close();
  });

  it("validates lease duration and lists expired attempts with tenant and limit bounds", () => {
    const store = new TransformerPilotExecutionStore();
    const base = createInput([unit("unit-a", "repo-a", "a", "c")]);
    for (const campaignId of ["campaign-b", "campaign-a"] as const) {
      store.createCampaign({
        ...base,
        campaignId,
        idempotencyKey: `create-${campaignId}`,
      });
      store.claimNextAttempt({
        ...mutation(1, `claim-${campaignId}`),
        campaignId,
        leaseToken: `lease-token-${campaignId}-00000001`,
        gateConfig: gateConfig(),
      });
    }
    expect(store.listExpiredAttempts("2026-08-02T08:01:59.999Z")).toEqual([]);
    expect(store.listExpiredAttempts(time(2), "tenant-a", 1)).toEqual([{
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      leaseGeneration: 1,
      environment: "staging",
    }]);
    expect(store.listExpiredAttempts(time(2), "tenant-b")).toEqual([]);
    expect(() => store.listExpiredAttempts(time(2), undefined, 0))
      .toThrow("transformer_pilot_attempt_limit_invalid");
    expect(() => store.listExpiredAttempts(time(2), undefined, 101))
      .toThrow("transformer_pilot_attempt_limit_invalid");

    const isolated = new TransformerPilotExecutionStore();
    isolated.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    for (const leaseDurationMs of [999, 3_600_001, 1.5]) {
      expect(() => isolated.claimNextAttempt({
        ...mutation(1, `invalid-duration-${leaseDurationMs}`),
        leaseToken: "lease-token-invalid-duration-0001",
        leaseDurationMs,
        gateConfig: gateConfig(),
      })).toThrow("transformer_pilot_lease_duration_invalid");
    }
    isolated.close();
    store.close();
  });

  it("uses WAL and a bounded busy wait without corrupting committed state", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-pilot-wal-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    const first = new TransformerPilotExecutionStore(path);
    first.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const second = new TransformerPilotExecutionStore(path);
    expect(second.getCampaign("tenant-a", "campaign-a")?.campaignId).toBe("campaign-a");

    const probe = new DatabaseSync(path);
    expect(probe.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(probe.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    probe.close();

    const blocker = new DatabaseSync(path);
    blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    const startedAt = Date.now();
    try {
      expect(() => second.createCampaign({
        ...createInput([unit("unit-b", "repo-b", "b", "d")]),
        campaignId: "campaign-b",
        idempotencyKey: "create-campaign-b-while-locked",
      })).toThrow(/database is locked/i);
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(4_000);
      expect(elapsedMs).toBeLessThan(10_000);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    expect(first.getCampaign("tenant-a", "campaign-a")?.campaignId).toBe("campaign-a");
    expect(second.getCampaign("tenant-a", "campaign-b")).toBeUndefined();
    second.close();
    first.close();
  }, 15_000);

  it("replays the exact active lease across connections for the same claim key and token", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-pilot-claim-replay-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    const first = new TransformerPilotExecutionStore(path);
    const second = new TransformerPilotExecutionStore(path);
    first.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const claim = {
      ...mutation(1, "claim-replay-a"),
      leaseToken: "lease-token-claim-replay-000001",
      leaseDurationMs: 60_000,
      gateConfig: gateConfig(),
    };

    const original = first.claimNextAttempt(claim);
    const replay = second.claimNextAttempt(claim);

    expect(original).not.toBeNull();
    expect(replay).toEqual(original);
    expect(first.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.claimed"
    )).toHaveLength(1);
    expect(second.getCampaign("tenant-a", "campaign-a")).toMatchObject({
      units: [{ state: "running", attemptNumber: 1, leaseGeneration: 1 }],
    });
    second.close();
    first.close();
  });

  it("rejects a conflicting claim replay and never grants a second active lease", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-pilot-claim-conflict-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    const first = new TransformerPilotExecutionStore(path);
    const second = new TransformerPilotExecutionStore(path);
    first.createCampaign(createInput([
      unit("unit-a", "repo-a", "a", "c"),
      unit("unit-b", "repo-b", "b", "d"),
    ]));
    const original = first.claimNextAttempt({
      ...mutation(1, "claim-conflict-a"),
      leaseToken: "lease-token-claim-original-00001",
      leaseDurationMs: 60_000,
      gateConfig: gateConfig(),
    });

    expect(() => second.claimNextAttempt({
      ...mutation(1, "claim-conflict-a"),
      leaseToken: "lease-token-claim-conflict-00001",
      leaseDurationMs: 60_000,
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_idempotency_conflict");
    expect(second.claimNextAttempt({
      ...mutation(1, "claim-second-key"),
      leaseToken: "lease-token-claim-second-key-001",
      leaseDurationMs: 60_000,
      gateConfig: gateConfig(),
    })).toBeNull();
    expect(original).toMatchObject({ unitId: "unit-a", leaseGeneration: 1 });
    expect(second.getCampaign("tenant-a", "campaign-a")!.units.filter((candidate) =>
      candidate.state === "running"
    )).toEqual([
      expect.objectContaining({ id: "unit-a", leaseGeneration: 1 }),
    ]);
    expect(first.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.claimed"
    )).toHaveLength(1);
    second.close();
    first.close();
  });

  it("replays each stored lease after a failed attempt is retried and completed", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-pilot-claim-history-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    const first = new TransformerPilotExecutionStore(path);
    const second = new TransformerPilotExecutionStore(path);
    first.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const initialClaim = {
      ...mutation(1, "claim-history-initial"),
      leaseToken: "lease-token-claim-history-initial-01",
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    };
    const initialLease = first.claimNextAttempt(initialClaim)!;
    const failed = first.recordAttemptFailure({
      ...mutation(2, "claim-history-failure"),
      unitId: initialLease.unitId,
      leaseGeneration: initialLease.leaseGeneration,
      leaseToken: initialClaim.leaseToken,
      code: "execution_failed",
      accounting: adaptiveAccounting({ wallTimeMs: 60_000 }),
      gateConfig: gateConfig(),
    });
    first.control({
      ...mutation(3, "claim-history-authorize"),
      action: "authorize_retry",
      unitId: initialLease.unitId,
    });
    first.control({
      ...mutation(4, "claim-history-resolve"),
      action: "resolve_exception",
      exceptionId: failed.exceptions[0]!.id,
      resolution: "Worker recovered with the original evidence retained",
    });
    first.control({ ...mutation(5, "claim-history-resume"), action: "resume" });
    const retryClaim = {
      ...mutation(6, "claim-history-retry"),
      leaseToken: "lease-token-claim-history-retry-0001",
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    };
    const retryLease = first.claimNextAttempt(retryClaim)!;
    complete(first, retryLease.unitId, 7, retryClaim.leaseToken, retryLease.leaseGeneration);

    expect(second.claimNextAttempt(initialClaim)).toEqual(initialLease);
    expect(second.claimNextAttempt(retryClaim)).toEqual(retryLease);
    expect(second.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.claimed"
    )).toHaveLength(2);
    second.close();
    first.close();
  });

  it("binds the claimed candidate and enforces the current attempt fence", () => {
    const store = new TransformerPilotExecutionStore();
    const input = createInput([unit("unit-a", "repo-a", "a", "c")]);
    store.createCampaign(input);
    const token = "lease-token-unit-a-00000001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-fence-a"),
      leaseToken: token,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;

    expect(lease).toMatchObject({
      unitId: "unit-a",
      candidateRevision: input.units[0]!.candidateRevision,
      candidateDigest: input.units[0]!.candidateDigest,
      changedPaths: input.units[0]!.changedPaths,
    });
    expect(() => store.assertCurrentAttemptFence({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: token,
      observedAt: time(1),
    })).not.toThrow();
    expect(() => store.assertCurrentAttemptFence({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration + 1,
      leaseToken: token,
      observedAt: time(1),
    })).toThrow("transformer_pilot_fence_stale");
    expect(() => store.assertCurrentAttemptFence({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: "lease-token-unit-a-stale-0001",
      observedAt: time(1),
    })).toThrow("transformer_pilot_fence_stale");
    expect(() => store.assertCurrentAttemptFence({
      tenantId: "tenant-b",
      campaignId: "campaign-a",
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: token,
      observedAt: time(1),
    })).toThrow("transformer_pilot_campaign_not_found");
    expect(() => store.assertCurrentAttemptFence({
      tenantId: "tenant-a",
      campaignId: "campaign-missing",
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: token,
      observedAt: time(1),
    })).toThrow("transformer_pilot_campaign_not_found");

    complete(store, "unit-a", 2, token, lease.leaseGeneration);
    expect(() => store.assertCurrentAttemptFence({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: token,
      observedAt: time(2),
    })).toThrow("transformer_pilot_attempt_not_running");
    store.close();
  });

  it("still rejects an unapproved divergent candidate as candidate_drift", () => {
    // The adaptive-candidate review path never routes a divergent candidate
    // through completeAttempt. This guarantee — the deterministic drift check —
    // must remain intact: completing with a digest that diverges from the
    // lease-bound deterministic recipe output is rejected, and the unit is not
    // advanced to executed.
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const token = "lease-token-unit-a-00000001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-drift-a"),
      leaseToken: token,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    expect(() =>
      store.completeAttempt({
        ...mutation(2, "complete-divergent-a"),
        unitId: "unit-a",
        leaseGeneration: lease.leaseGeneration,
        leaseToken: token,
        sourceRevision: lease.snapshot.revision,
        sourceDigest: lease.snapshot.digest,
        candidateRevision: lease.candidateRevision,
        // A converged adaptive fix diverges from the deterministic output digest.
        candidateDigest: digest("e"),
        verificationPassed: true,
        actualCostUsd: 0,
        accounting: adaptiveAccounting({ wallTimeMs: 60_000 }),
        gateConfig: gateConfig(),
      }),
    ).toThrow("transformer_pilot_candidate_drift");
    expect(
      store.getCampaign("tenant-a", "campaign-a")!.units.find((entry) => entry.id === "unit-a")!.state,
    ).toBe("running");
    store.close();
  });

  it("records one typed fenced attempt failure and replays it idempotently", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const token = "lease-token-unit-a-00000001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-failure-a"),
      leaseToken: token,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const before = store.getCampaign("tenant-a", "campaign-a")!;

    expect(() => store.recordAttemptFailure({
      ...mutation(2, "stale-failure-generation"),
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration + 1,
      leaseToken: token,
      code: "candidate_drift",
      accounting: adaptiveAccounting({ wallTimeMs: 60_000 }),
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_fence_stale");
    expect(() => store.recordAttemptFailure({
      ...mutation(2, "stale-failure-token"),
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: "lease-token-unit-a-stale-0001",
      code: "candidate_drift",
      accounting: adaptiveAccounting({ wallTimeMs: 60_000 }),
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_fence_stale");
    expect(store.getCampaign("tenant-a", "campaign-a")).toEqual(before);

    expect(() => store.recordAttemptFailure({
      ...mutation(2, "invalid-failure-code"),
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: token,
      observedAt: time(2),
      code: "ci_failure" as TransformerAttemptFailureCode,
      accounting: adaptiveAccounting({ wallTimeMs: 60_000 }),
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_failure_code_invalid");

    const failureInput = {
      ...mutation(2, "candidate-drift-failure"),
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: token,
      code: "candidate_drift" as const,
      accounting: adaptiveAccounting({ wallTimeMs: 60_000 }),
      gateConfig: gateConfig(),
    };
    const failed = store.recordAttemptFailure(failureInput);
    expect(failed).toMatchObject({
      state: "paused",
      units: [{ id: "unit-a", state: "failed", retryAuthorized: false }],
      exceptions: [{
        code: "candidate_drift",
        unitId: "unit-a",
        state: "open",
        evidenceRefs: failureInput.evidenceRefs,
      }],
    });
    const eventCount = store.listEvents("tenant-a", "campaign-a").length;
    expect(store.recordAttemptFailure(failureInput)).toEqual(failed);
    expect(store.getCampaign("tenant-a", "campaign-a")?.revision).toBe(failed.revision);
    expect(store.listEvents("tenant-a", "campaign-a")).toHaveLength(eventCount);
    expect(store.getCampaign("tenant-a", "campaign-a")?.exceptions).toHaveLength(1);
    expect(() => store.assertCurrentAttemptFence({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: token,
      observedAt: time(2),
    })).toThrow("transformer_pilot_campaign_not_running");

    store.control({
      ...mutation(3, "authorize-candidate-drift-retry"),
      action: "authorize_retry",
      unitId: "unit-a",
    });
    store.control({
      ...mutation(4, "resolve-candidate-drift"),
      action: "resolve_exception",
      exceptionId: failed.exceptions[0]!.id,
      resolution: "Candidate was regenerated from the claimed source",
    });
    store.control({
      ...mutation(5, "resume-candidate-drift"),
      action: "resume",
    });
    expect(store.listRunnableCampaigns("tenant-a")).toEqual([
      runnableCampaign("campaign-a"),
    ]);
    store.close();
  });

  it("lists only runnable campaigns in stable bounded tenant order without mutation", () => {
    const store = new TransformerPilotExecutionStore();
    const base = createInput([unit("unit-a", "repo-a", "a", "c")]);
    for (const [campaignId, observedAt] of [
      ["campaign-z", time(2)],
      ["campaign-b", time(1)],
      ["campaign-a", time(1)],
    ] as const) {
      store.createCampaign({
        ...base,
        campaignId,
        observedAt,
        idempotencyKey: `create-${campaignId}`,
      });
    }
    const eventsBefore = ["campaign-a", "campaign-b", "campaign-z"].map(
      (campaignId) => store.listEvents("tenant-a", campaignId).length,
    );

    expect(store.listRunnableCampaigns()).toEqual([
      runnableCampaign("campaign-a"),
      runnableCampaign("campaign-b"),
      runnableCampaign("campaign-z"),
    ]);
    expect(store.listRunnableCampaigns("tenant-a", 2).map((item) => item.campaignId))
      .toEqual(["campaign-a", "campaign-b"]);
    expect(store.listRunnableCampaigns("tenant-b")).toEqual([]);
    expect(() => store.listRunnableCampaigns(undefined, 0))
      .toThrow("transformer_pilot_campaign_limit_invalid");
    expect(() => store.listRunnableCampaigns(undefined, 101))
      .toThrow("transformer_pilot_campaign_limit_invalid");

    store.claimNextAttempt({
      ...mutation(3, "claim-campaign-z"),
      campaignId: "campaign-z",
      leaseToken: "lease-token-campaign-z-000001",
      gateConfig: gateConfig(),
    });
    store.control({
      ...mutation(3, "pause-campaign-b"),
      campaignId: "campaign-b",
      action: "pause",
    });
    expect(store.listRunnableCampaigns("tenant-a")).toEqual([
      runnableCampaign("campaign-a"),
    ]);
    expect(["campaign-a", "campaign-b", "campaign-z"].map(
      (campaignId) => store.listEvents("tenant-a", campaignId).length,
    )).toEqual(eventsBefore.map((count, index) => count + (index === 0 ? 0 : 1)));
    store.close();
  });

  it("recovers a crash only after attributable retry authorization and exception resolution", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const token = "lease-token-unit-a-00000001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-a"),
      leaseToken: token,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const crashed = store.recordWorkerCrash({
      ...mutation(2, "crash-a"),
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: token,
      accounting: adaptiveAccounting({ wallTimeMs: 60_000 }),
      gateConfig: gateConfig(),
    });
    expect(crashed).toMatchObject({ state: "paused", units: [expect.objectContaining({ state: "failed", retryAuthorized: false })] });
    expect(store.claimNextAttempt({ ...mutation(3, "claim-before-retry"), leaseToken: "lease-token-unit-a-00000002", gateConfig: gateConfig() })).toBeNull();
    store.control({ ...mutation(3, "retry-a"), action: "authorize_retry", unitId: "unit-a" });
    const exceptionId = store.getCampaign("tenant-a", "campaign-a")!.exceptions[0]!.id;
    store.control({ ...mutation(4, "resolve-crash"), action: "resolve_exception", exceptionId, resolution: "Worker replacement is healthy" });
    store.control({ ...mutation(5, "resume-after-crash"), action: "resume" });
    const retry = store.claimNextAttempt({ ...mutation(6, "claim-retry"), leaseToken: "lease-token-unit-a-00000002", gateConfig: gateConfig() });
    expect(retry).toMatchObject({ attemptNumber: 2, leaseGeneration: 2 });
    store.close();
  });

  it("halts on CI, drift, unresolved conversations, and partial merge evidence", () => {
    const scenarios: Array<[string, Partial<TransformerScmObservation>, string]> = [
      ["ci", { checks: "failure" }, "ci_failure"],
      ["drift", { headRevision: revision("f") }, "head_drift"],
      ["conversation", { conversationsResolved: false }, "conversation_unresolved"],
    ];
    for (const [name, overrides, code] of scenarios) {
      const store = new TransformerPilotExecutionStore();
      store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
      const token = `lease-token-unit-a-${name}-000001`;
      store.claimNextAttempt({ ...mutation(1, `claim-${name}`), leaseToken: token, leaseDurationMs: 3_600_000, gateConfig: gateConfig() });
      complete(store, "unit-a", 2, token, 1);
      store.authorizeCurrentWaveDrafts({ ...mutation(3, `draft-${name}`), gateConfig: gateConfig() });
      const result = store.reconcileWave({ ...mutation(4, `observe-${name}`), wave: 1, observations: [observation("unit-a", "draft", "a", "c", overrides)], gateConfig: gateConfig() });
      expect(result.state).toBe("paused");
      expect(result.exceptions.some((exception) => exception.code === code)).toBe(true);
      store.close();
    }

    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([
      unit("unit-a", "repo-a", "a", "c"),
      unit("unit-b", "repo-b", "b", "d"),
    ]));
    for (const [id, token, minute] of [["unit-a", "lease-token-unit-a-00000001", 1], ["unit-b", "lease-token-unit-b-00000001", 3]] as const) {
      const lease = store.claimNextAttempt({ ...mutation(minute, `claim-${id}`), leaseToken: token, leaseDurationMs: 3_600_000, gateConfig: gateConfig() })!;
      complete(store, id, minute + 1, token, lease.leaseGeneration);
    }
    store.authorizeCurrentWaveDrafts({ ...mutation(5, "draft-wave"), gateConfig: gateConfig() });
    const partial = store.reconcileWave({
      ...mutation(6, "partial-merge"),
      wave: 1,
      observations: [observation("unit-a", "merged", "a", "c"), observation("unit-b", "draft", "b", "d")],
      gateConfig: gateConfig(),
    });
    expect(partial.exceptions.some((exception) => exception.code === "partial_wave_merge")).toBe(true);
    expect(partial.units.map((entry) => entry.state)).toEqual(["merged", "accepted"]);
    store.close();
  });

  it("does not record a merge until exact CI, approval, revision, and conversation gates pass", () => {
    const scenarios: Array<{
      name: string;
      overrides: Partial<TransformerScmObservation>;
      exception: string;
    }> = [
      { name: "running-ci", overrides: { checks: "running" }, exception: "ci_incomplete" },
      { name: "missing-ci", overrides: { checks: "missing", checkRevision: null }, exception: "ci_incomplete" },
      { name: "stale-ci", overrides: { checkRevision: revision("f") }, exception: "ci_evidence_stale" },
      { name: "missing-approval", overrides: { approvals: 0, approvalRevision: null }, exception: "review_incomplete" },
      { name: "stale-approval", overrides: { approvalRevision: revision("f") }, exception: "review_evidence_stale" },
      { name: "stale-head", overrides: { headRevision: revision("f") }, exception: "head_drift" },
      { name: "conversation", overrides: { conversationsResolved: false }, exception: "conversation_unresolved" },
    ];

    for (const scenario of scenarios) {
      const store = singleDraftCampaign();
      const result = store.reconcileWave({
        ...mutation(4, `invalid-merge-${scenario.name}`),
        wave: 1,
        observations: [observation("unit-a", "merged", "a", "c", scenario.overrides)],
        gateConfig: gateConfig(),
      });
      expect(result.state, scenario.name).toBe("paused");
      expect(result.units[0]?.state, scenario.name).not.toBe("merged");
      expect(result.units[0]?.mergedAt, scenario.name).toBeUndefined();
      expect(result.exceptions.some((entry) => entry.code === scenario.exception), scenario.name).toBe(true);
      store.close();
    }
  });

  it("records and completes a merge only when every acceptance gate is exact", () => {
    const store = singleDraftCampaign();
    const result = store.reconcileWave({
      ...mutation(4, "valid-merge"),
      wave: 1,
      observations: [observation("unit-a", "merged", "a", "c")],
      gateConfig: gateConfig(),
    });
    expect(result).toMatchObject({
      state: "completed",
      units: [{ state: "merged", acceptedAt: time(4), mergedAt: time(4) }],
      exceptions: [],
    });
    store.close();
  });

  it("plans reverse dependency rollback and computes only attributable metrics", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([
      unit("unit-a", "repo-a", "a", "c"),
      unit("unit-b", "repo-b", "b", "d"),
    ]));
    for (const [id, token, minute] of [["unit-a", "lease-token-unit-a-00000001", 1], ["unit-b", "lease-token-unit-b-00000001", 3]] as const) {
      const lease = store.claimNextAttempt({ ...mutation(minute, `claim-${id}`), leaseToken: token, leaseDurationMs: 3_600_000, gateConfig: gateConfig() })!;
      complete(store, id, minute + 1, token, lease.leaseGeneration);
    }
    store.authorizeCurrentWaveDrafts({ ...mutation(5, "draft-wave"), gateConfig: gateConfig() });
    store.reconcileWave({
      ...mutation(6, "partial-merge"),
      wave: 1,
      observations: [observation("unit-a", "merged", "a", "c"), observation("unit-b", "draft", "b", "d")],
      gateConfig: gateConfig(),
    });
    const rollback = store.planRollback(mutation(7, "rollback-plan"));
    expect(rollback.map((action) => [action.unitId, action.type])).toEqual([
      ["unit-b", "close_draft"],
      ["unit-a", "open_revert_draft"],
    ]);
    expect(rollback.every((action) => action.draft && !action.autoMerge && !action.autoDeploy)).toBe(true);
    expect(store.metrics("tenant-a", "campaign-a")).toMatchObject({
      campaignCompletionRate: 0.5,
      waveCompletionRate: 0,
      batchAcceptanceRate: 1,
      verificationPassRate: 1,
      openExceptionCount: 1,
      legacyItemsRemoved: 6,
      reviewerEditLines: 4,
      actualCostUsd: 0.5,
    });
    store.close();
  });

  it("persists cumulative adaptive accounting across checkpoints, retries, and restart", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-pilot-budget-restart-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    const first = new TransformerPilotExecutionStore(path);
    first.createCampaign({
      ...createInput([unit("unit-a", "repo-a", "a", "c")]),
      adaptiveBudget: {
        maxAttempts: 4, maxPlannerCalls: 8, maxModelCalls: 8,
        maxInputTokens: 10_000, maxOutputTokens: 10_000, maxTotalTokens: 20_000,
        maxActualCostUsd: 20, maxWallTimeMs: 600_000,
      },
    });
    const firstToken = "lease-token-budget-restart-first-01";
    const firstLease = first.claimNextAttempt({
      ...mutation(1, "budget-restart-claim-1"), leaseToken: firstToken,
      leaseDurationMs: 3_600_000, gateConfig: gateConfig(),
    })!;
    const firstUsage = adaptiveAccounting({
      plannerCalls: 1, modelCalls: 1, inputTokens: 100, outputTokens: 20,
      totalTokens: 120, actualCostUsd: 0.5, wallTimeMs: 1_000,
    });
    const checkpointInput = {
      ...mutation(2, "budget-restart-checkpoint-1"), unitId: firstLease.unitId,
      leaseGeneration: firstLease.leaseGeneration, leaseToken: firstToken,
      accounting: firstUsage, gateConfig: gateConfig(),
    };
    const checkpoint = first.recordAdaptiveAttemptUsage(checkpointInput);
    expect(first.recordAdaptiveAttemptUsage(checkpointInput)).toEqual(checkpoint);
    const failed = first.recordAttemptFailure({
      ...mutation(3, "budget-restart-failure-1"), unitId: firstLease.unitId,
      leaseGeneration: firstLease.leaseGeneration, leaseToken: firstToken,
      code: "execution_failed", accounting: firstUsage, gateConfig: gateConfig(),
    });
    first.control({ ...mutation(4, "budget-restart-authorize"), action: "authorize_retry", unitId: "unit-a" });
    first.control({
      ...mutation(5, "budget-restart-resolve"), action: "resolve_exception",
      exceptionId: failed.exceptions[0]!.id,
      resolution: "Retry approved after bounded failure review",
    });
    first.control({ ...mutation(6, "budget-restart-resume"), action: "resume" });
    first.close();

    const second = new TransformerPilotExecutionStore(path);
    const secondToken = "lease-token-budget-restart-second-1";
    const secondLease = second.claimNextAttempt({
      ...mutation(7, "budget-restart-claim-2"), leaseToken: secondToken,
      leaseDurationMs: 3_600_000, gateConfig: gateConfig(),
    })!;
    second.recordAdaptiveAttemptUsage({
      ...mutation(8, "budget-restart-checkpoint-2"), unitId: secondLease.unitId,
      leaseGeneration: secondLease.leaseGeneration, leaseToken: secondToken,
      accounting: adaptiveAccounting({
        plannerCalls: 2, modelCalls: 1, inputTokens: 200, outputTokens: 50,
        totalTokens: 250, actualCostUsd: 0.75, wallTimeMs: 2_000,
      }),
      gateConfig: gateConfig(),
    });
    expect(second.getCampaign("tenant-a", "campaign-a")?.adaptiveBudget.totals).toEqual({
      attempts: 2, plannerCalls: 3, modelCalls: 2, inputTokens: 300,
      outputTokens: 70, totalTokens: 370, actualCostUsd: 1.25, wallTimeMs: 3_000,
    });
    second.close();
  });

  it("reserves external model headroom and settles exact, over-budget, and crashed calls once", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign({
      ...createInput([unit("unit-a", "repo-a", "a", "c")]),
      adaptiveBudget: {
        maxAttempts: 2, maxPlannerCalls: 4, maxModelCalls: 4,
        maxInputTokens: 400, maxOutputTokens: 100, maxTotalTokens: 500,
        maxActualCostUsd: 4, maxWallTimeMs: 600_000,
      },
    });
    const token = "lease-token-model-reservation-current-1";
    const lease = store.claimNextAttempt({
      ...mutation(1, "model-reservation-claim"), leaseToken: token,
      leaseDurationMs: 180_000, gateConfig: gateConfig(),
    })!;
    const reservation = (reservationId: string) => ({
      reservationId,
      requestDigest: `sha256:${reservationId.slice(-1).repeat(64)}`,
      provider: "provider-a",
      configuredModel: "model-a",
      deployment: "deployment-a",
      executionRegion: "us-central",
      maximumDataClassification: "confidential" as const,
      endpointHost: "models.example",
      maximumInputTokens: 100,
      maximumOutputTokens: 20,
      maximumTotalTokens: 120,
      maximumCostUsd: 1,
    });
    const reserveOne = {
      ...mutation(2, "model-reserve-one"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      reservation: reservation("reservation-1"), gateConfig: gateConfig(),
    };
    const reserved = store.reserveAdaptiveModelCall(reserveOne);
    expect(store.reserveAdaptiveModelCall(reserveOne)).toEqual(reserved);
    expect(store.getCampaign("tenant-a", "campaign-a")!.adaptiveBudget.totals.modelCalls).toBe(0);
    const settleOne = {
      ...mutation(2, "model-settle-one"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      settlement: {
        reservationId: "reservation-1", status: "succeeded" as const,
        actualModel: "model-a-20260806", headerRequestId: "request-1",
        inputTokens: 50, outputTokens: 10, totalTokens: 60, costUsd: 0.4,
      },
      gateConfig: gateConfig(),
    };
    const settled = store.settleAdaptiveModelCall(settleOne);
    expect(store.settleAdaptiveModelCall(settleOne)).toEqual(settled);

    store.reserveAdaptiveModelCall({
      ...mutation(2, "model-reserve-two"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      reservation: reservation("reservation-2"), gateConfig: gateConfig(),
    });
    store.settleAdaptiveModelCall({
      ...mutation(2, "model-settle-two"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      settlement: {
        reservationId: "reservation-2", status: "succeeded",
        actualModel: "unexpected-model", inputTokens: 101,
        outputTokens: 20, totalTokens: 121, costUsd: 1.1,
      },
      gateConfig: gateConfig(),
    });
    store.reserveAdaptiveModelCall({
      ...mutation(2, "model-reserve-three"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      reservation: reservation("reservation-3"), gateConfig: gateConfig(),
    });
    store.expireAttempt({
      ...mutation(5, "model-reservation-expire"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, gateConfig: gateConfig(),
    });
    const campaign = store.getCampaign("tenant-a", "campaign-a")!;
    expect(campaign.adaptiveBudget.totals).toMatchObject({
      plannerCalls: 3, modelCalls: 3, inputTokens: 250,
      outputTokens: 50, totalTokens: 300, actualCostUsd: 2.4,
    });
    expect(campaign.units[0]!.adaptiveModelReservations?.map((item) => item.status)).toEqual([
      "succeeded", "over_budget", "unknown",
    ]);
    expect(campaign.units[0]!.adaptiveModelReservations?.[1]).toMatchObject({
      actualModel: "unexpected-model", reportedTotalTokens: 121, chargedTotalTokens: 120,
    });
    store.close();
  });

  it.each([
    ["input-tokens", { maximumInputTokens: 0, maximumTotalTokens: 20 }],
    ["output-tokens", { maximumOutputTokens: 0, maximumTotalTokens: 100 }],
    ["total-tokens", { maximumTotalTokens: 0 }],
    ["cost", { maximumCostUsd: 0 }],
  ])("rejects a zero maximum for %s before reserving model headroom", (slug, overrides) => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign({
      ...createInput([unit("unit-a", "repo-a", "a", "c")]),
      adaptiveBudget: {
        maxAttempts: 1, maxPlannerCalls: 1, maxModelCalls: 1,
        maxInputTokens: 100, maxOutputTokens: 20, maxTotalTokens: 120,
        maxActualCostUsd: 1, maxWallTimeMs: 60_000,
      },
    });
    const token = "lease-token-zero-model-reservation-bound";
    const lease = store.claimNextAttempt({
      ...mutation(1, "zero-model-reservation-bound-claim"), leaseToken: token,
      leaseDurationMs: 180_000, gateConfig: gateConfig(),
    })!;

    expect(() => store.reserveAdaptiveModelCall({
      ...mutation(2, `zero-model-reservation-bound-${slug}`), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      reservation: {
        reservationId: `reservation-zero-${slug}`,
        requestDigest: digest("0"),
        provider: "provider-a",
        configuredModel: "model-a",
        deployment: "deployment-a",
        executionRegion: "us-central",
        maximumDataClassification: "confidential",
        endpointHost: "models.example",
        maximumInputTokens: 100,
        maximumOutputTokens: 20,
        maximumTotalTokens: 120,
        maximumCostUsd: 1,
        ...overrides,
      },
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_model_reservation_bound_invalid");

    const campaign = store.getCampaign("tenant-a", "campaign-a")!;
    expect(campaign.units[0]!.adaptiveModelReservations ?? []).toEqual([]);
    expect(campaign.adaptiveBudget.totals).toMatchObject({
      plannerCalls: 0,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      actualCostUsd: 0,
    });
    store.close();
  });

  it.each([
    ["all-zero", { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }],
    ["missing", {}],
    ["inconsistent", { inputTokens: 10, outputTokens: 5, totalTokens: 16, costUsd: 0.1 }],
    ["zero-cost", { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0 }],
  ])("charges adaptive reservation maximum for %s successful usage evidence", (_case, usage) => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign({
      ...createInput([unit("unit-a", "repo-a", "a", "c")]),
      adaptiveBudget: {
        maxAttempts: 1, maxPlannerCalls: 1, maxModelCalls: 1,
        maxInputTokens: 100, maxOutputTokens: 20, maxTotalTokens: 120,
        maxActualCostUsd: 1, maxWallTimeMs: 60_000,
      },
    });
    const token = "lease-token-model-usage-evidence-1";
    const lease = store.claimNextAttempt({
      ...mutation(1, "model-usage-evidence-claim"), leaseToken: token,
      leaseDurationMs: 180_000, gateConfig: gateConfig(),
    })!;
    const reservationId = "reservation-usage-evidence";
    store.reserveAdaptiveModelCall({
      ...mutation(2, "model-usage-evidence-reserve"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      reservation: {
        reservationId,
        requestDigest: digest("e"),
        provider: "provider-a",
        configuredModel: "model-a",
        deployment: "deployment-a",
        executionRegion: "us-central",
        maximumDataClassification: "confidential",
        endpointHost: "models.example",
        maximumInputTokens: 100,
        maximumOutputTokens: 20,
        maximumTotalTokens: 120,
        maximumCostUsd: 1,
      },
      gateConfig: gateConfig(),
    });

    store.settleAdaptiveModelCall({
      ...mutation(3, "model-usage-evidence-settle"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      settlement: { reservationId, status: "succeeded", ...usage },
      gateConfig: gateConfig(),
    });

    const campaign = store.getCampaign("tenant-a", "campaign-a")!;
    expect(campaign.adaptiveBudget.totals).toMatchObject({
      modelCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      actualCostUsd: 1,
    });
    expect(campaign.units[0]!.adaptiveModelReservations?.[0]).toMatchObject({
      status: "over_budget",
      chargedInputTokens: 100,
      chargedOutputTokens: 20,
      chargedTotalTokens: 120,
      chargedCostUsd: 1,
    });
    store.close();
  });

  it("enforces ceilings during an attempt and never charges a stale lease", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign({
      ...createInput([unit("unit-a", "repo-a", "a", "c")]),
      adaptiveBudget: {
        maxAttempts: 1, maxPlannerCalls: 1, maxModelCalls: 1,
        maxInputTokens: 100, maxOutputTokens: 20, maxTotalTokens: 120,
        maxActualCostUsd: 1, maxWallTimeMs: 1_000,
      },
    });
    const token = "lease-token-budget-ceiling-current-1";
    const lease = store.claimNextAttempt({
      ...mutation(1, "budget-ceiling-claim"), leaseToken: token,
      leaseDurationMs: 3_600_000, gateConfig: gateConfig(),
    })!;
    const allowed = adaptiveAccounting({
      plannerCalls: 1, modelCalls: 1, inputTokens: 100, outputTokens: 20,
      totalTokens: 120, actualCostUsd: 1, wallTimeMs: 1_000,
    });
    store.recordAdaptiveAttemptUsage({
      ...mutation(2, "budget-ceiling-allowed"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      accounting: allowed, gateConfig: gateConfig(),
    });
    const before = store.getCampaign("tenant-a", "campaign-a")!.adaptiveBudget.totals;
    expect(() => store.recordAdaptiveAttemptUsage({
      ...mutation(2, "budget-ceiling-stale"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: "lease-token-budget-ceiling-stale-1",
      accounting: adaptiveAccounting({ ...allowed, wallTimeMs: 2_000 }), gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_fence_stale");
    expect(store.getCampaign("tenant-a", "campaign-a")!.adaptiveBudget.totals).toEqual(before);
    expect(() => store.recordAdaptiveAttemptUsage({
      ...mutation(2, "budget-ceiling-overrun"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      accounting: adaptiveAccounting({ ...allowed, plannerCalls: 2 }), gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_adaptive_budget_planner_calls_exceeded");
    expect(store.getCampaign("tenant-a", "campaign-a")!.adaptiveBudget.totals).toEqual(before);
    store.close();
  });

  it("fails closed on inconsistent or regressing attempt accounting", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const token = "lease-token-budget-accounting-current";
    const lease = store.claimNextAttempt({
      ...mutation(1, "budget-accounting-claim"), leaseToken: token,
      leaseDurationMs: 3_600_000, gateConfig: gateConfig(),
    })!;
    expect(() => store.recordAdaptiveAttemptUsage({
      ...mutation(2, "budget-accounting-inconsistent"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      accounting: adaptiveAccounting({ inputTokens: 10, outputTokens: 5, totalTokens: 20 }),
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_adaptive_accounting_invalid");
    expect(() => store.recordAdaptiveAttemptUsage({
      ...mutation(2, "budget-accounting-zero-model"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      accounting: adaptiveAccounting({ plannerCalls: 1, modelCalls: 1 }),
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_adaptive_accounting_invalid");
    expect(() => store.recordAdaptiveAttemptUsage({
      ...mutation(2, "budget-accounting-phantom-usage"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      accounting: adaptiveAccounting({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_adaptive_accounting_invalid");
    store.recordAdaptiveAttemptUsage({
      ...mutation(2, "budget-accounting-current"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      accounting: adaptiveAccounting({ plannerCalls: 1, wallTimeMs: 100 }),
      gateConfig: gateConfig(),
    });
    expect(() => store.recordAdaptiveAttemptUsage({
      ...mutation(3, "budget-accounting-regression"), unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration, leaseToken: token,
      accounting: adaptiveAccounting({ wallTimeMs: 99 }), gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_adaptive_accounting_regressed");
    store.close();
  });

  it("requires an attributable human override for every budget increase", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign({
      ...createInput([unit("unit-a", "repo-a", "a", "c")]),
      adaptiveBudget: { maxAttempts: 1 },
    });
    expect(() => store.increaseAdaptiveBudget({
      ...mutation(1, "budget-override-missing-human"), humanActorId: "",
      reason: "Need one retry", ceilings: { maxAttempts: 2 },
    })).toThrow("transformer_pilot_budget_override_actor_invalid");
    const increased = store.increaseAdaptiveBudget({
      ...mutation(1, "budget-override-approved"), humanActorId: "user-talal",
      reason: "Approved one bounded retry after reviewing failure evidence",
      ceilings: { maxAttempts: 2 },
    });
    expect(increased.adaptiveBudget).toMatchObject({
      ceilings: { maxAttempts: 2 },
      overrides: [{
        humanActorId: "user-talal",
        reason: "Approved one bounded retry after reviewing failure evidence",
        evidenceRefs: mutation(1, "budget-override-approved").evidenceRefs,
      }],
    });
    expect(store.listEvents("tenant-a", "campaign-a").at(-1)).toMatchObject({
      type: "adaptive_budget.increased", payload: { humanActorId: "user-talal" },
    });
    store.close();
  });
});
