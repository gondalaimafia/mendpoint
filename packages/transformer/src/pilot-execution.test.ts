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
    expect(store.listRunnableCampaigns("tenant-a")).toEqual([{
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      environment: "staging",
    }]);
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
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_fence_stale");
    expect(() => store.recordAttemptFailure({
      ...mutation(2, "stale-failure-token"),
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: "lease-token-unit-a-stale-0001",
      code: "candidate_drift",
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
      gateConfig: gateConfig(),
    })).toThrow("transformer_pilot_failure_code_invalid");

    const failureInput = {
      ...mutation(2, "candidate-drift-failure"),
      unitId: "unit-a",
      leaseGeneration: lease.leaseGeneration,
      leaseToken: token,
      code: "candidate_drift" as const,
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
      { tenantId: "tenant-a", campaignId: "campaign-a", environment: "staging" },
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
      { tenantId: "tenant-a", campaignId: "campaign-a", environment: "staging" },
      { tenantId: "tenant-a", campaignId: "campaign-b", environment: "staging" },
      { tenantId: "tenant-a", campaignId: "campaign-z", environment: "staging" },
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
      { tenantId: "tenant-a", campaignId: "campaign-a", environment: "staging" },
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
});
