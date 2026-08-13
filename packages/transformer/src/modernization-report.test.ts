import { describe, expect, it } from "vitest";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import { createOrganizationConstraintContract } from "./organization-constraints.js";
import {
  TransformerPilotExecutionStore,
  type TransformerPilotCampaignInput,
  type TransformerPilotUnitInput,
  type TransformerScmObservation,
} from "./pilot-execution.js";
import { NODE_RUNTIME_18_TO_20_RECIPE, recipeReference } from "./recipe.js";
import {
  MODERNIZATION_REPORT_SCHEMA_VERSION,
  generateModernizationReport,
  renderModernizationReportMarkdown,
} from "./modernization-report.js";

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

function unit(id: string, repositoryId: string, source: string, candidate: string): TransformerPilotUnitInput {
  return {
    id,
    title: `Migrate ${repositoryId}`,
    ownerId: `owner-${repositoryId}`,
    reviewerIds: [`reviewer-${repositoryId}`],
    dependsOn: [],
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
    accounting: {
      plannerCalls: 0,
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      actualCostUsd: 0.25,
      wallTimeMs: 60_000,
    },
    gateConfig: gateConfig(),
  });
}

function observation(
  unitId: string,
  state: "draft" | "merged" | "closed",
  source: string,
  candidate: string,
): TransformerScmObservation {
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
  };
}

/**
 * Seeds a two-unit, single-wave campaign where unit-a merges and unit-b stays a
 * draft, which produces the divergent completion figures plus one open exception.
 */
function partialMergeStore(): TransformerPilotExecutionStore {
  const store = new TransformerPilotExecutionStore();
  store.createCampaign(createInput([
    unit("unit-a", "repo-a", "a", "c"),
    unit("unit-b", "repo-b", "b", "d"),
  ]));
  for (const [id, token, minute] of [
    ["unit-a", "lease-token-unit-a-00000001", 1],
    ["unit-b", "lease-token-unit-b-00000001", 3],
  ] as const) {
    const lease = store.claimNextAttempt({
      ...mutation(minute, `claim-${id}`),
      leaseToken: token,
      leaseDurationMs: 3_600_000,
      gateConfig: gateConfig(),
    })!;
    complete(store, id, minute + 1, token, lease.leaseGeneration);
  }
  store.authorizeCurrentWaveDrafts({ ...mutation(5, "draft-wave"), gateConfig: gateConfig() });
  store.reconcileWave({
    ...mutation(6, "partial-merge"),
    wave: 1,
    observations: [observation("unit-a", "merged", "a", "c"), observation("unit-b", "draft", "b", "d")],
    gateConfig: gateConfig(),
  });
  return store;
}

describe("modernization report generator", () => {
  it("reflects real campaign completion, waves, units, PRs, and exceptions", () => {
    const store = partialMergeStore();
    const stored = store.getCampaign("tenant-a", "campaign-a")!;
    const storedMetrics = store.metrics("tenant-a", "campaign-a");

    const report = generateModernizationReport(store, "tenant-a", "campaign-a");

    expect(report.schemaVersion).toBe(MODERNIZATION_REPORT_SCHEMA_VERSION);

    // Completion: the two divergent numbers, each traced to its stored metric.
    expect(report.summary.completion.unitCompletionRate).toBe(storedMetrics.campaignCompletionRate);
    expect(report.summary.completion.waveCompletionRate).toBe(storedMetrics.waveCompletionRate);
    expect(report.summary.completion).toMatchObject({
      unitCompletionRate: 0.5,
      waveCompletionRate: 0,
      unitsMerged: 1,
      unitsTotal: 2,
      wavesCompleted: 0,
      wavesTotal: 1,
      clampedToComplete: false,
    });

    // Units by state mirrors the real unit states (unit-a merged, unit-b accepted).
    expect(report.progress.units.merged).toBe(1);
    expect(report.progress.units.inReview).toBe(1);
    expect(report.progress.units.byState.merged).toBe(1);
    expect(report.progress.units.byState.accepted).toBe(1);
    expect(report.progress.units.total).toBe(stored.units.length);

    // Pull requests derived from unit lifecycle states.
    expect(report.progress.pullRequests).toEqual({ draftsOpen: 0, accepted: 2, merged: 1 });
    expect(report.progress.pullRequests.accepted).toBe(storedMetrics.batchAcceptanceRate * stored.units.length);

    // Waves and per-recipe breakdown.
    expect(report.progress.waves).toMatchObject({ total: 1, completed: 0 });
    expect(report.progress.byRecipe).toHaveLength(1);
    expect(report.progress.byRecipe[0]).toMatchObject({ total: 2, merged: 1 });

    // Exceptions register reflects the real open exception.
    expect(report.exceptions.total).toBe(stored.exceptions.length);
    expect(report.exceptions.open).toBe(storedMetrics.openExceptionCount);
    expect(report.exceptions.byCode.partial_wave_merge).toBe(1);
    expect(report.exceptions.register[0]).toMatchObject({ code: "partial_wave_merge", state: "open" });

    // Risk and remaining work.
    expect(report.risks.remainingUnits).toBe(1);
    expect(report.risks.humanReviewQueue).toEqual({ unitsAwaitingReview: 1, openExceptions: 1 });

    store.close();
  });

  it("is deterministic for identical campaign state", () => {
    const first = partialMergeStore();
    const second = partialMergeStore();
    const reportA = generateModernizationReport(first, "tenant-a", "campaign-a");
    const reportB = generateModernizationReport(second, "tenant-a", "campaign-a");
    expect(reportB).toEqual(reportA);
    expect(renderModernizationReportMarkdown(reportB)).toBe(renderModernizationReportMarkdown(reportA));
    first.close();
    second.close();
  });

  it("renders an executive Markdown summary that cites its data sources", () => {
    const store = partialMergeStore();
    const markdown = renderModernizationReportMarkdown(
      generateModernizationReport(store, "tenant-a", "campaign-a"),
    );
    expect(markdown).toContain("# Modernization report: campaign-a");
    expect(markdown).toContain("Unit completion: 50.0%");
    expect(markdown).toContain("Wave completion: 0.0%");
    expect(markdown).toContain("partial_wave_merge");
    expect(markdown).toContain("## Data sources");
    expect(markdown).toContain("TransformerPilotMetrics.campaignCompletionRate");
    // No em or en dashes in the rendered summary.
    expect(markdown).not.toMatch(/[–—]/);
    store.close();
  });

  it("reports a fully completed campaign as 100 percent at both levels", () => {
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
    store.authorizeCurrentWaveDrafts({ ...mutation(3, "draft-a"), gateConfig: gateConfig() });
    store.reconcileWave({
      ...mutation(4, "merge-a"),
      wave: 1,
      observations: [observation("unit-a", "merged", "a", "c")],
      gateConfig: gateConfig(),
    });

    const report = generateModernizationReport(store, "tenant-a", "campaign-a");
    expect(report.summary.status).toBe("completed");
    expect(report.summary.completion).toMatchObject({
      unitCompletionRate: 1,
      waveCompletionRate: 1,
      clampedToComplete: true,
    });
    expect(report.exceptions.total).toBe(0);
    expect(report.risks.remainingUnits).toBe(0);
    store.close();
  });

  it("throws for an unknown campaign", () => {
    const store = new TransformerPilotExecutionStore();
    expect(() => generateModernizationReport(store, "tenant-a", "missing")).toThrow(
      "transformer_pilot_campaign_not_found",
    );
    store.close();
  });
});
