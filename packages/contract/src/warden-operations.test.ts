import { describe, expect, it } from "vitest";
import {
  assertStructuredPrPackageV1,
  canonicalStructuredPrPackageDigest,
  createStructuredPrPackageV1,
  validateStructuredPrPackageV1,
  verifyStructuredPrPackageV1,
  type StructuredPrPackageV1Input,
} from "./warden-operations.js";

const TENANT = "tenant-a";
const SHA = "a".repeat(40);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function validInput(): StructuredPrPackageV1Input {
  return {
    packageId: "package-1",
    tenantId: TENANT,
    pullRequestId: "pr-1",
    createdAt: "2026-08-01T18:30:00.000Z",
    source: {
      artifacts: [
        { tenantId: TENANT, id: "source-from" },
        { tenantId: TENANT, id: "source-to" },
      ],
    },
    snapshot: {
      tenantId: TENANT,
      snapshotId: "snapshot-1",
      repositoryId: "repository-1",
      resolvedSha: SHA,
      manifestSha256: DIGEST_A,
    },
    findings: [
      {
        tenantId: TENANT,
        findingId: "finding-1",
        evidenceArtifactIds: ["finding-evidence-2", "finding-evidence-1"],
      },
      {
        tenantId: TENANT,
        findingId: "finding-2",
        evidenceArtifactIds: ["finding-evidence-3"],
      },
    ],
    candidate: {
      tenantId: TENANT,
      artifactId: "candidate-1",
      sha256: DIGEST_B,
      predecessorArtifactId: null,
      edits: [
        { editId: "edit-2", path: "src/two.ts", findingIds: ["finding-2"] },
        { editId: "edit-1", path: "src/one.ts", findingIds: ["finding-2", "finding-1"] },
      ],
    },
    verification: {
      tenantId: TENANT,
      artifactIds: ["verification-post", "verification-baseline"],
      evidenceRecordIds: ["evidence-post", "evidence-rollback"],
      verdict: "passed",
      waiverArtifactId: null,
    },
    generation: {
      kind: "recipe",
      executorId: "payments-field-rename",
      version: "1.0.0",
    },
    policy: {
      tenantId: TENANT,
      artifactId: "policy-result-1",
      policyId: "tenant-policy-1",
      version: "4",
      decision: "allow",
    },
    ownership: {
      tenantId: TENANT,
      codeownersArtifactId: "codeowners-1",
      ownerPrincipalIds: ["principal-owner-2", "principal-owner-1"],
    },
    review: {
      tenantId: TENANT,
      requirementsArtifactId: "review-requirements-1",
      requiredReviewerCount: 1,
      reviewerPrincipalIds: ["principal-reviewer-2", "principal-reviewer-1"],
    },
    rollback: {
      tenantId: TENANT,
      artifactId: "rollback-plan-1",
      strategy: "restore_snapshot",
      verificationEvidenceRecordIds: ["evidence-rollback"],
    },
  };
}

describe("StructuredPrPackageV1", () => {
  it("creates a complete immutable package with a valid canonical digest", () => {
    const result = createStructuredPrPackageV1(validInput());

    expect(result).toMatchObject({
      schemaVersion: 1,
      packageId: "package-1",
      tenantId: TENANT,
      snapshot: { snapshotId: "snapshot-1", resolvedSha: SHA },
      verification: { verdict: "passed" },
      integrity: { algorithm: "sha256", digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(verifyStructuredPrPackageV1(result)).toBe(true);
    expect(validateStructuredPrPackageV1(result)).toEqual([]);
    expect(() => assertStructuredPrPackageV1(result)).not.toThrow();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidate.edits)).toBe(true);
  });

  it("produces the same digest for equivalent object and link ordering", () => {
    const first = validInput();
    const second = structuredClone(first) as StructuredPrPackageV1Input;
    const reordered = {
      rollback: {
        ...second.rollback,
        verificationEvidenceRecordIds: [...second.rollback.verificationEvidenceRecordIds].reverse(),
      },
      review: {
        ...second.review,
        reviewerPrincipalIds: [...second.review.reviewerPrincipalIds].reverse(),
      },
      ownership: {
        ...second.ownership,
        ownerPrincipalIds: [...second.ownership.ownerPrincipalIds].reverse(),
      },
      policy: second.policy,
      generation: second.generation,
      verification: {
        ...second.verification,
        artifactIds: [...second.verification.artifactIds].reverse(),
        evidenceRecordIds: [...second.verification.evidenceRecordIds].reverse(),
      },
      candidate: {
        ...second.candidate,
        edits: [...second.candidate.edits]
          .reverse()
          .map((edit) => ({ ...edit, findingIds: [...edit.findingIds].reverse() })),
      },
      findings: [...second.findings]
        .reverse()
        .map((finding) => ({
          ...finding,
          evidenceArtifactIds: [...finding.evidenceArtifactIds].reverse(),
        })),
      snapshot: second.snapshot,
      source: { artifacts: [...second.source.artifacts].reverse() },
      createdAt: second.createdAt,
      pullRequestId: second.pullRequestId,
      tenantId: second.tenantId,
      packageId: second.packageId,
    } satisfies StructuredPrPackageV1Input;

    expect(canonicalStructuredPrPackageDigest(first)).toBe(
      canonicalStructuredPrPackageDigest(reordered),
    );
    expect(createStructuredPrPackageV1(first).integrity.digest).toBe(
      createStructuredPrPackageV1(reordered).integrity.digest,
    );
  });

  it.each([
    "source",
    "snapshot",
    "findings",
    "candidate",
    "verification",
    "generation",
    "policy",
    "ownership",
    "review",
    "rollback",
  ] as const)("rejects a package missing its %s link", (field) => {
    const incomplete = structuredClone(validInput()) as Record<string, unknown>;
    delete incomplete[field];
    expect(() => createStructuredPrPackageV1(incomplete as StructuredPrPackageV1Input)).toThrowError(
      expect.objectContaining({ name: "StructuredPrPackageValidationError" }),
    );
  });

  it.each([
    ["source", (input: any) => (input.source.artifacts[0].tenantId = "tenant-b")],
    ["snapshot", (input: any) => (input.snapshot.tenantId = "tenant-b")],
    ["finding", (input: any) => (input.findings[0].tenantId = "tenant-b")],
    ["candidate", (input: any) => (input.candidate.tenantId = "tenant-b")],
    ["verification", (input: any) => (input.verification.tenantId = "tenant-b")],
    ["policy", (input: any) => (input.policy.tenantId = "tenant-b")],
    ["ownership", (input: any) => (input.ownership.tenantId = "tenant-b")],
    ["review", (input: any) => (input.review.tenantId = "tenant-b")],
    ["rollback", (input: any) => (input.rollback.tenantId = "tenant-b")],
  ])("rejects a cross tenant %s link", (_name, mutate) => {
    const invalid = structuredClone(validInput());
    mutate(invalid);
    expect(() => createStructuredPrPackageV1(invalid)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "TENANT_MISMATCH" })]),
      }),
    );
  });

  it("rejects missing candidate and rollback cross links", () => {
    const missingFinding = structuredClone(validInput()) as any;
    missingFinding.candidate.edits[0].findingIds = ["finding-not-declared"];
    expect(() => createStructuredPrPackageV1(missingFinding)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "CROSS_LINK_MISSING" })]),
      }),
    );

    const missingVerification = structuredClone(validInput()) as any;
    missingVerification.rollback.verificationEvidenceRecordIds = ["evidence-not-declared"];
    expect(() => createStructuredPrPackageV1(missingVerification)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "CROSS_LINK_MISSING" })]),
      }),
    );
  });

  it("requires a waiver artifact only for a waived verification verdict", () => {
    const missingWaiver = structuredClone(validInput()) as any;
    missingWaiver.verification.verdict = "waived";
    expect(() => createStructuredPrPackageV1(missingWaiver)).toThrowError(
      expect.objectContaining({ name: "StructuredPrPackageValidationError" }),
    );

    missingWaiver.verification.waiverArtifactId = "waiver-1";
    expect(() => createStructuredPrPackageV1(missingWaiver)).not.toThrow();
  });

  it("rejects duplicate links, unknown fields, and incomplete reviewer requirements", () => {
    const duplicate = structuredClone(validInput()) as any;
    duplicate.source.artifacts.push(duplicate.source.artifacts[0]);
    expect(() => createStructuredPrPackageV1(duplicate)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "DUPLICATE_LINK" })]),
      }),
    );

    const unknown = structuredClone(validInput()) as any;
    unknown.policy.bypass = true;
    expect(() => createStructuredPrPackageV1(unknown)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "UNKNOWN_FIELD" })]),
      }),
    );

    const reviewers = structuredClone(validInput()) as any;
    reviewers.review.requiredReviewerCount = 3;
    expect(() => createStructuredPrPackageV1(reviewers)).toThrowError(
      expect.objectContaining({ name: "StructuredPrPackageValidationError" }),
    );
  });

  it("detects payload and integrity tampering", () => {
    const valid = createStructuredPrPackageV1(validInput());
    const changedCandidate = structuredClone(valid) as any;
    changedCandidate.candidate.edits[0].path = "src/attacker.ts";
    expect(verifyStructuredPrPackageV1(changedCandidate)).toBe(false);
    expect(validateStructuredPrPackageV1(changedCandidate)).toContainEqual(
      expect.objectContaining({ code: "INTEGRITY_INVALID", path: "integrity.digest" }),
    );

    const changedDigest = structuredClone(valid) as any;
    changedDigest.integrity.digest = "0".repeat(64);
    expect(() => assertStructuredPrPackageV1(changedDigest)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: "INTEGRITY_INVALID" })]),
      }),
    );
  });
});
