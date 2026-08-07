import { describe, expect, it } from "vitest";
import {
  adaptiveReviewActionEnabled,
  organizeAdaptiveCandidates,
  candidateLifecycle,
  formatCandidateBytes,
  mergeAdaptiveCandidateHistory,
  pendingAdaptiveCandidates,
  reviewReadiness,
  type AdaptiveCandidateDetail,
  type AdaptiveDeliveryView,
  type AdaptiveCandidateSummary,
} from "./candidate-model.js";

function summary(
  id: string,
  status: AdaptiveCandidateSummary["status"],
  expiresAt: string,
): AdaptiveCandidateSummary {
  return {
    id,
    kind: "adaptive",
    status,
    campaignId: "campaign-a",
    unitId: "unit-a",
    attemptId: "attempt-a",
    repositoryId: "repository-a",
    snapshotId: "snapshot-a",
    baseBranch: "main",
    expectedBaseRevision: "a".repeat(40),
    candidateDigest: `sha256:${"b".repeat(64)}`,
    divergedFromDigest: `sha256:${"c".repeat(64)}`,
    failingCommandId: "verify",
    changedFileCount: 1,
    expiresAt,
    createdAt: "2026-08-06T10:00:00.000Z",
    reviewedAt: null,
    promotedAt: null,
    reviewerPrincipalId: null,
    reviewDecision: null,
    reviewRationale: null,
    supersedesCandidateId: null,
    supersededByCandidateId: null,
    generation: 1,
  };
}

function detail(overrides: Partial<AdaptiveCandidateDetail> = {}): AdaptiveCandidateDetail {
  return {
    ...summary("candidate-a", "review_pending", "2026-08-07T10:00:00.000Z"),
    sealVerified: true,
    evidenceStatus: "verified",
    evidenceErrorCode: null,
    reviewEvidenceComplete: true,
    semanticReview: {
      groups: [{
        category: "configuration",
        edits: [{
          path: "package.json",
          changeType: "modify",
          beforeContent: "{}",
          afterContent: "{\n  \"type\": \"module\"\n}",
          beforeDigest: `sha256:${"c".repeat(64)}`,
          afterDigest: `sha256:${"d".repeat(64)}`,
          beforeMode: "100644",
          afterMode: "100755",
          rationale: "Use the required module format.",
          risk: "medium",
          confidence: 91,
          bytes: { before: 2, after: 24 },
        }],
      }],
      verification: {
        passed: true,
        commandId: "verify",
        summary: "The objective verification passed.",
        outputDigest: `sha256:${"e".repeat(64)}`,
      },
      overallRisk: "medium",
      confidence: 91,
    },
    changedPaths: ["package.json"],
    previewComplete: true,
    totalBytes: 12,
    files: [{
      path: "package.json",
      action: "write",
      proposedContent: "{\n  \"type\": \"module\"\n}",
      mode: "100755",
      sha256: `sha256:${"d".repeat(64)}`,
      bytes: 12,
    }],
    omittedPaths: [],
    ...overrides,
  };
}

function delivery(
  status: AdaptiveDeliveryView["status"],
  overrides: Partial<AdaptiveDeliveryView> = {},
): AdaptiveDeliveryView {
  return {
    id: `delivery-${status}`,
    status,
    jobId: `job-${status}`,
    branchName: null,
    baseBranch: "main",
    baseRevision: null,
    commitSha: null,
    draftPr: null,
    draftPrNumber: null,
    draftPrUrl: null,
    errorCode: null,
    requestedAt: "2026-08-06T12:00:00.000Z",
    deliveredAt: null,
    ...overrides,
  };
}

describe("Transformer adaptive candidate review model", () => {
  it("shows only pending candidates and puts the earliest expiry first", () => {
    expect(pendingAdaptiveCandidates([
      summary("later", "review_pending", "2026-08-08T10:00:00.000Z"),
      summary("approved", "approved", "2026-08-06T11:00:00.000Z"),
      summary("sooner", "review_pending", "2026-08-07T10:00:00.000Z"),
    ]).map((candidate) => candidate.id)).toEqual(["sooner", "later"]);
  });

  it("fails approval closed when the seal or complete preview is unavailable", () => {
    expect(reviewReadiness(detail())).toEqual({ canApprove: true, canReject: true, canRegenerate: true, blockers: [] });
    expect(reviewReadiness(detail({ sealVerified: false }))).toMatchObject({
      canApprove: false,
      canReject: true,
      blockers: ["The sealed candidate could not be verified."],
    });
    expect(reviewReadiness(detail({ previewComplete: false, omittedPaths: ["package.json"] }))).toMatchObject({
      canApprove: false,
      canReject: true,
      blockers: ["The full proposed change is not available for review."],
    });
    expect(reviewReadiness(detail({
      reviewEvidenceComplete: false,
      semanticReview: null,
    }))).toMatchObject({
      canApprove: false,
      canReject: true,
      blockers: ["The complete explanation and verification evidence is not available for review."],
    });
  });

  it("disables both review actions after a decision", () => {
    expect(reviewReadiness(detail({ status: "approved", reviewDecision: "approve" }))).toMatchObject({
      canApprove: false,
      canReject: false,
      canRegenerate: false,
    });
  });

  it("keeps preview access read only even when candidate evidence is ready", () => {
    const readiness = reviewReadiness(detail());
    expect(adaptiveReviewActionEnabled({
      decision: "approve",
      humanIdentity: false,
      busy: false,
      rationale: "Reviewed exact evidence",
      readiness,
    })).toBe(false);
    expect(adaptiveReviewActionEnabled({
      decision: "reject",
      humanIdentity: null,
      busy: false,
      rationale: "Reviewed exact evidence",
      readiness,
    })).toBe(false);
    expect(adaptiveReviewActionEnabled({
      decision: "approve",
      humanIdentity: true,
      busy: false,
      rationale: "Reviewed exact evidence",
      readiness,
    })).toBe(true);
    expect(adaptiveReviewActionEnabled({
      decision: "regenerate",
      humanIdentity: true,
      busy: false,
      rationale: "Use a safer migration",
      readiness,
    })).toBe(true);
  });

  it("formats exact file byte sizes for review", () => {
    expect(formatCandidateBytes(12)).toBe("12 B");
    expect(formatCandidateBytes(1_536)).toBe("1.5 KB");
    expect(formatCandidateBytes(1_572_864)).toBe("1.5 MB");
  });

  it("keeps active delivery work visible and groups every terminal state into history", () => {
    const pending = summary("pending", "review_pending", "2026-08-08T10:00:00.000Z");
    const deliveryPending = {
      ...summary("delivery-pending", "approved", "2026-08-08T10:00:00.000Z"),
      delivery: delivery("delivery_pending"),
    };
    const deliveryFailed = {
      ...summary("delivery-failed", "approved", "2026-08-08T10:00:00.000Z"),
      delivery: delivery("delivery_failed", { errorCode: "github_unavailable" }),
    };
    const delivered = {
      ...summary("delivered", "promoted", "2026-08-08T10:00:00.000Z"),
      promotedAt: "2026-08-06T15:00:00.000Z",
      delivery: delivery("delivered", {
        draftPrUrl: "https://github.com/example/repo/pull/42",
      }),
    };
    const rejected = {
      ...summary("rejected", "rejected", "2026-08-08T10:00:00.000Z"),
      reviewedAt: "2026-08-06T14:00:00.000Z",
    };
    const superseded = {
      ...summary("superseded", "superseded", "2026-08-08T10:00:00.000Z"),
      reviewedAt: "2026-08-06T13:00:00.000Z",
      reviewDecision: "regenerate" as const,
    };
    const expired = summary("expired", "expired", "2026-08-06T09:00:00.000Z");

    const organized = organizeAdaptiveCandidates([
      delivered,
      rejected,
      superseded,
      pending,
      deliveryFailed,
      expired,
      deliveryPending,
    ]);
    expect(organized.attention.map((candidate) => candidate.id)).toEqual([
      "pending",
      "delivery-failed",
      "delivery-pending",
    ]);
    expect(organized.history.map((candidate) => candidate.id)).toEqual([
      "delivered",
      "rejected",
      "superseded",
      "expired",
    ]);
  });

  it("provides clear lifecycle labels and evidence actions", () => {
    expect(candidateLifecycle(summary("pending", "review_pending", "2099-01-01T00:00:00.000Z")))
      .toMatchObject({ label: "Review pending", tone: "active", action: "Review files" });
    expect(candidateLifecycle({
      ...summary("failed", "approved", "2099-01-01T00:00:00.000Z"),
      delivery: delivery("delivery_failed"),
    })).toMatchObject({ label: "Draft delivery failed", tone: "danger", action: "View failure" });
    expect(candidateLifecycle({
      ...summary("delivered", "promoted", "2099-01-01T00:00:00.000Z"),
      delivery: delivery("delivered", { draftPrUrl: "https://github.com/example/repo/pull/42" }),
    })).toMatchObject({ label: "Draft delivered", tone: "success", action: "View evidence" });
    expect(candidateLifecycle(summary("rejected", "rejected", "2099-01-01T00:00:00.000Z")))
      .toMatchObject({ label: "Rejected", tone: "neutral", action: "View decision" });
    expect(candidateLifecycle(summary("superseded", "superseded", "2099-01-01T00:00:00.000Z")))
      .toMatchObject({ label: "Regeneration requested", tone: "neutral", action: "View lineage" });
    expect(candidateLifecycle({
      ...summary("blocked", "superseded", "2099-01-01T00:00:00.000Z"),
      regeneration: {
        id: "regeneration-a",
        candidateId: "blocked",
        campaignId: "campaign-a",
        unitId: "unit-a",
        reviewerPrincipalId: "human:reviewer-a",
        rationale: "Use a safer migration.",
        rationaleDigest: `sha256:${"d".repeat(64)}`,
        status: "pending",
        attemptCount: 0,
        lastErrorCode: "external_processing_authorization_required",
        externalProcessingAuthorizationRequired: true,
        authorizationMessage: "Explicit customer authorization is required before review feedback can be sent to the configured model.",
        supersedingCandidateId: null,
        requestedAt: "2026-08-06T12:00:00.000Z",
        scheduledAt: null,
        completedAt: null,
      },
    })).toMatchObject({
      label: "Awaiting customer authorization",
      tone: "active",
      action: "View requirement",
    });
    expect(candidateLifecycle(summary("expired", "expired", "2099-01-01T00:00:00.000Z")))
      .toMatchObject({ label: "Expired", tone: "neutral", action: "View record" });
  });

  it("appends cursor history pages without duplicating an overlapping record", () => {
    const first = [
      summary("history-3", "rejected", "2099-01-01T00:00:00.000Z"),
      summary("history-2", "expired", "2099-01-01T00:00:00.000Z"),
    ];
    const second = [
      summary("history-2", "expired", "2099-01-01T00:00:00.000Z"),
      summary("history-1", "promoted", "2099-01-01T00:00:00.000Z"),
    ];

    expect(mergeAdaptiveCandidateHistory(first, second).map((candidate) => candidate.id))
      .toEqual(["history-3", "history-2", "history-1"]);
  });
});
