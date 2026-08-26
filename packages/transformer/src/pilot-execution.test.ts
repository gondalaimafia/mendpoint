import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import { createOrganizationConstraintContract } from "./organization-constraints.js";
import {
  createTransformerAttemptAuthorizationDigest,
  createTransformerAttemptCompletionDigest,
  type TransformerAttemptCompletionIntent,
} from "./attempt-completion.js";
import {
  createTransformerAttemptEffectIdentity,
  createTransformerCoordinatorCompletionRequestDigest,
  createTransformerCoordinatorCompletionSlot,
  type TransformerCandidateSeal,
} from "./attempt-checkpoint.js";
import {
  transformerAttemptCheckpointEnvelopeStorageKey,
  TransformerPilotExecutionStore,
  type TransformerAttemptFailureCode,
  type TransformerAttemptCheckpointHead,
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
    changedPaths: ["package.json"],
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

function checkpointHead(
  lease: TransformerAttemptLease,
  generation: number,
  stateCharacter: string,
): TransformerAttemptCheckpointHead {
  const head = {
    schemaVersion: 1,
    episodeId: `transformer-episode-${"e".repeat(32)}`,
    stateDigest: digest(stateCharacter),
    envelopeDigest: digest(stateCharacter === "d" ? "e" : "f"),
    generation,
    attemptNumber: lease.attemptNumber,
    writerLeaseGeneration: lease.leaseGeneration,
    writerLeaseTokenDigest: lease.leaseTokenDigest,
  } satisfies Omit<TransformerAttemptCheckpointHead, "envelopeStorageKey">;
  return {
    ...head,
    envelopeStorageKey: transformerAttemptCheckpointEnvelopeStorageKey({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: lease.unitId,
      episodeId: head.episodeId,
      generation: head.generation,
      envelopeDigest: head.envelopeDigest,
    }),
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
    const protectedGate = JSON.stringify({
      schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
      tenantAllowlist: ["tenant-a"],
      environmentAllowlist: ["staging"],
      grants: [{
        tenantId: "tenant-a",
        environment: "staging",
        boundaries: ["worker_action", "delivery"],
        acceptanceEvidenceRefs: ["acceptance:pilot-a:v1"],
        productionDeliveryApprovalRefs: ["approval:run-a", "approval:run-b"],
      }],
    });
    const firstDraftAuthorization = {
      ...mutation(3, "draft-run-a"),
      gateConfig: protectedGate,
      productionDeliveryApprovalRefs: ["approval:run-a"],
    };
    expect(store.authorizeCurrentWaveDrafts(firstDraftAuthorization)).toEqual([
      expect.objectContaining({ type: "open_draft", unitId: "unit-a", draft: true, autoMerge: false, autoDeploy: false }),
    ]);
    const authorizationEvents = store.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "delivery.drafts_authorized");
    const freshRunAuthorization = {
      ...mutation(4, "draft-run-b"),
      gateConfig: protectedGate,
      productionDeliveryApprovalRefs: ["approval:run-b"],
    };
    expect(store.authorizeCurrentWaveDrafts(freshRunAuthorization)).toEqual([
      expect.objectContaining({ type: "open_draft", unitId: "unit-a", draft: true, autoMerge: false, autoDeploy: false }),
    ]);
    expect(store.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "delivery.drafts_authorized")).toEqual(authorizationEvents);
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

  it("renews only the exact live lease and persists one idempotent extension", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-pilot-renewal-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    let store = new TransformerPilotExecutionStore(path);
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const token = "lease-token-unit-a-renewal-0001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-renewal-a"),
      leaseToken: token,
      leaseDurationMs: 60_000,
      gateConfig: gateConfig(),
    })!;
    const renewalInput = {
      ...mutation(1, "renew-lease-a"),
      observedAt: "2026-08-02T08:01:30.000Z",
      unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration,
      leaseToken: token,
      leaseDurationMs: 60_000,
      gateConfig: gateConfig(),
    };

    const renewed = store.renewAttemptLease(renewalInput);
    expect(renewed).toEqual({
      leaseGeneration: lease.leaseGeneration,
      leaseTokenDigest: lease.leaseTokenDigest,
      leaseExpiresAt: "2026-08-02T08:02:30.000Z",
    });
    expect(store.renewAttemptLease(renewalInput)).toEqual(renewed);
    expect(() => store.renewAttemptLease({
      ...renewalInput,
      idempotencyKey: "renew-lease-stale-token",
      leaseToken: "lease-token-unit-a-renewal-stale",
    })).toThrow("transformer_pilot_fence_stale");
    expect(() => store.renewAttemptLease({
      ...renewalInput,
      idempotencyKey: "renew-lease-non-extending",
      leaseDurationMs: 1_000,
    })).toThrow("transformer_pilot_lease_renewal_not_extended");
    expect(store.listExpiredAttempts(time(2), "tenant-a")).toEqual([]);
    expect(store.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.lease_renewed"
    )).toHaveLength(1);
    store.close();

    store = new TransformerPilotExecutionStore(path);
    expect(store.getCampaign("tenant-a", "campaign-a")?.units[0]?.leaseExpiresAt)
      .toBe("2026-08-02T08:02:30.000Z");
    expect(store.listExpiredAttempts("2026-08-02T08:02:29.999Z", "tenant-a")).toEqual([]);
    expect(store.listExpiredAttempts("2026-08-02T08:02:30.000Z", "tenant-a")).toHaveLength(1);
    store.close();
  });

  it("persists only an authenticated checkpoint head across coordinator restart", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-pilot-checkpoint-head-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    let store = new TransformerPilotExecutionStore(path);
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const leaseToken = "lease-token-checkpoint-head-0001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-checkpoint-head"),
      leaseToken,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const head = checkpointHead(lease, 1, "d");

    expect(store.readAttemptCheckpointHead({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: lease.unitId,
      episodeId: head.episodeId,
    })).toBeNull();
    expect(store.compareAndSwapAttemptCheckpointHead({
      ...mutation(2, "checkpoint-head-genesis"),
      unitId: lease.unitId,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
      leaseToken,
      expectedStateDigest: null,
      next: head,
      gateConfig: gateConfig(),
    })).toEqual(head);
    const events = store.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.checkpoint_head_advanced"
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("ciphertextBase64");
    expect(JSON.stringify(store.getCampaign("tenant-a", "campaign-a")))
      .not.toContain("ciphertextBase64");
    store.close();

    store = new TransformerPilotExecutionStore(path);
    expect(store.readAttemptCheckpointHead({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: lease.unitId,
      episodeId: head.episodeId,
    })).toEqual(head);
    expect(store.readAttemptCheckpointLease({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: lease.unitId,
      episodeId: head.episodeId,
      observedAt: time(3),
    })).toEqual({
      attemptNumber: lease.attemptNumber,
      generation: lease.leaseGeneration,
      tokenDigest: lease.leaseTokenDigest,
    });
    store.close();
  });

  it("allows exactly one coordinator connection to advance a checkpoint head", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-pilot-checkpoint-cas-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    const first = new TransformerPilotExecutionStore(path);
    const second = new TransformerPilotExecutionStore(path);
    first.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const leaseToken = "lease-token-checkpoint-cas-000001";
    const lease = first.claimNextAttempt({
      ...mutation(1, "claim-checkpoint-cas"),
      leaseToken,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const winner = checkpointHead(lease, 1, "d");
    const loser = checkpointHead(lease, 1, "a");
    const input = {
      ...mutation(2, "checkpoint-cas-winner"),
      unitId: lease.unitId,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
      leaseToken,
      expectedStateDigest: null,
      gateConfig: gateConfig(),
    };

    expect(first.compareAndSwapAttemptCheckpointHead({ ...input, next: winner }))
      .toEqual(winner);
    expect(() => second.compareAndSwapAttemptCheckpointHead({
      ...input,
      idempotencyKey: "checkpoint-cas-loser",
      next: loser,
    })).toThrow("transformer_pilot_checkpoint_head_conflict");
    expect(second.readAttemptCheckpointHead({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: lease.unitId,
      episodeId: winner.episodeId,
    })).toEqual(winner);
    expect(first.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.checkpoint_head_advanced"
    )).toHaveLength(1);
    second.close();
    first.close();
  });

  it("atomically completes an attempt with its terminal checkpoint head", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-advisory-dispatch-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    const store = new TransformerPilotExecutionStore(path);
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const leaseToken = "lease-token-checkpoint-terminal-0001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-checkpoint-terminal"),
      leaseToken,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const current = checkpointHead(lease, 1, "d");
    store.compareAndSwapAttemptCheckpointHead({
      ...mutation(2, "checkpoint-terminal-current"),
      unitId: lease.unitId,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
      leaseToken,
      expectedStateDigest: null,
      next: current,
      gateConfig: gateConfig(),
    });
    const terminal = checkpointHead(lease, 2, "a");
    const candidate = store.getCampaign("tenant-a", "campaign-a")!.units[0]!;
    const authorization = gateConfig();
    expect(() => store.completeAttempt({
      ...mutation(3, "complete-checkpoint-terminal-legacy"),
      unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration,
      leaseToken,
      sourceRevision: candidate.snapshot.revision,
      sourceDigest: candidate.snapshot.digest,
      candidateRevision: candidate.candidateRevision,
      candidateDigest: candidate.candidateDigest,
      verificationPassed: true,
      actualCostUsd: 0.25,
      accounting: adaptiveAccounting({ actualCostUsd: 0.25, wallTimeMs: 60_000 }),
      gateConfig: authorization,
    })).toThrow("transformer_pilot_terminal_checkpoint_required");
    const candidateSeal = {
      schemaVersion: 1,
      candidateRevision: candidate.candidateRevision,
      candidateDigest: candidate.candidateDigest,
      workspaceManifestDigest: digest("d"),
      workspacePayloadDigest: digest("e"),
      sealDigest: digest("f"),
    } satisfies TransformerCandidateSeal;
    const completionIntent = {
      schemaVersion: 1,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: lease.unitId,
      episodeId: terminal.episodeId,
      candidateSealDigest: candidateSeal.sealDigest,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
      leaseTokenDigest: lease.leaseTokenDigest,
      sourceRevision: candidate.snapshot.revision,
      sourceDigest: candidate.snapshot.digest,
      candidateRevision: candidate.candidateRevision,
      candidateDigest: candidate.candidateDigest,
      authorizationDigest: createTransformerAttemptAuthorizationDigest(authorization),
      verificationPassed: true,
      actualCostUsd: 0.25,
      accounting: adaptiveAccounting({ actualCostUsd: 0.25, wallTimeMs: 60_000 }),
      observedAt: time(3),
      evidenceRefs: ["evidence://operation/complete-checkpoint-terminal"],
    } satisfies TransformerAttemptCompletionIntent;
    const completionDigest = createTransformerAttemptCompletionDigest(completionIntent);
    const completionRequestDigest = createTransformerCoordinatorCompletionRequestDigest(
      terminal.episodeId,
      candidateSeal,
      completionIntent,
    );
    const completionIdentity = createTransformerAttemptEffectIdentity(
      terminal.episodeId,
      "coordinator_complete",
      createTransformerCoordinatorCompletionSlot(completionDigest),
      completionRequestDigest,
    );
    const input = {
      ...mutation(3, "complete-checkpoint-terminal"),
      idempotencyKey: completionIdentity.idempotencyKey,
      leaseToken,
      expectedStateDigest: current.stateDigest,
      nextCheckpointHead: terminal,
      candidateSeal,
      completionIntent,
      advisoryDispatchRequested: false,
      gateConfig: authorization,
    };

    const completed = store.completeAttemptWithCheckpointHead(input);
    expect(completed.campaign.units[0]).toMatchObject({
      state: "executed",
      verificationPassed: true,
      attemptCheckpointHead: terminal,
    });
    expect(store.completeAttemptWithCheckpointHead({
      ...input,
      advisoryDispatchRequested: true,
    })).toEqual(completed);
    expect(completed.receipt).toEqual({
      schemaVersion: 1,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: lease.unitId,
      episodeId: terminal.episodeId,
      completionDigest,
      campaignRevision: completed.campaign.revision,
      observedAt: time(3),
      checkpointHead: terminal,
    });
    expect(store.listPendingVerifierAdvisoryDispatches("tenant-a", 10)).toHaveLength(0);
    expect(store.backfillVerifierAdvisoryDispatches({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
    })).toEqual({ inserted: 1, existing: 0 });
    expect(store.backfillVerifierAdvisoryDispatches({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
    })).toEqual({ inserted: 0, existing: 1 });
    const concurrentStore = new TransformerPilotExecutionStore(path);
    const advisoryOutbox = store.listPendingVerifierAdvisoryDispatches("tenant-a", 10);
    expect(advisoryOutbox).toEqual([expect.objectContaining({
      schemaVersion: 1,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      campaignRevision: completed.campaign.revision,
      unitId: lease.unitId,
      episodeId: terminal.episodeId,
      completionDigest,
      authorizationDigest: completionIntent.authorizationDigest,
      checkpointStateDigest: terminal.stateDigest,
      observedAt: time(3),
    })]);
    expect(JSON.stringify(advisoryOutbox)).not.toContain("package.json");
    const dispatch = advisoryOutbox[0]!;
    const firstClaim = store.claimNextVerifierAdvisoryDispatch({
      tenantId: "tenant-a",
      claimantId: "drainer-a",
      claimId: "claim-a",
      leaseToken: "advisory-lease-a",
      leaseDurationMs: 60_000,
      observedAt: time(4),
    })!;
    expect(firstClaim.dispatch).toEqual(dispatch);
    expect(concurrentStore.claimNextVerifierAdvisoryDispatch({
      tenantId: "tenant-a",
      claimantId: "drainer-b",
      claimId: "claim-b-blocked",
      leaseToken: "advisory-lease-b-blocked",
      leaseDurationMs: 60_000,
      observedAt: time(4),
    })).toBeNull();
    expect(() => store.recordVerifierAdvisoryDispatchClaimResult({
      ...firstClaim,
      tenantId: "tenant-b",
      leaseToken: "advisory-lease-a",
      status: "failed",
      errorCode: "queue_unavailable",
      observedAt: time(4),
    })).toThrow("transformer_verifier_advisory_dispatch_scope_invalid");
    expect(() => store.recordVerifierAdvisoryDispatchClaimResult({
      ...firstClaim,
      leaseToken: "wrong-advisory-lease",
      status: "failed",
      errorCode: "queue_unavailable",
      observedAt: time(4),
    })).toThrow("transformer_verifier_advisory_dispatch_fence_invalid");
    const secondClaim = store.claimNextVerifierAdvisoryDispatch({
      tenantId: "tenant-a",
      claimantId: "drainer-b",
      claimId: "claim-b",
      leaseToken: "advisory-lease-b",
      leaseDurationMs: 60_000,
      observedAt: time(5),
    })!;
    expect(secondClaim.leaseGeneration).toBe(2);
    expect(() => store.recordVerifierAdvisoryDispatchClaimResult({
      ...firstClaim,
      leaseToken: "advisory-lease-a",
      status: "failed",
      errorCode: "queue_unavailable",
      observedAt: time(5),
    })).toThrow("transformer_verifier_advisory_dispatch_fence_invalid");
    store.recordVerifierAdvisoryDispatchClaimResult({
      ...secondClaim,
      leaseToken: "advisory-lease-b",
      status: "failed",
      errorCode: "queue_unavailable",
      observedAt: time(5),
    });
    expect(() => store.recordVerifierAdvisoryDispatchClaimResult({
      ...secondClaim,
      leaseToken: "advisory-lease-b",
      status: "failed",
      errorCode: "queue_unavailable",
      observedAt: time(5),
    })).toThrow("transformer_verifier_advisory_dispatch_result_exists");
    expect(store.claimNextVerifierAdvisoryDispatch({
      tenantId: "tenant-a",
      claimantId: "drainer-c",
      claimId: "claim-c-backoff",
      leaseToken: "advisory-lease-c-backoff",
      leaseDurationMs: 60_000,
      observedAt: time(5),
    })).toBeNull();
    expect(store.listVerifierAdvisoryDispatchResults("tenant-a", dispatch.dispatchId))
      .toEqual([expect.objectContaining({ status: "failed", errorCode: "queue_unavailable" })]);
    for (let failureNumber = 2; failureNumber <= 8; failureNumber += 1) {
      const observedAt = time(6 + ((failureNumber - 2) * 6));
      const leaseTokenForFailure = `advisory-lease-${failureNumber}-bounded`;
      const claim = store.claimNextVerifierAdvisoryDispatch({
        tenantId: "tenant-a",
        claimantId: `drainer-${failureNumber}`,
        claimId: `claim-${failureNumber}`,
        leaseToken: leaseTokenForFailure,
        leaseDurationMs: 60_000,
        observedAt,
      })!;
      expect(claim.leaseGeneration).toBe(failureNumber + 1);
      store.recordVerifierAdvisoryDispatchClaimResult({
        ...claim,
        leaseToken: leaseTokenForFailure,
        status: "failed",
        errorCode: "queue_unavailable",
        observedAt,
      });
    }
    expect(store.claimNextVerifierAdvisoryDispatch({
      tenantId: "tenant-a",
      claimantId: "drainer-after-limit",
      claimId: "claim-after-limit",
      leaseToken: "advisory-lease-after-limit",
      leaseDurationMs: 60_000,
      observedAt: time(54),
    })).toBeNull();
    expect(store.listPendingVerifierAdvisoryDispatches("tenant-a", 10)).toHaveLength(0);
    store.authorizeCurrentWaveDrafts({
      ...mutation(4, "authorize-checkpoint-draft"),
      gateConfig: authorization,
    });
    const deliveryToken = "delivery-lease-token-checkpoint-terminal-01";
    const deliveryClaim = {
      ...mutation(5, "claim-checkpoint-draft"),
      leaseToken: deliveryToken,
      leaseDurationMs: 120_000,
      gateConfig: authorization,
    };
    const deliveryLease = store.claimNextDraftDelivery(deliveryClaim)!;
    expect(deliveryLease).toMatchObject({
      type: "deliver_draft",
      unitId: lease.unitId,
      candidateDigest: candidate.candidateDigest,
      checkpointHead: terminal,
      leaseGeneration: 1,
    });
    expect(store.claimNextDraftDelivery({
      ...deliveryClaim,
      observedAt: time(6),
    })).toEqual(deliveryLease);
    store.assertCurrentDraftDeliveryFence({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: lease.unitId,
      deliveryId: deliveryLease.deliveryId,
      leaseGeneration: deliveryLease.leaseGeneration,
      leaseToken: deliveryToken,
      observedAt: time(5),
      gateConfig: authorization,
    });
    store.control({ ...mutation(5, "pause-after-draft-claim"), action: "pause" });
    expect(() => store.assertCurrentDraftDeliveryFence({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: lease.unitId,
      deliveryId: deliveryLease.deliveryId,
      leaseGeneration: deliveryLease.leaseGeneration,
      leaseToken: deliveryToken,
      observedAt: time(5),
      gateConfig: authorization,
    })).toThrow("transformer_pilot_delivery_fence_stale");
    expect(() => store.completeDraftDelivery({
      ...mutation(5, "complete-draft-while-paused"),
      unitId: lease.unitId,
      deliveryId: deliveryLease.deliveryId,
      leaseGeneration: deliveryLease.leaseGeneration,
      leaseToken: deliveryToken,
      completion: {
        intentDigest: digest("1"),
        branchName: "mendpoint/transformer/unit-a",
        baseBranch: "main",
        baseRevision: candidate.snapshot.revision,
        commitSha: revision("1"),
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/acme/repo-a/pull/42",
      },
      gateConfig: authorization,
    })).toThrow("transformer_pilot_delivery_fence_stale");
    store.control({ ...mutation(5, "resume-after-draft-pause"), action: "resume" });
    const delivered = store.completeDraftDelivery({
      ...mutation(6, "complete-checkpoint-draft"),
      unitId: lease.unitId,
      deliveryId: deliveryLease.deliveryId,
      leaseGeneration: deliveryLease.leaseGeneration,
      leaseToken: deliveryToken,
      completion: {
        intentDigest: digest("1"),
        branchName: "mendpoint/transformer/unit-a",
        baseBranch: "main",
        baseRevision: candidate.snapshot.revision,
        commitSha: revision("1"),
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/acme/repo-a/pull/42",
      },
      gateConfig: authorization,
    });
    expect(delivered.units[0]?.draftDelivery).toMatchObject({
      status: "delivered",
      commitSha: revision("1"),
      pullRequestNumber: 42,
    });
    expect(store.listCurrentWaveDeliveredDrafts({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
    })).toEqual([expect.objectContaining({
      unitId: "unit-a",
      wave: 1,
      branchName: "mendpoint/transformer/unit-a",
      baseRevision: candidate.snapshot.revision,
      commitSha: revision("1"),
      pullRequestNumber: 42,
    })]);
    const observed = store.reconcileWave({
      ...mutation(7, "observe-checkpoint-draft"),
      wave: 1,
      observations: [observation("unit-a", "draft", "a", "1")],
      gateConfig: authorization,
    });
    expect(observed.units[0]).toMatchObject({ state: "accepted", acceptedAt: time(7) });
    store.control({
      ...mutation(8, "pause-after-checkpoint-completion"),
      action: "pause",
    });
    const replayed = store.completeAttemptWithCheckpointHead(input);
    expect(replayed.receipt).toEqual(completed.receipt);
    expect(replayed.campaign.revision).toBeGreaterThan(completed.campaign.revision);
    expect(store.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.completed_with_checkpoint"
    )).toHaveLength(1);
    expect(store.listVerifierAdvisoryDispatchResults("tenant-a", dispatch.dispatchId))
      .toHaveLength(8);
    concurrentStore.close();
    const raw = (store as unknown as { db: DatabaseSync }).db;
    raw.exec(`
      DROP TRIGGER tf_pilot_verifier_advisory_outbox_no_delete;
      DROP TRIGGER tf_pilot_events_no_update;
      DROP TRIGGER tf_pilot_verifier_advisory_dispatch_claim_results_no_delete;
      DROP TRIGGER tf_pilot_verifier_advisory_dispatch_claims_no_delete;
      DELETE FROM tf_pilot_verifier_advisory_dispatch_claim_results;
      DELETE FROM tf_pilot_verifier_advisory_dispatch_claims;
      DELETE FROM tf_pilot_verifier_advisory_outbox;
      UPDATE tf_pilot_events
      SET payload_json = json_set(payload_json, '$.completionDigest', '${digest("9")}')
      WHERE type = 'attempt.completed_with_checkpoint';
    `);
    expect(() => store.backfillVerifierAdvisoryDispatches({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
    })).toThrow("transformer_verifier_advisory_backfill_invalid");
    expect(store.listPendingVerifierAdvisoryDispatches("tenant-a", 10)).toHaveLength(0);
    store.close();
  });

  it("rolls back the checkpoint state write when the advisory outbox insert fails, proving one transaction", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-advisory-outbox-atomic-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    const store = new TransformerPilotExecutionStore(path);
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const leaseToken = "lease-token-outbox-atomic-0001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-outbox-atomic"),
      leaseToken,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const current = checkpointHead(lease, 1, "d");
    store.compareAndSwapAttemptCheckpointHead({
      ...mutation(2, "outbox-atomic-current"),
      unitId: lease.unitId,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
      leaseToken,
      expectedStateDigest: null,
      next: current,
      gateConfig: gateConfig(),
    });
    const terminal = checkpointHead(lease, 2, "a");
    const candidate = store.getCampaign("tenant-a", "campaign-a")!.units[0]!;
    const authorization = gateConfig();
    const candidateSeal = {
      schemaVersion: 1,
      candidateRevision: candidate.candidateRevision,
      candidateDigest: candidate.candidateDigest,
      workspaceManifestDigest: digest("d"),
      workspacePayloadDigest: digest("e"),
      sealDigest: digest("f"),
    } satisfies TransformerCandidateSeal;
    const completionIntent = {
      schemaVersion: 1,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: lease.unitId,
      episodeId: terminal.episodeId,
      candidateSealDigest: candidateSeal.sealDigest,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
      leaseTokenDigest: lease.leaseTokenDigest,
      sourceRevision: candidate.snapshot.revision,
      sourceDigest: candidate.snapshot.digest,
      candidateRevision: candidate.candidateRevision,
      candidateDigest: candidate.candidateDigest,
      authorizationDigest: createTransformerAttemptAuthorizationDigest(authorization),
      verificationPassed: true,
      actualCostUsd: 0.25,
      accounting: adaptiveAccounting({ actualCostUsd: 0.25, wallTimeMs: 60_000 }),
      observedAt: time(3),
      evidenceRefs: ["evidence://operation/complete-outbox-atomic"],
    } satisfies TransformerAttemptCompletionIntent;
    const completionDigest = createTransformerAttemptCompletionDigest(completionIntent);
    const completionRequestDigest = createTransformerCoordinatorCompletionRequestDigest(
      terminal.episodeId,
      candidateSeal,
      completionIntent,
    );
    const completionIdentity = createTransformerAttemptEffectIdentity(
      terminal.episodeId,
      "coordinator_complete",
      createTransformerCoordinatorCompletionSlot(completionDigest),
      completionRequestDigest,
    );
    const input = {
      ...mutation(3, "complete-outbox-atomic"),
      idempotencyKey: completionIdentity.idempotencyKey,
      leaseToken,
      expectedStateDigest: current.stateDigest,
      nextCheckpointHead: terminal,
      candidateSeal,
      completionIntent,
      advisoryDispatchRequested: true,
      gateConfig: authorization,
    };

    // Snapshot the pre-completion state: the checkpoint state write and the
    // advisory outbox insert must succeed or fail together as one transaction.
    const beforeRevision = store.getCampaign("tenant-a", "campaign-a")!.revision;
    const beforeUnitState = store.getCampaign("tenant-a", "campaign-a")!.units[0]!.state;

    // Force only the advisory outbox INSERT to fail. If that insert shared no
    // transaction with the checkpoint state write (e.g. it ran after COMMIT),
    // the state write would already be durable and this failure would leave a
    // completed checkpoint with no dispatch.
    const raw = (store as unknown as { db: DatabaseSync }).db;
    const realPrepare = raw.prepare.bind(raw);
    (raw as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (sql.includes("INSERT INTO tf_pilot_verifier_advisory_outbox")) {
        return { run: () => { throw new Error("outbox_insert_boom"); } };
      }
      return realPrepare(sql);
    };
    try {
      expect(() => store.completeAttemptWithCheckpointHead(input)).toThrow("outbox_insert_boom");
    } finally {
      (raw as unknown as { prepare: unknown }).prepare = realPrepare;
    }

    // The checkpoint state write must have rolled back with the failed outbox
    // insert: no revision bump, no unit state transition, no completion event.
    expect(store.getCampaign("tenant-a", "campaign-a")!.revision).toBe(beforeRevision);
    expect(store.getCampaign("tenant-a", "campaign-a")!.units[0]!.state).toBe(beforeUnitState);
    expect(store.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.completed_with_checkpoint"
    )).toHaveLength(0);
    expect(store.listPendingVerifierAdvisoryDispatches("tenant-a", 10)).toHaveLength(0);
    store.close();
  });

  it("does not publish a terminal checkpoint when completion loses its fence", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const leaseToken = "lease-token-checkpoint-terminal-stale";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-checkpoint-terminal-stale"),
      leaseToken,
      leaseDurationMs: 60_000,
      gateConfig: gateConfig(),
    })!;
    const current = checkpointHead(lease, 1, "d");
    store.compareAndSwapAttemptCheckpointHead({
      ...mutation(1, "checkpoint-terminal-stale-current"),
      unitId: lease.unitId,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
      leaseToken,
      expectedStateDigest: null,
      next: current,
      gateConfig: gateConfig(),
    });
    const terminal = checkpointHead(lease, 2, "a");
    const candidate = store.getCampaign("tenant-a", "campaign-a")!.units[0]!;
    const authorization = gateConfig();
    const candidateSeal = {
      schemaVersion: 1,
      candidateRevision: candidate.candidateRevision,
      candidateDigest: candidate.candidateDigest,
      workspaceManifestDigest: digest("d"),
      workspacePayloadDigest: digest("e"),
      sealDigest: digest("f"),
    } satisfies TransformerCandidateSeal;
    const completionIntent = {
      schemaVersion: 1,
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: lease.unitId,
      episodeId: terminal.episodeId,
      candidateSealDigest: candidateSeal.sealDigest,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
      leaseTokenDigest: lease.leaseTokenDigest,
      sourceRevision: candidate.snapshot.revision,
      sourceDigest: candidate.snapshot.digest,
      candidateRevision: candidate.candidateRevision,
      candidateDigest: candidate.candidateDigest,
      authorizationDigest: createTransformerAttemptAuthorizationDigest(authorization),
      verificationPassed: true,
      actualCostUsd: 0.25,
      accounting: adaptiveAccounting({ actualCostUsd: 0.25, wallTimeMs: 60_000 }),
      observedAt: time(2),
      evidenceRefs: ["evidence://operation/complete-checkpoint-terminal-stale"],
    } satisfies TransformerAttemptCompletionIntent;
    const completionDigest = createTransformerAttemptCompletionDigest(completionIntent);
    const completionIdentity = createTransformerAttemptEffectIdentity(
      terminal.episodeId,
      "coordinator_complete",
      createTransformerCoordinatorCompletionSlot(completionDigest),
      createTransformerCoordinatorCompletionRequestDigest(
        terminal.episodeId,
        candidateSeal,
        completionIntent,
      ),
    );

    expect(() => store.completeAttemptWithCheckpointHead({
      ...mutation(2, "complete-checkpoint-terminal-stale"),
      idempotencyKey: completionIdentity.idempotencyKey,
      leaseToken,
      expectedStateDigest: current.stateDigest,
      nextCheckpointHead: terminal,
      candidateSeal,
      completionIntent,
      gateConfig: authorization,
    })).toThrow("transformer_pilot_fence_expired");
    expect(store.getCampaign("tenant-a", "campaign-a")!.units[0]).toMatchObject({
      state: "running",
      attemptCheckpointHead: current,
    });
    expect(store.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.completed_with_checkpoint"
    )).toHaveLength(0);
    store.close();
  });

  it("rejects oversized or cross-scope checkpoint locators without mutation", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const leaseToken = "lease-token-checkpoint-shape-0001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-checkpoint-shape"),
      leaseToken,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const head = checkpointHead(lease, 1, "d");
    const revisionBefore = store.getCampaign("tenant-a", "campaign-a")!.revision;
    const eventsBefore = store.listEvents("tenant-a", "campaign-a").length;
    const baseInput = {
      ...mutation(2, "checkpoint-invalid-shape"),
      unitId: lease.unitId,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
      leaseToken,
      expectedStateDigest: null,
      gateConfig: gateConfig(),
    };

    expect(() => store.compareAndSwapAttemptCheckpointHead({
      ...baseInput,
      next: { ...head, ciphertextBase64: "x".repeat(100_000) } as TransformerAttemptCheckpointHead,
    })).toThrow("transformer_pilot_checkpoint_head_invalid");
    expect(() => store.compareAndSwapAttemptCheckpointHead({
      ...baseInput,
      idempotencyKey: "checkpoint-cross-tenant-key",
      next: {
        ...head,
        envelopeStorageKey: transformerAttemptCheckpointEnvelopeStorageKey({
          tenantId: "tenant-b",
          campaignId: "campaign-a",
          unitId: lease.unitId,
          episodeId: head.episodeId,
          generation: head.generation,
          envelopeDigest: head.envelopeDigest,
        }),
      },
    })).toThrow("transformer_pilot_checkpoint_storage_key_mismatch");
    const invalidKeys = [
      transformerAttemptCheckpointEnvelopeStorageKey({
        tenantId: "tenant-a",
        campaignId: "campaign-b",
        unitId: lease.unitId,
        episodeId: head.episodeId,
        generation: head.generation,
        envelopeDigest: head.envelopeDigest,
      }),
      transformerAttemptCheckpointEnvelopeStorageKey({
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        unitId: "unit-b",
        episodeId: head.episodeId,
        generation: head.generation,
        envelopeDigest: head.envelopeDigest,
      }),
      transformerAttemptCheckpointEnvelopeStorageKey({
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        unitId: lease.unitId,
        episodeId: "transformer-episode-other",
        generation: head.generation,
        envelopeDigest: head.envelopeDigest,
      }),
      transformerAttemptCheckpointEnvelopeStorageKey({
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        unitId: lease.unitId,
        episodeId: head.episodeId,
        generation: head.generation,
        envelopeDigest: digest("b"),
      }),
      "a//b",
      "a/./b",
      "a/b/",
    ];
    invalidKeys.forEach((envelopeStorageKey, index) => {
      expect(() => store.compareAndSwapAttemptCheckpointHead({
        ...baseInput,
        idempotencyKey: `checkpoint-unrelated-key-${index}`,
        next: { ...head, envelopeStorageKey },
      })).toThrow("transformer_pilot_checkpoint_storage_key_mismatch");
    });
    expect(store.getCampaign("tenant-a", "campaign-a")!.revision).toBe(revisionBefore);
    expect(store.listEvents("tenant-a", "campaign-a")).toHaveLength(eventsBefore);
    store.close();
  });

  it("never returns checkpoint authority for a corrupt persisted lease expiry", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-pilot-checkpoint-expiry-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    let store = new TransformerPilotExecutionStore(path);
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-checkpoint-corrupt-expiry"),
      leaseToken: "lease-token-checkpoint-expiry-0001",
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    store.close();

    const probe = new DatabaseSync(path);
    const row = probe.prepare(
      "SELECT body_json FROM tf_pilot_campaigns WHERE tenant_id = ? AND campaign_id = ?",
    ).get("tenant-a", "campaign-a") as { body_json: string };
    const body = JSON.parse(row.body_json) as { units: Array<{ leaseExpiresAt?: string }> };
    body.units[0]!.leaseExpiresAt = "not-a-timestamp";
    probe.prepare(
      "UPDATE tf_pilot_campaigns SET body_json = ? WHERE tenant_id = ? AND campaign_id = ?",
    ).run(JSON.stringify(body), "tenant-a", "campaign-a");
    probe.close();

    store = new TransformerPilotExecutionStore(path);
    expect(store.readAttemptCheckpointLease({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: lease.unitId,
      episodeId: "transformer-episode-corrupt-expiry",
      observedAt: time(2),
    })).toBeNull();
    store.close();
  });

  it("replays the exact checkpoint result after a later head advances", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const leaseToken = "lease-token-checkpoint-replay-0001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-checkpoint-replay"),
      leaseToken,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const first = checkpointHead(lease, 1, "d");
    const second = checkpointHead(lease, 2, "a");
    const firstInput = {
      ...mutation(2, "checkpoint-replay-first"),
      unitId: lease.unitId,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
      leaseToken,
      expectedStateDigest: null,
      next: first,
      gateConfig: gateConfig(),
    };
    expect(store.compareAndSwapAttemptCheckpointHead(firstInput)).toEqual(first);
    expect(store.compareAndSwapAttemptCheckpointHead({
      ...mutation(3, "checkpoint-replay-second"),
      unitId: lease.unitId,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
      leaseToken,
      expectedStateDigest: first.stateDigest,
      next: second,
      gateConfig: gateConfig(),
    })).toEqual(second);

    expect(store.compareAndSwapAttemptCheckpointHead(firstInput)).toEqual(first);
    expect(store.readAttemptCheckpointHead({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: lease.unitId,
      episodeId: first.episodeId,
    })).toEqual(second);
    expect(store.listEvents("tenant-a", "campaign-a").filter((event) =>
      event.type === "attempt.checkpoint_head_advanced"
    )).toHaveLength(2);
    store.close();
  });

  it("binds checkpoint heads to the exact live lease across renewal and expiry", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const leaseToken = "lease-token-checkpoint-fence-0001";
    const lease = store.claimNextAttempt({
      ...mutation(1, "claim-checkpoint-fence"),
      leaseToken,
      leaseDurationMs: 60_000,
      gateConfig: gateConfig(),
    })!;
    const head = checkpointHead(lease, 1, "d");

    expect(() => store.compareAndSwapAttemptCheckpointHead({
      ...mutation(1, "checkpoint-wrong-token"),
      unitId: lease.unitId,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
      leaseToken: "lease-token-checkpoint-stale-0001",
      expectedStateDigest: null,
      next: head,
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_fence_stale");
    store.renewAttemptLease({
      ...mutation(1, "renew-checkpoint-fence"),
      observedAt: "2026-08-02T08:01:30.000Z",
      unitId: lease.unitId,
      leaseGeneration: lease.leaseGeneration,
      leaseToken,
      leaseDurationMs: 60_000,
      gateConfig: gateConfig(),
    });
    expect(store.compareAndSwapAttemptCheckpointHead({
      ...mutation(2, "checkpoint-after-renewal"),
      observedAt: "2026-08-02T08:02:00.000Z",
      unitId: lease.unitId,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
      leaseToken,
      expectedStateDigest: null,
      next: head,
      gateConfig: gateConfig(),
    })).toEqual(head);
    expect(store.readAttemptCheckpointLease({
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      unitId: lease.unitId,
      episodeId: head.episodeId,
      observedAt: "2026-08-02T08:02:30.000Z",
    })).toBeNull();
    expect(() => store.compareAndSwapAttemptCheckpointHead({
      ...mutation(3, "checkpoint-after-expiry"),
      observedAt: "2026-08-02T08:02:30.000Z",
      unitId: lease.unitId,
      attemptNumber: lease.attemptNumber,
      leaseGeneration: lease.leaseGeneration,
      leaseToken,
      expectedStateDigest: head.stateDigest,
      next: checkpointHead(lease, 2, "b"),
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_fence_expired");
    store.close();
  });

  it("continues one checkpoint episode only under an authorized successor lease", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const originalToken = "lease-token-checkpoint-original-001";
    const original = store.claimNextAttempt({
      ...mutation(1, "claim-checkpoint-original"),
      leaseToken: originalToken,
      gateConfig: gateConfig(),
    })!;
    const first = checkpointHead(original, 1, "d");
    store.compareAndSwapAttemptCheckpointHead({
      ...mutation(1, "checkpoint-original-head"),
      unitId: original.unitId,
      attemptNumber: original.attemptNumber,
      leaseGeneration: original.leaseGeneration,
      leaseToken: originalToken,
      expectedStateDigest: null,
      next: first,
      gateConfig: gateConfig(),
    });
    const expired = store.expireAttempt({
      ...mutation(2, "expire-checkpoint-original"),
      unitId: original.unitId,
      leaseGeneration: original.leaseGeneration,
      gateConfig: gateConfig(),
    });
    store.control({
      ...mutation(3, "authorize-checkpoint-successor"),
      action: "authorize_retry",
      unitId: original.unitId,
    });
    store.control({
      ...mutation(4, "resolve-checkpoint-original"),
      action: "resolve_exception",
      exceptionId: expired.exceptions[0]!.id,
      resolution: "Successor continues the authenticated checkpoint episode",
    });
    store.control({ ...mutation(5, "resume-checkpoint-successor"), action: "resume" });
    const successorToken = "lease-token-checkpoint-successor-01";
    const successor = store.claimNextAttempt({
      ...mutation(6, "claim-checkpoint-successor"),
      leaseToken: successorToken,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    const secondBase = checkpointHead(successor, 2, "a");
    const second = {
      ...secondBase,
      episodeId: first.episodeId,
      envelopeStorageKey: transformerAttemptCheckpointEnvelopeStorageKey({
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        unitId: successor.unitId,
        episodeId: first.episodeId,
        generation: secondBase.generation,
        envelopeDigest: secondBase.envelopeDigest,
      }),
    };

    expect(() => store.compareAndSwapAttemptCheckpointHead({
      ...mutation(7, "checkpoint-original-stale"),
      unitId: original.unitId,
      attemptNumber: original.attemptNumber,
      leaseGeneration: original.leaseGeneration,
      leaseToken: originalToken,
      expectedStateDigest: first.stateDigest,
      next: second,
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_fence_stale");
    expect(store.compareAndSwapAttemptCheckpointHead({
      ...mutation(7, "checkpoint-successor-head"),
      unitId: successor.unitId,
      attemptNumber: successor.attemptNumber,
      leaseGeneration: successor.leaseGeneration,
      leaseToken: successorToken,
      expectedStateDigest: first.stateDigest,
      next: second,
      gateConfig: gateConfig(),
    })).toEqual(second);
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
    const replay = second.claimNextAttempt({ ...claim, observedAt: time(2) });

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
    const firstPage = store.listRunnableCampaignPage("tenant-a", 2);
    expect(firstPage.campaigns.map((item) => item.campaignId)).toEqual(["campaign-a", "campaign-b"]);
    expect(firstPage.scannedCount).toBe(2);
    expect(firstPage.nextCursor).toEqual({
      createdAt: time(1), tenantId: "tenant-a", campaignId: "campaign-b",
    });
    const secondPage = store.listRunnableCampaignPage("tenant-a", 2, undefined, firstPage.nextCursor!);
    expect(secondPage.campaigns.map((item) => item.campaignId)).toEqual(["campaign-z"]);
    expect(secondPage.scannedCount).toBe(1);
    expect(secondPage.nextCursor).toBeNull();
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

  it("keeps campaign pages stable when an already-scanned campaign mutates", () => {
    const store = new TransformerPilotExecutionStore();
    const base = createInput([unit("unit-a", "repo-a", "a", "c")]);
    for (const campaignId of ["campaign-a", "campaign-b", "campaign-z"] as const) {
      store.createCampaign({
        ...base,
        campaignId,
        observedAt: time(1),
        idempotencyKey: `create-${campaignId}`,
      });
    }

    const firstPage = store.listRunnableCampaignPage("tenant-a", 2);
    expect(firstPage.campaigns.map((item) => item.campaignId)).toEqual(["campaign-a", "campaign-b"]);
    store.bindRoutingAttempt({
      ...mutation(2, "bind-campaign-a"),
      campaignId: "campaign-a",
      runId: "run-a",
      envelopeId: "envelope-a",
      outcomeIdempotencyKey: "outcome-a",
      executorId: "executor-a",
      providerId: "provider-a",
      evidenceRefs: ["evidence-a"],
      gateConfig: gateConfig(),
    });

    const secondPage = store.listRunnableCampaignPage(
      "tenant-a",
      2,
      undefined,
      firstPage.nextCursor!,
    );
    expect(secondPage.campaigns.map((item) => item.campaignId)).toEqual(["campaign-z"]);
    expect(secondPage.scannedCount).toBe(1);
    expect(secondPage.nextCursor).toBeNull();
    store.close();
  });

  it("upgrades the legacy campaign table to the indexed immutable cursor", () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-pilot-page-upgrade-"));
    roots.push(root);
    const path = join(root, "pilot.sqlite");
    const predecessor = new TransformerPilotExecutionStore(path);
    predecessor.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    predecessor.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP INDEX IF EXISTS tf_pilot_campaigns_created_at_idx;
      DROP INDEX IF EXISTS tf_pilot_campaigns_tenant_created_at_idx;
      ALTER TABLE tf_pilot_campaigns RENAME TO tf_pilot_campaigns_with_cursor;
      CREATE TABLE tf_pilot_campaigns (
        tenant_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, campaign_id)
      );
      INSERT INTO tf_pilot_campaigns (tenant_id, campaign_id, revision, body_json)
        SELECT tenant_id, campaign_id, revision, body_json
        FROM tf_pilot_campaigns_with_cursor;
      DROP TABLE tf_pilot_campaigns_with_cursor;
    `);
    legacy.close();

    const upgraded = new TransformerPilotExecutionStore(path);
    expect(upgraded.listRunnableCampaignPage("tenant-a", 1)).toMatchObject({
      campaigns: [{ campaignId: "campaign-a" }],
      scannedCount: 1,
      nextCursor: null,
    });
    const inspection = new DatabaseSync(path);
    expect(inspection.prepare(
      "SELECT name FROM pragma_table_info('tf_pilot_campaigns') WHERE name = 'created_at'",
    ).get()).toEqual({ name: "created_at" });
    expect(inspection.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tf_pilot_campaigns_created_at_idx'",
    ).get()).toEqual({ name: "tf_pilot_campaigns_created_at_idx" });
    expect(inspection.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tf_pilot_campaigns_tenant_created_at_idx'",
    ).get()).toEqual({ name: "tf_pilot_campaigns_tenant_created_at_idx" });
    const plan = inspection.prepare(
      `EXPLAIN QUERY PLAN
       SELECT tenant_id, campaign_id, created_at, body_json
       FROM tf_pilot_campaigns
       WHERE tenant_id = ?
       ORDER BY created_at, tenant_id, campaign_id
       LIMIT ?`,
    ).all("tenant-a", 2) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain(
      "tf_pilot_campaigns_tenant_created_at_idx",
    );
    expect(() => inspection.prepare(
      "UPDATE tf_pilot_campaigns SET created_at = ? WHERE tenant_id = ? AND campaign_id = ?",
    ).run(time(9), "tenant-a", "campaign-a")).toThrow(
      "transformer_pilot_campaign_created_at_immutable",
    );
    inspection.close();
    upgraded.close();
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

  it("reclaims a preempted attempt whose lease expired, without the sweeper daemon (defect 2)", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    // Claim at 08:01:00 with a 60s lease -> expires at 08:02:00.
    const first = store.claimNextAttempt({
      ...mutation(1, "claim-preempted"),
      leaseToken: "lease-token-preempted-000000001",
      leaseDurationMs: 60_000,
      gateConfig: gateConfig(),
    })!;
    expect(first.unitId).toBe("unit-a");
    expect(first.leaseGeneration).toBe(1);
    // The machine is preempted mid-attempt: the unit stays "running" with an
    // expired lease, and no expireAttempt/sweeper ever runs in this deployment.
    expect(store.getCampaign("tenant-a", "campaign-a")!.units[0]!.state).toBe("running");

    // A later claim (08:05:00, after expiry) automatically reclaims the stranded
    // unit and hands out a fresh lease so the campaign proceeds.
    const reclaimed = store.claimNextAttempt({
      ...mutation(5, "claim-reclaim"),
      leaseToken: "lease-token-reclaim-0000000000001",
      leaseDurationMs: 60_000,
      gateConfig: gateConfig(),
    });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.unitId).toBe("unit-a");
    expect(reclaimed!.leaseGeneration).toBe(first.leaseGeneration + 1);
    expect(reclaimed!.attemptNumber).toBe(first.attemptNumber + 1);
    // Exactly one attempt runs at a time.
    expect(
      store.getCampaign("tenant-a", "campaign-a")!.units.filter((entry) => entry.state === "running"),
    ).toHaveLength(1);

    // The preempted worker returning with its stale lease cannot double-execute:
    // the reclaim bumped leaseGeneration, so the fence rejects the late settle.
    const candidate = store.getCampaign("tenant-a", "campaign-a")!.units[0]!;
    expect(() => store.completeAttempt({
      ...mutation(6, "complete-stale"),
      unitId: "unit-a",
      leaseGeneration: first.leaseGeneration,
      leaseToken: "lease-token-preempted-000000001",
      sourceRevision: candidate.snapshot.revision,
      sourceDigest: candidate.snapshot.digest,
      candidateRevision: candidate.candidateRevision,
      candidateDigest: candidate.candidateDigest,
      verificationPassed: true,
      actualCostUsd: 0.25,
      accounting: adaptiveAccounting({ actualCostUsd: 0.25, wallTimeMs: 60_000 }),
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_fence_stale");
    store.close();
  });

  it("does not let a stranded expired-lease unit block bindRoutingAttempt (defect 2)", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([
      unit("unit-a", "repo-a", "a", "c"),
      unit("unit-b", "repo-b", "b", "d"),
    ]));
    // Claim unit-a at 08:01:00 with a 60s lease -> expires at 08:02:00, then the
    // worker is preempted and the unit is left "running" with an expired lease.
    const first = store.claimNextAttempt({
      ...mutation(1, "claim-strand"),
      leaseToken: "lease-token-strand-0000000000001",
      leaseDurationMs: 60_000,
      gateConfig: gateConfig(),
    })!;
    expect(first.unitId).toBe("unit-a");
    expect(store.getCampaign("tenant-a", "campaign-a")!.units.find((entry) => entry.id === "unit-a")!.state)
      .toBe("running");
    // At 08:05:00 (past unit-a's expiry) binding must still succeed: the stranded
    // unit no longer blocks, so routing binds to the eligible pending unit-b.
    const bound = store.bindRoutingAttempt(routingBinding("bind-after-strand", { observedAt: time(5) }));
    expect(bound.units.find((entry) => entry.id === "unit-b")!.routingSettlement)
      .toMatchObject({ runId: "run-routing-a", envelopeId: "route-routing-a" });
    store.close();
  });

  it("keeps a live-lease running unit blocking bindRoutingAttempt (defect 2)", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([
      unit("unit-a", "repo-a", "a", "c"),
      unit("unit-b", "repo-b", "b", "d"),
    ]));
    // Claim unit-a with a long (live) lease that has not expired at bind time.
    store.claimNextAttempt({
      ...mutation(1, "claim-live-bind"),
      leaseToken: "lease-token-live-bind-000000001",
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    });
    // A live running attempt must still block binding a new route.
    expect(() => store.bindRoutingAttempt(routingBinding("bind-blocked-live", { observedAt: time(5) })))
      .toThrow("transformer_pilot_routing_attempt_not_bindable");
    store.close();
  });

  it("does not reclaim a unit whose lease is still live (defect 2)", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    const first = store.claimNextAttempt({
      ...mutation(1, "claim-live"),
      leaseToken: "lease-token-live-00000000000001",
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    expect(first.leaseGeneration).toBe(1);
    // A second claim while the lease is still valid must not hand out the unit
    // again -- reclaiming a live lease would double-execute the attempt.
    expect(store.claimNextAttempt({
      ...mutation(2, "claim-live-again"),
      leaseToken: "lease-token-live-00000000000002",
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })).toBeNull();
    expect(store.getCampaign("tenant-a", "campaign-a")!.units[0]!.leaseGeneration).toBe(1);
    store.close();
  });
});
