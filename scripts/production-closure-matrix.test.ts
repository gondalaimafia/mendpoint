import { readFileSync } from "node:fs";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProductRequirementManifest } from "@mendpoint/contract";
import {
  releaseTrainObservationIssues,
  parseProductionEvidenceTrustRoots,
  validateProductionClosureMatrix,
  type ProductionClosureMatrix,
  type ProductionClosureValidationOptions,
} from "./production-closure-matrix.js";

const root = resolve(import.meta.dirname, "..");

function loadManifest(): ProductRequirementManifest {
  return JSON.parse(
    readFileSync(resolve(root, "docs", "PRODUCT_REQUIREMENTS.json"), "utf8"),
  ) as ProductRequirementManifest;
}

function loadMatrix(): ProductionClosureMatrix {
  return JSON.parse(
    readFileSync(resolve(root, "docs", "PRODUCTION_CLOSURE_MATRIX.json"), "utf8"),
  ) as ProductionClosureMatrix;
}

function ensureBootstrap(matrix: ProductionClosureMatrix) {
  matrix.releaseTrain.currentPullRequestBootstrap ??= {
    observationSource: "github_api",
    number: 999,
    url: "https://github.com/gondalaimafia/mendpoint/pull/999",
    title: "Test production closure bootstrap",
    baseBranch: "main",
    headBranch: "codex/test-production-closure-bootstrap",
    owner: { actor: "Codex", source: "github_label", label: "release-owner:codex" },
    disposition: "merge_after_rebase_and_review",
    dependencies: { pullRequests: [], branches: [] },
    requirementIds: [],
    blockers: [],
    remediatesPullRequests: [],
  };
  return matrix.releaseTrain.currentPullRequestBootstrap;
}

function codes(
  manifest: ProductRequirementManifest,
  matrix: ProductionClosureMatrix,
  options: ProductionClosureValidationOptions = {},
): string[] {
  return validateProductionClosureMatrix(manifest, matrix, options).map((issue) => issue.code);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function promoteFirstRequirementToGa() {
  const manifest = loadManifest();
  const matrix = loadMatrix();
  const requirement = manifest.requirements[0];
  const liveEvidence = {
    id: `${requirement.acceptance[0].id}-EV99`,
    type: "live" as const,
    locator: "https://mendpoint.example.test/healthz",
  };
  requirement.implementationStatus = "verified";
  requirement.availability = "ga";
  requirement.acceptance[0].evidence = [liveEvidence];
  matrix.requirements[0].status = {
    implementationStatus: "verified",
    availability: "ga",
    claimState: requirement.claimState,
  };
  matrix.requirements[0].testEvidenceIds = [];
  matrix.requirements[0].productionEvidenceIds = [liveEvidence.id];
  return { manifest, matrix, liveEvidence };
}

function attachSignedGaReceipt(
  matrix: ProductionClosureMatrix,
  liveEvidence: { id: string; locator: string },
) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  matrix.productionEvidenceAuthority = {
    authorityId: "production-evidence-authority",
    authorityKeyId: digest(publicKeyPem),
  };
  const trustRoot = {
    authorityId: "production-evidence-authority",
    authorityKeyId: digest(publicKeyPem),
    publicKeyPem,
  };
  const artifact = (name: string) => ({
    locator: `docs/evidence/${name}.json`,
    digest: `sha256:${"1".repeat(64)}`,
  });
  const receipt = {
    schemaVersion: 1 as const,
    evidenceId: liveEvidence.id,
    locator: liveEvidence.locator,
    observedAt: "2026-08-25T00:00:00.000Z",
    freshUntil: "2026-09-01T00:00:00.000Z",
    deployedRevision: "a".repeat(40),
    versionLocator: "https://mendpoint.example.test/version",
    versionObservedRevision: "a".repeat(40),
    authorityId: "production-evidence-authority",
    authorityKeyId: digest(publicKeyPem),
    observationEvidence: artifact("observation"),
    versionEvidence: artifact("version"),
    rollbackEvidence: artifact("rollback"),
    failureEvidence: artifact("failure"),
  };
  const receiptBytes = JSON.stringify(canonical(receipt));
  matrix.requirements[0].productionEvidenceBindings = [
    {
      evidenceId: liveEvidence.id,
      receipt,
      receiptDigest: digest(receiptBytes),
      signature: sign(null, Buffer.from(receiptBytes), privateKey).toString("base64"),
    },
  ];
  return { receipt, trustRoot };
}

describe("production closure matrix", () => {
  it("loads production evidence trust roots only when the supplied key digest matches", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const root = {
      authorityId: "production-evidence-authority",
      authorityKeyId: digest(publicKeyPem),
      publicKeyPem,
    };

    expect(parseProductionEvidenceTrustRoots(JSON.stringify([root]))).toEqual([root]);
    expect(() =>
      parseProductionEvidenceTrustRoots(
        JSON.stringify([{ ...root, authorityKeyId: `sha256:${"0".repeat(64)}` }]),
      ),
    ).toThrow("production_evidence_trust_root_invalid");
  });

  it("covers every requirement across every canonical register set", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    const requirementCount =
      manifest.requirements.length +
      (manifest.additionalRegisterSets ?? []).reduce(
        (total, set) => total + set.requirements.length,
        0,
      );

    // The invariant is that the matrix and the canonical register agree with
    // each other, not that either equals a fixed number. Pinning a magic count
    // would turn the first legitimate new requirement into a red ga:check for
    // every other open PR; the validator's REQUIREMENT_MISSING /
    // REQUIREMENT_UNKNOWN rules are what actually detect drift, and asserting
    // the validator returns no issues confirms they see none here.
    expect(requirementCount).toBeGreaterThan(0);
    expect(matrix.requirements).toHaveLength(requirementCount);
    expect(validateProductionClosureMatrix(manifest, matrix)).toEqual([]);
  });

  it("fails when a registered requirement is missing", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    matrix.requirements.pop();

    expect(codes(manifest, matrix)).toContain("REQUIREMENT_MISSING");
  });

  it("fails when a matrix status drifts from the canonical register", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    matrix.requirements[0].status.implementationStatus = "verified";

    expect(codes(manifest, matrix)).toContain("STATUS_DRIFT");
  });

  it("fails unknown requirement links and malformed pull request references", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    matrix.releaseTrain.pullRequests[0].requirementIds.push("ME-UNKNOWN-999");
    matrix.requirements[0].pullRequests.push(0);

    expect(codes(manifest, matrix)).toEqual(
      expect.arrayContaining(["UNKNOWN_REQUIREMENT_REFERENCE", "PR_REFERENCE"]),
    );
  });

  it("fails GA promotion without canonical live evidence", () => {
    // The "verified needs code-verifiable evidence" case is covered upstream by
    // the contract's stricter VERIFIED_WITHOUT_CODE_EVIDENCE rule (spec:check);
    // the redundant closure-side check was removed, so it is not asserted here.
    const gaManifest = loadManifest();
    const gaMatrix = loadMatrix();
    const gaRequirement = gaManifest.requirements[0];
    gaRequirement.implementationStatus = "verified";
    gaRequirement.availability = "ga";
    gaRequirement.acceptance[0].evidence = [
      {
        id: `${gaRequirement.acceptance[0].id}-EV99`,
        type: "unit",
        locator: "packages/contract/src/product-requirements.test.ts",
      },
    ];
    gaMatrix.requirements[0].status = {
      implementationStatus: "verified",
      availability: "ga",
      claimState: gaRequirement.claimState,
    };

    expect(codes(gaManifest, gaMatrix)).toContain(
      "GA_PRODUCTION_EVIDENCE_REQUIRED",
    );
  });

  it("fails GA promotion when live evidence is not bound to the deployed revision", () => {
    const { manifest, matrix } = promoteFirstRequirementToGa();

    expect(codes(manifest, matrix)).toContain("GA_LIVE_EVIDENCE_BINDING_REQUIRED");
  });

  it("rejects a syntactically shaped but unsigned fabricated GA receipt", () => {
    const { manifest, matrix, liveEvidence } = promoteFirstRequirementToGa();
    matrix.requirements[0].productionEvidenceBindings = [
      {
        evidenceId: liveEvidence.id,
        receipt: {
          schemaVersion: 1,
          evidenceId: liveEvidence.id,
          locator: liveEvidence.locator,
          observedAt: "2026-08-25T00:00:00.000Z",
          freshUntil: "2999-01-01T00:00:00.000Z",
          deployedRevision: "f".repeat(40),
          versionLocator: "https://mendpoint.example.test/version",
          versionObservedRevision: "f".repeat(40),
          authorityId: "self",
          authorityKeyId: `sha256:${"0".repeat(64)}`,
          observationEvidence: {
            locator: "docs/evidence/fabricated-observation.json",
            digest: `sha256:${"0".repeat(64)}`,
          },
          versionEvidence: {
            locator: "docs/evidence/fabricated-version.json",
            digest: `sha256:${"0".repeat(64)}`,
          },
          rollbackEvidence: {
            locator: "docs/evidence/fabricated-rollback.json",
            digest: `sha256:${"0".repeat(64)}`,
          },
          failureEvidence: {
            locator: "docs/evidence/fabricated-failure.json",
            digest: `sha256:${"0".repeat(64)}`,
          },
        },
        receiptDigest: `sha256:${"0".repeat(64)}`,
        signature: Buffer.from("fabricated").toString("base64"),
      },
    ];

    expect(codes(manifest, matrix)).toContain("GA_LIVE_EVIDENCE_BINDING_INVALID");
  });

  it("accepts a canonical signed GA receipt before live artifact verification", () => {
    const { manifest, matrix, liveEvidence } = promoteFirstRequirementToGa();
    const { trustRoot } = attachSignedGaReceipt(matrix, liveEvidence);

    expect(codes(manifest, matrix, { trustedProductionEvidenceAuthorities: [trustRoot] })).not.toEqual(
      expect.arrayContaining([
        "GA_LIVE_EVIDENCE_BINDING_REQUIRED",
        "GA_LIVE_EVIDENCE_BINDING_INVALID",
      ]),
    );
  });

  it("rejects a valid receipt when its signing key is not independently trusted", () => {
    const { manifest, matrix, liveEvidence } = promoteFirstRequirementToGa();
    attachSignedGaReceipt(matrix, liveEvidence);

    expect(codes(manifest, matrix)).toContain("GA_LIVE_EVIDENCE_BINDING_INVALID");
  });

  it("rejects a signed GA receipt whose revision and artifacts cannot be reached", () => {
    const { matrix, liveEvidence } = promoteFirstRequirementToGa();
    attachSignedGaReceipt(matrix, liveEvidence);
    const observationCodes = releaseTrainObservationIssues(matrix, {
      revisionExists: (revision) => revision !== "a".repeat(40),
      readArtifact: () => null,
      now: new Date("2026-08-25T12:00:00.000Z"),
    }).map((issue) => issue.code);

    expect(observationCodes).toEqual(
      expect.arrayContaining([
        "GA_DEPLOYED_REVISION_UNREACHABLE",
        "GA_EVIDENCE_ARTIFACT_UNREACHABLE",
      ]),
    );
  });

  it("fails green checks without an attributable review of the exact head", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    const pullRequest = matrix.releaseTrain.pullRequests[0];
    pullRequest.checkState = "current_checks_green";
    pullRequest.headRevision = "a".repeat(40);
    pullRequest.review = {
      state: "approved",
      reviewedHeadRevision: "b".repeat(40),
      reviewer: "claude-session",
      reviewerAgent: "Codex",
      source: "codex_review",
      reviewId: "review-1",
      url: "https://github.com/gondalaimafia/mendpoint/pull/284#issuecomment-1",
      submittedAt: "2026-08-25T00:00:00.000Z",
      attributable: true,
    };

    expect(codes(manifest, matrix)).toContain("PR_EXACT_REVIEW_REQUIRED");
  });

  it("fails a tracked pull request without an exact head revision", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    matrix.releaseTrain.pullRequests[0].headRevision = "";

    expect(codes(manifest, matrix)).toContain("PR_HEAD_REVISION_REQUIRED");
  });

  it("requires a provider-resolved bootstrap for the current pull request", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    matrix.releaseTrain.currentPullRequestBootstrap = undefined as never;

    expect(
      validateProductionClosureMatrix(manifest, matrix, {
        requireCurrentPullRequestBootstrap: true,
      }).map((issue) => issue.code),
    ).toContain("CURRENT_PR_BOOTSTRAP_INVALID");
  });

  it("blocks a current pull request that retains any unresolved finding", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    ensureBootstrap(matrix).blockers = [
      { priority: "P1", summary: "trusted review is incomplete" },
    ];

    expect(codes(manifest, matrix)).toContain("CURRENT_PR_BLOCKED");
  });

  it("requires a materially unreviewed merge to link its provider-verified remediation", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    const pullRequest = matrix.releaseTrain.pullRequests.find(
      (candidate) => candidate.number === 416,
    )!;
    pullRequest.reviewRemediationPullRequest = null;

    expect(codes(manifest, matrix)).toContain("PR_MERGED_REVIEW_REQUIRED");
  });

  it("fails an unfinished requirement without an issue or pull request", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    const unfinishedIndex = matrix.requirements.findIndex(
      (row) => !["verified", "retired"].includes(row.status.implementationStatus),
    );
    expect(unfinishedIndex).toBeGreaterThanOrEqual(0);
    matrix.requirements[unfinishedIndex].issues = [];
    matrix.requirements[unfinishedIndex].pullRequests = [];

    expect(codes(manifest, matrix)).toContain("REQUIREMENT_CLOSURE_PATH_REQUIRED");
  });

  it("fails a pull request whose state and disposition disagree", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    const pullRequest = matrix.releaseTrain.pullRequests[0];
    pullRequest.state = "merged";
    pullRequest.disposition = "merge_after_rebase_and_review";

    expect(codes(manifest, matrix)).toContain("PR_DISPOSITION_STATE");
  });

  it("fails an untracked or unsatisfied pull request dependency", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    matrix.releaseTrain.pullRequests[0].dependencies.pullRequests = [999_999];

    expect(codes(manifest, matrix)).toContain("PR_DEPENDENCY_UNTRACKED");
  });

  it("fails a green pull request that retains a blocking finding", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    const pullRequest = matrix.releaseTrain.pullRequests.find(
      (candidate) => candidate.checks.length >= 4,
    )!;
    pullRequest.checkState = "current_checks_green";
    pullRequest.blockers = [{ priority: "P1", summary: "unresolved" }];

    expect(codes(manifest, matrix)).toContain("PR_GREEN_WITH_BLOCKERS");
  });

  it("represents and blocks an unresolved P0", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    const pullRequest = matrix.releaseTrain.pullRequests.find(
      (candidate) => candidate.checks.length >= 4,
    )!;
    pullRequest.checkState = "current_checks_green";
    pullRequest.blockers = [{ priority: "P0", summary: "production data corruption" }];

    expect(codes(manifest, matrix)).toContain("PR_GREEN_WITH_BLOCKERS");
    expect(codes(manifest, matrix)).not.toContain("BLOCKER_FORMAT");
  });

  it("fails a positive issue number with no authoritative issue record", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    const unfinished = matrix.requirements.find(
      (row) => !["verified", "retired"].includes(row.status.implementationStatus),
    )!;
    unfinished.issues = [999_999_999];
    unfinished.pullRequests = [];

    expect(codes(manifest, matrix)).toContain("ISSUE_AUTHORITY_MISSING");
  });

  it("fails when the pull request snapshot is edited without resealing its integrity digest", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    matrix.releaseTrain.pullRequests[0].headRevision = "f".repeat(40);

    expect(codes(manifest, matrix)).toContain("RELEASE_INTEGRITY_INVALID");
  });

  it("fails when the issue snapshot is edited without resealing its integrity digest", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    matrix.issueAuthority.issues[0].owner = "fabricated";

    expect(codes(manifest, matrix)).toContain("ISSUE_INTEGRITY_INVALID");
  });

  it("accepts a fresh, reachable live observation", () => {
    const matrix = loadMatrix();
    expect(
      releaseTrainObservationIssues(matrix, {
        revisionExists: () => true,
        now: new Date(matrix.releaseTrain.observedAt),
      }),
    ).toEqual([]);
  });

  it("rejects an observedMainRevision that is not a commit", () => {
    const matrix = loadMatrix();
    matrix.releaseTrain.observedMainRevision =
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const codes = releaseTrainObservationIssues(matrix, {
      revisionExists: () => false,
      now: new Date(matrix.releaseTrain.observedAt),
    }).map((issue) => issue.code);

    expect(codes).toContain("RELEASE_REVISION_UNREACHABLE");
  });

  it("accepts a provider observation timestamp with whole-second precision", () => {
    const matrix = loadMatrix();
    matrix.releaseTrain.observedAt = "2026-08-20T00:00:00.000Z";
    const observationCodes = releaseTrainObservationIssues(matrix, {
      revisionExists: () => true,
      now: new Date(matrix.releaseTrain.observedAt),
    }).map((issue) => issue.code);

    expect(observationCodes).not.toContain("RELEASE_TIMESTAMP_BATCH_STAMP");
  });

  it("checks a squash-merged dependency by merge revision rather than PR head", () => {
    const matrix = loadMatrix();
    const dependency = matrix.releaseTrain.pullRequests.find(
      (pullRequest) => pullRequest.state === "merged" && pullRequest.mergeRevision,
    )!;
    const dependent = matrix.releaseTrain.pullRequests.find(
      (pullRequest) => pullRequest.state === "open" && pullRequest.number !== dependency.number,
    )!;
    dependent.checkState = "current_checks_green";
    dependent.dependencies.pullRequests = [dependency.number];
    const observedRevisions: string[] = [];

    releaseTrainObservationIssues(matrix, {
      revisionExists: () => true,
      revisionIsAncestor: (revision) => {
        observedRevisions.push(revision);
        return true;
      },
      now: new Date(matrix.releaseTrain.observedAt),
    });

    expect(observedRevisions).toContain(dependency.mergeRevision);
    expect(observedRevisions).not.toContain(dependency.headRevision);
  });

  it("rejects a live observation older than the staleness bound", () => {
    const matrix = loadMatrix();
    const observedMs = Date.parse(matrix.releaseTrain.observedAt);
    const codes = releaseTrainObservationIssues(matrix, {
      revisionExists: () => true,
      now: new Date(observedMs + 15 * 24 * 60 * 60 * 1000),
    }).map((issue) => issue.code);

    expect(codes).toContain("RELEASE_SNAPSHOT_STALE");
  });
});
