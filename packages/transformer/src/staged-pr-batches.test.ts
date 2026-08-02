import { describe, expect, it } from "vitest";
import {
  planStagedPullRequestBatches,
  reconcileStagedPullRequestResume,
  type StagedPullRequestBatchPlanningInput,
  type StagedPullRequestObservation,
} from "./staged-pr-batches.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function input(): StagedPullRequestBatchPlanningInput {
  return {
    plannedAt: "2026-08-02T12:00:00.000Z",
    campaign: {
      id: "campaign-one",
      revision: 3,
      blueprintId: "blueprint-one",
      blueprintDigest: DIGEST_A,
      state: "ready",
    },
    policy: {
      maxDraftPullRequestsPerWave: 2,
      advanceOn: "merged",
      requiredCheckNames: ["build", "test"],
      reviewerIds: ["reviewer-a", "reviewer-b"],
      minimumApprovals: 1,
      prohibitAuthorApproval: true,
      requireConversationResolution: true,
      closedWithoutMerge: "halt",
      partialWaveMerge: "halt",
    },
    units: [
      {
        id: "unit-c",
        title: "Update client",
        repositoryId: "repo-c",
        provider: "gitlab",
        baseBranch: "main",
        headBranch: "mendpoint/unit-c",
        sourceRevision: SHA_A,
        candidateRevision: SHA_D,
        dependsOn: ["unit-a"],
        authorId: "agent-transformer",
        evidenceRefs: ["artifact://unit-c"],
        verification: {
          status: "verified",
          artifactDigest: DIGEST_B,
          verifiedRevision: SHA_D,
          evidenceRefs: ["eval://unit-c"],
        },
      },
      {
        id: "unit-b",
        title: "Update worker",
        repositoryId: "repo-b",
        provider: "github",
        baseBranch: "main",
        headBranch: "mendpoint/unit-b",
        sourceRevision: SHA_A,
        candidateRevision: SHA_C,
        dependsOn: [],
        authorId: "agent-transformer",
        evidenceRefs: ["artifact://unit-b"],
        verification: {
          status: "verified",
          artifactDigest: DIGEST_B,
          verifiedRevision: SHA_C,
          evidenceRefs: ["eval://unit-b"],
        },
      },
      {
        id: "unit-a",
        title: "Update API",
        repositoryId: "repo-a",
        provider: "azure_devops",
        baseBranch: "main",
        headBranch: "mendpoint/unit-a",
        sourceRevision: SHA_A,
        candidateRevision: SHA_B,
        dependsOn: [],
        authorId: "agent-transformer",
        evidenceRefs: ["artifact://unit-a"],
        verification: {
          status: "verified",
          artifactDigest: DIGEST_B,
          verifiedRevision: SHA_B,
          evidenceRefs: ["eval://unit-a"],
        },
      },
    ],
  };
}

function planned() {
  const result = planStagedPullRequestBatches(input());
  if (result.decision !== "planned") throw new Error(result.reasons.join(","));
  return result.plan;
}

function observation(
  unitId: string,
  state: StagedPullRequestObservation["state"],
  overrides: Partial<StagedPullRequestObservation> = {},
): StagedPullRequestObservation {
  const unit = planned().waves.flatMap((wave) => wave.pullRequests).find((item) => item.unitId === unitId)!;
  const completedEvidence = state === "merged" ? {
    approvals: [{ reviewerId: "reviewer-a", headRevision: unit.candidateRevision, state: "approved" as const }],
    checks: [
      { name: "build", headRevision: unit.candidateRevision, status: "success" as const },
      { name: "test", headRevision: unit.candidateRevision, status: "success" as const },
    ],
  } : { approvals: [], checks: [] };
  return {
    unitId,
    provider: unit.provider,
    repositoryId: unit.repositoryId,
    state,
    isDraft: true,
    baseRevision: unit.sourceRevision,
    headRevision: unit.candidateRevision,
    ...completedEvidence,
    unresolvedConversationCount: 0,
    evidenceRefs: [`scm://${unitId}`],
    ...overrides,
  };
}

describe("staged Transformer pull request batches", () => {
  it("deterministically groups verified units into bounded dependency waves", () => {
    const first = planStagedPullRequestBatches(input());
    const second = planStagedPullRequestBatches({ ...input(), units: [...input().units].reverse() });
    expect(first).toEqual(second);
    expect(first.decision).toBe("planned");
    if (first.decision !== "planned") return;
    expect(first.plan.waves.map((wave) => wave.pullRequests.map((pr) => pr.unitId))).toEqual([
      ["unit-a", "unit-b"],
      ["unit-c"],
    ]);
    expect(first.plan.waves.flatMap((wave) => wave.pullRequests).every((pr) =>
      pr.delivery.draft && !pr.delivery.autoMerge && !pr.delivery.autoDeploy,
    )).toBe(true);
    expect(first.plan.policy.requiredCheckNames).toEqual(["build", "test"]);
  });

  it("abstains before any action when verification, revisions, evidence, or policy is invalid", () => {
    const candidate = input();
    candidate.units[0]!.verification.status = "failed";
    candidate.units[1]!.verification.verifiedRevision = SHA_D;
    candidate.units[2]!.evidenceRefs = [];
    candidate.policy.minimumApprovals = 3;
    const result = planStagedPullRequestBatches(candidate);
    expect(result).toMatchObject({ decision: "abstained", plan: null });
    if (result.decision !== "abstained") return;
    expect(result.reasons).toEqual(expect.arrayContaining([
      "unit_not_verified:unit-c",
      "verified_revision_mismatch:unit-b",
      "unit_evidence_required:unit-a",
      "review_approval_count_unreachable",
    ]));
  });

  it("authorizes only missing draft creations for the first eligible wave and resumes idempotently", () => {
    const plan = planned();
    const snapshot = {
      planDigest: plan.digest,
      campaignRevision: plan.campaign.revision,
      repositoryHeads: [
        { repositoryId: "repo-a", revision: SHA_A, evidenceRefs: ["scm://repo-a"] },
        { repositoryId: "repo-b", revision: SHA_A, evidenceRefs: ["scm://repo-b"] },
        { repositoryId: "repo-c", revision: SHA_A, evidenceRefs: ["scm://repo-c"] },
      ],
      pullRequests: [] as StagedPullRequestObservation[],
    };
    const first = reconcileStagedPullRequestResume(plan, snapshot);
    const replay = reconcileStagedPullRequestResume(plan, snapshot);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ decision: "resume", waveId: "wave-001" });
    expect(first.actions.map((action) => [action.type, action.unitId])).toEqual([
      ["open_draft", "unit-a"],
      ["open_draft", "unit-b"],
    ]);
    expect(first.actions.every((action) => !action.autoMerge && !action.autoDeploy)).toBe(true);
  });

  it("waits for exact revision CI review and closure policy before advancing", () => {
    const plan = planned();
    const snapshot = {
      planDigest: plan.digest,
      campaignRevision: 3,
      repositoryHeads: [
        { repositoryId: "repo-a", revision: SHA_A, evidenceRefs: ["scm://repo-a"] },
        { repositoryId: "repo-b", revision: SHA_A, evidenceRefs: ["scm://repo-b"] },
        { repositoryId: "repo-c", revision: SHA_A, evidenceRefs: ["scm://repo-c"] },
      ],
      pullRequests: [observation("unit-a", "draft"), observation("unit-b", "draft")],
    };
    expect(reconcileStagedPullRequestResume(plan, snapshot)).toMatchObject({
      decision: "wait",
      waveId: "wave-001",
      reasons: expect.arrayContaining(["checks_incomplete:unit-a", "reviews_incomplete:unit-b"]),
    });

    snapshot.pullRequests = [observation("unit-a", "merged"), observation("unit-b", "merged")];
    const next = reconcileStagedPullRequestResume(plan, snapshot);
    expect(next).toMatchObject({ decision: "resume", waveId: "wave-002" });
    expect(next.actions.map((action) => action.unitId)).toEqual(["unit-c"]);
  });

  it("halts on campaign drift, repository drift, non-draft delivery, closure, and partial merges", () => {
    const plan = planned();
    const baseSnapshot = {
      planDigest: plan.digest,
      campaignRevision: 3,
      repositoryHeads: [
        { repositoryId: "repo-a", revision: SHA_A, evidenceRefs: ["scm://repo-a"] },
        { repositoryId: "repo-b", revision: SHA_A, evidenceRefs: ["scm://repo-b"] },
        { repositoryId: "repo-c", revision: SHA_A, evidenceRefs: ["scm://repo-c"] },
      ],
      pullRequests: [] as StagedPullRequestObservation[],
    };
    expect(reconcileStagedPullRequestResume(plan, { ...baseSnapshot, campaignRevision: 4 })).toMatchObject({
      decision: "halted", reasons: ["campaign_revision_drift"], actions: [],
    });
    expect(reconcileStagedPullRequestResume(plan, {
      ...baseSnapshot,
      repositoryHeads: baseSnapshot.repositoryHeads.map((head) =>
        head.repositoryId === "repo-a" ? { ...head, revision: SHA_D } : head,
      ),
    })).toMatchObject({ decision: "halted", reasons: ["repository_revision_drift:repo-a"], actions: [] });
    expect(reconcileStagedPullRequestResume(plan, {
      ...baseSnapshot,
      pullRequests: [observation("unit-a", "open", { isDraft: false })],
    })).toMatchObject({ decision: "halted", reasons: ["draft_mode_violated:unit-a"], actions: [] });
    expect(reconcileStagedPullRequestResume(plan, {
      ...baseSnapshot,
      pullRequests: [observation("unit-a", "closed")],
    })).toMatchObject({ decision: "halted", reasons: ["closed_without_merge:unit-a"], actions: [] });
    expect(reconcileStagedPullRequestResume(plan, {
      ...baseSnapshot,
      pullRequests: [observation("unit-a", "merged"), observation("unit-b", "draft")],
    })).toMatchObject({ decision: "halted", reasons: ["partial_wave_merge:wave-001"], actions: [] });
  });

  it("rejects stale approvals and checks, unresolved conversations, and unplanned observations", () => {
    const plan = planned();
    const reviewed = observation("unit-a", "draft", {
      approvals: [{ reviewerId: "reviewer-a", headRevision: SHA_A, state: "approved" }],
      checks: [
        { name: "build", headRevision: SHA_B, status: "success" },
        { name: "test", headRevision: SHA_B, status: "success" },
      ],
      unresolvedConversationCount: 1,
    });
    const result = reconcileStagedPullRequestResume(plan, {
      planDigest: plan.digest,
      campaignRevision: 3,
      repositoryHeads: [
        { repositoryId: "repo-a", revision: SHA_A, evidenceRefs: ["scm://repo-a"] },
        { repositoryId: "repo-b", revision: SHA_A, evidenceRefs: ["scm://repo-b"] },
        { repositoryId: "repo-c", revision: SHA_A, evidenceRefs: ["scm://repo-c"] },
      ],
      pullRequests: [reviewed, { ...observation("unit-b", "draft"), unitId: "unknown" }],
    });
    expect(result).toMatchObject({ decision: "halted", actions: [] });
    expect(result.reasons).toEqual(expect.arrayContaining(["unplanned_pr_observation:unknown"]));
  });

  it("halts on explicit CI or review failures and future wave observations", () => {
    const plan = planned();
    const snapshot = {
      planDigest: plan.digest,
      campaignRevision: 3,
      repositoryHeads: [
        { repositoryId: "repo-a", revision: SHA_A, evidenceRefs: ["scm://repo-a"] },
        { repositoryId: "repo-b", revision: SHA_A, evidenceRefs: ["scm://repo-b"] },
        { repositoryId: "repo-c", revision: SHA_A, evidenceRefs: ["scm://repo-c"] },
      ],
      pullRequests: [observation("unit-a", "draft", {
        checks: [{ name: "test", headRevision: SHA_B, status: "failure" }],
      })],
    };
    expect(reconcileStagedPullRequestResume(plan, snapshot)).toMatchObject({
      decision: "halted", reasons: ["check_failed:unit-a"], actions: [],
    });
    expect(reconcileStagedPullRequestResume(plan, {
      ...snapshot,
      pullRequests: [observation("unit-c", "draft")],
    })).toMatchObject({
      decision: "halted", reasons: ["future_wave_observation:unit-c"], actions: [],
    });
  });
});
