import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import { createOrganizationConstraintContract } from "./organization-constraints.js";
import {
  TransformerPilotExecutionStore,
  type TransformerPilotCampaignInput,
  type TransformerPilotUnitInput,
  type TransformerScmObservation,
} from "./pilot-execution.js";
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
      repositoryId,
      revision: revision(source),
      digest: digest(source),
      evidenceRefs: [`evidence://snapshot/${repositoryId}/${source}`],
    },
    candidateRevision: revision(candidate),
    candidateDigest: digest(candidate),
    recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
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
    const leaseA = store.claimNextAttempt({ ...mutation(1, "claim-a"), leaseToken: tokenA, gateConfig: gateConfig() })!;
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

  it("recovers a crash only after attributable retry authorization and exception resolution", () => {
    const store = new TransformerPilotExecutionStore();
    store.createCampaign(createInput([unit("unit-a", "repo-a", "a", "c")]));
    store.claimNextAttempt({ ...mutation(1, "claim-a"), leaseToken: "lease-token-unit-a-00000001", gateConfig: gateConfig() });
    const crashed = store.recordWorkerCrash({ ...mutation(2, "crash-a"), unitId: "unit-a", gateConfig: gateConfig() });
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
      store.claimNextAttempt({ ...mutation(1, `claim-${name}`), leaseToken: token, gateConfig: gateConfig() });
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
      const lease = store.claimNextAttempt({ ...mutation(minute, `claim-${id}`), leaseToken: token, gateConfig: gateConfig() })!;
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
      const lease = store.claimNextAttempt({ ...mutation(minute, `claim-${id}`), leaseToken: token, gateConfig: gateConfig() })!;
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
});
