import { describe, expect, it } from "vitest";
import { createWardenDraftPrPackage } from "./warden-pr-package.js";

const digest = "a".repeat(64);
const tenantId = "tenant-a";

function input() {
  return {
    packageId: "package-1",
    tenantId,
    pullRequestId: "pr-1",
    createdAt: "2026-08-02T10:00:00.000Z",
    summary: "Update the payment request field.",
    rationale: "The approved provider contract removed the previous field.",
    risks: ["Payment requests may reject an invalid payload."],
    source: { artifacts: [{ tenantId, id: "source-1" }] },
    snapshot: {
      tenantId,
      snapshotId: "snapshot-1",
      repositoryId: "repo-1",
      revisionKind: "git_commit" as const,
      resolvedSha: "b".repeat(40),
      manifestSha256: digest,
    },
    findings: [{ tenantId, findingId: "finding-1", evidenceArtifactIds: ["finding-evidence-1"] }],
    candidate: {
      tenantId,
      artifactId: "candidate-1",
      sha256: digest,
      predecessorArtifactId: null,
      edits: [{ editId: "edit-1", path: "src/payments.ts", findingIds: ["finding-1"] }],
    },
    verification: {
      tenantId,
      artifactIds: ["verification-1"],
      evidenceRecordIds: ["evidence-1"],
      verdict: "passed" as const,
      waiverArtifactId: null,
      results: [{ checkId: "contract-suite", status: "passed" as const, evidenceRecordIds: ["evidence-1"] }],
    },
    generation: { kind: "recipe" as const, executorId: "warden", version: "1" },
    policy: { tenantId, artifactId: "policy-1", policyId: "tenant-policy", version: "1", decision: "allow" as const },
    ownership: { tenantId, codeownersArtifactId: "owners-1", ownerPrincipalIds: ["github-team:org/maintainers"] },
    review: { tenantId, requirementsArtifactId: "review-1", requiredReviewerCount: 1, reviewerPrincipalIds: ["github-team:org/maintainers"] },
    rollback: {
      tenantId,
      artifactId: "rollback-1",
      strategy: "close_draft" as const,
      verificationEvidenceRecordIds: ["evidence-1"],
      instructions: "Close the draft and restore the recorded snapshot.",
    },
    delivery: { mode: "draft" as const, autoMerge: false as const, autoDeploy: false as const },
  };
}

describe("Warden draft PR package", () => {
  it("renders every review field from the immutable package", () => {
    const result = createWardenDraftPrPackage(input());

    expect(result.markdown).toContain("#### Summary");
    expect(result.markdown).toContain("#### Why");
    expect(result.markdown).toContain("`src/payments.ts`");
    expect(result.markdown).toContain("contract-suite:** passed");
    expect(result.markdown).toContain("#### Risks");
    expect(result.markdown).toContain("#### Rollback");
    expect(result.markdown).toContain("finding-evidence-1");
    expect(result.markdown).toContain("github-team:org/maintainers");
    expect(result.markdown).toContain("Automatic merge: disabled");
    expect(result.markdown).toContain("Automatic deployment: disabled");
    expect(Object.isFrozen(result.package)).toBe(true);
  });

  it("rejects an incomplete or unsafe delivery package", () => {
    const missing = structuredClone(input()) as any;
    missing.rollback.instructions = "";
    expect(() => createWardenDraftPrPackage(missing)).toThrow("rollback.instructions");

    const unsafe = structuredClone(input()) as any;
    unsafe.delivery.autoDeploy = true;
    expect(() => createWardenDraftPrPackage(unsafe)).toThrow("automatic deployment is forbidden");
  });
});
