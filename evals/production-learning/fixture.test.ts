import { describe, expect, it } from "vitest";
import { admitFixture, fixtureManifestDigest, requireAdmittedFixture, type AdmittedFixture, type FixtureManifest } from "./fixture.js";
import {
  PREFLIGHT_AUTHORITY_ENVELOPE,
  PREFLIGHT_EXPIRED_AUTHORITY_ENVELOPE,
  PREFLIGHT_MISMATCH_AUTHORITY_ENVELOPE,
  installTestAuthorityTrustRoots,
} from "./authority-fixtures.test-support.js";
import {
  evaluateProductionLearningPreflight,
  verifyProductionLearningAuthority,
  type ProductionLearningAuthorityPayload,
  type VerifiedProductionLearningAuthority,
} from "./preflight.js";
import type { LearningCase, ProductionExecutionReceipt, RepositoryProvenance } from "./schema.js";

const SHA = "a".repeat(64);
const REVISION = "b".repeat(40);
installTestAuthorityTrustRoots();
process.env.MENDPOINT_PRODUCTION_REVISION = REVISION;

const learningCase: LearningCase = {
  schemaVersion: "mendpoint.learning-case.v1",
  id: "FET-E001",
  product: "fettler",
  cohort: "edge",
  datasetSplit: "holdout",
  title: "Unknown impact under conflicting evidence",
  importance: { statement: "Official evidence defines fail closed behavior.", frequencyClaim: "not_claimed", sourceIds: ["s1"] },
  sources: [{ id: "s1", kind: "official_documentation", title: "Evidence", publisher: "Upstream", url: "https://example.invalid/evidence", retrievedAt: "2026-08-28T23:00:00.000Z" }],
  repository: { provenanceId: "repo-a", languages: ["typescript"], frameworks: ["node"], binding: { mode: "native", originalResearchCandidate: "repo-a", rationale: "The fixture directly targets this repository." } },
  pattern: { family: "conflicting-evidence", seededFailure: "Two receipts bind different revisions.", expectedImpactGraph: ["provider", "client"], evidenceState: "unknown" },
  expected: { diagnosis: "Preserve unknown.", repairOrMigration: "Abstain pending a current binding.", oracleIds: ["oracle-FET-E001"], productionAcceptance: ["No draft is created."] },
  fixture: { manifestId: "fixture-FET-E001", mutationId: "mutation-FET-E001", allowedEditPaths: ["src/**"], rollbackId: "rollback-FET-E001", cleanupId: "cleanup-FET-E001" },
  security: { tenantRisk: "high", risks: ["stale_evidence"], requiresDedicatedBenchmarkTenant: true },
  planning: { requirementIds: ["REQ-EVAL-FIXTURE"] },
};

function repository(): RepositoryProvenance {
  return {
    schemaVersion: "mendpoint.repository-provenance.v1", id: "repo-a", repositoryUrl: "https://github.com/example/a.git", immutableCommit: REVISION,
    license: { spdxId: "MIT", sourceUrl: "https://github.com/example/a/blob/main/LICENSE", textSha256: SHA, decision: "approved", decidedAt: "2026-08-28T23:00:00.000Z", intendedUses: ["evaluation", "governed_learning"] },
    languages: ["typescript"], frameworks: ["node"], dependencyLockfiles: ["package-lock.json"], provenanceRetrievedAt: "2026-08-28T23:00:00.000Z", dataClassification: "public_source_code",
    contentScreening: { secrets: "not_detected", personalData: "not_detected", generatedCredentials: "not_detected", customerData: "not_present" },
  };
}

function fixture(): FixtureManifest {
  return {
    schemaVersion: "mendpoint.fixture-manifest.v1", manifestId: learningCase.fixture.manifestId, caseId: learningCase.id,
    repository: { provenanceId: "repo-a", immutableCommit: REVISION, pristineSnapshotSha256: SHA },
    mutation: { id: "mutation-FET-E001", kind: "patch", patchPath: "patches/FET-E001.patch", patchSha256: SHA, seededFailure: learningCase.pattern.seededFailure },
    expectedImpactGraph: { nodes: ["provider", "client"], edges: [], evidenceState: "unknown" },
    failingOracle: { id: "oracle-FET-E001", argv: ["npm", "test", "--", "conflicting-evidence"], expectedExitCode: 1, expectedOutputPattern: "conflicting revision" },
    allowedEditPaths: ["src/**"], expectedFixOrMigration: learningCase.expected.repairOrMigration,
    rollback: { id: "rollback-FET-E001", reversePatchSha256: SHA, oracleId: "oracle-FET-E001" },
    cleanup: { id: "cleanup-FET-E001", removePaths: [".mendpoint-fixture/**"], pristineTreeSha256: SHA },
  };
}

function receipt(value = fixture()): ProductionExecutionReceipt {
  return {
    schemaVersion: "mendpoint.production-learning-receipt.v1", caseId: learningCase.id, product: "fettler", productionRevision: REVISION, tenantId: "benchmark-tenant-a", repositoryId: "repo-a", repositoryCommit: REVISION, snapshotDigest: SHA,
    fixtureManifestDigest: fixtureManifestDigest(value),
    graphVersion: "graph-v1", policyVersion: "policy-v1", model: { provider: "configured", modelId: "model-v1", requestId: "request-1" }, routerVersion: "router-v1", recipeVersion: null,
    consent: { decision: "granted", purpose: "evaluation", evidenceRef: "consent://benchmark-tenant-a/evaluation/v1" }, authorizationRef: "authorization://benchmark-tenant-a/run-1",
    sandbox: { kind: "dedicated_benchmark", receiptDigest: SHA, defaultDenyEgress: true }, executionDigest: SHA,
    budget: { maximumUsd: 1, maximumLatencyMs: 60_000, maximumAttempts: 1 }, delivery: { mode: "draft_pr_only", mergeAllowed: false, deploymentAllowed: false, openDraftCountForCase: 0 },
    advisoryVerifier: { name: "deepseek", advisoryOnly: true, maySelectCandidate: false, mayMutateExecution: false, mayDeliver: false, mayMerge: false, mayDeploy: false },
    evidence: { diagnosis: "unknown", repairOrMigration: "unknown", verification: "unknown", rollback: "unknown", production: "unknown" },
  };
}

function authority(
  _run: ProductionExecutionReceipt,
  overrides: Partial<ProductionLearningAuthorityPayload> = {},
): VerifiedProductionLearningAuthority {
  const useMismatch = overrides.productionRevision === "c".repeat(40);
  process.env.MENDPOINT_PRODUCTION_REVISION = useMismatch ? "c".repeat(40) : REVISION;
  return verifyProductionLearningAuthority(useMismatch ? PREFLIGHT_MISMATCH_AUTHORITY_ENVELOPE : PREFLIGHT_AUTHORITY_ENVELOPE);
}

describe("fixture admission and production preflight", () => {
  it("admits a content addressed fixture and exact rollback contract", () => {
    const result = admitFixture(fixture(), learningCase, repository());
    expect(result.admitted).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.admission?.manifestDigest).toBe(fixtureManifestDigest(fixture()));
    expect(Object.isFrozen(result.admission?.manifest.allowedEditPaths)).toBe(true);
  });

  it("rejects inconclusive repository screening and forged admissions", () => {
    const candidate = repository();
    candidate.contentScreening.secrets = "unknown";
    const result = admitFixture(fixture(), learningCase, candidate);
    expect(result.admitted).toBe(false);
    expect(result.errors).toContain("content screening must not report detected secrets");
    expect(() => requireAdmittedFixture({ manifest: fixture() } as unknown as AdmittedFixture)).toThrow("fixture_admission_not_verified");
  });

  it("rejects path escape and missing immutable patch evidence", () => {
    const value = fixture();
    value.mutation.patchPath = "../outside.patch";
    value.mutation.patchSha256 = "unknown";
    const result = admitFixture(value, learningCase, repository());
    expect(result.admitted).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "mutation.patchPath must be a safe repository relative path",
      "mutation.patchSha256 must be a 64 character lowercase sha256",
    ]));
  });

  it("fails closed when any receipt binding points to a different snapshot or tenant", () => {
    const run = receipt();
    run.snapshotDigest = "c".repeat(64);
    run.tenantId = "customer-tenant-a";
    const result = evaluateProductionLearningPreflight({ learningCase, repository: repository(), fixture: fixture(), receipt: run, authority: authority(receipt()) });
    expect(result.allowed).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "receipt snapshotDigest must match fixture snapshot",
      "receipt tenantId must identify a dedicated benchmark tenant",
    ]));
  });

  it("allows preflight only after every binding validates", () => {
    const manifest = fixture();
    const run = receipt(manifest);
    const result = evaluateProductionLearningPreflight({ learningCase, repository: repository(), fixture: manifest, receipt: run, authority: authority(run) });
    expect(result.allowed).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails a later preflight when a verified production capability is no longer current", () => {
    const manifest = fixture();
    const run = receipt(manifest);
    const verified = authority(run);
    process.env.MENDPOINT_PRODUCTION_REVISION = "c".repeat(40);
    expect(evaluateProductionLearningPreflight({ learningCase, repository: repository(), fixture: manifest, receipt: run, authority: verified }).errors)
      .toContain("trusted production authority must be signature verified and current");
    process.env.MENDPOINT_PRODUCTION_REVISION = REVISION;
    process.env.MENDPOINT_PRODUCTION_LEARNING_MINIMUM_ISSUED_AT = "2026-01-02T00:00:00.000Z";
    expect(evaluateProductionLearningPreflight({ learningCase, repository: repository(), fixture: manifest, receipt: run, authority: verified }).errors)
      .toContain("trusted production authority must be signature verified and current");
    installTestAuthorityTrustRoots();
  });

  it("rejects a self-consistent receipt that does not match trusted deployed authority", () => {
    const manifest = fixture();
    const run = receipt(manifest);
    const trusted = authority(run, {
      productionRevision: "c".repeat(40),
      authorizationRef: "authorization://benchmark-tenant-a/protected-run",
    });
    const result = evaluateProductionLearningPreflight({ learningCase, repository: repository(), fixture: manifest, receipt: run, authority: trusted });
    expect(result.errors).toEqual(expect.arrayContaining([
      "receipt productionRevision must match trusted production authority",
      "receipt authorizationRef must match trusted production authority",
    ]));
  });

  it("rejects tampered or expired production authority envelopes before preflight", () => {
    const run = receipt();
    process.env.MENDPOINT_PRODUCTION_REVISION = run.productionRevision;
    expect(() => verifyProductionLearningAuthority(PREFLIGHT_EXPIRED_AUTHORITY_ENVELOPE)).toThrow("authority_time_window_invalid");
    const tampered = structuredClone(PREFLIGHT_AUTHORITY_ENVELOPE);
    tampered.payload.tenantId = "benchmark-tenant-tampered";
    expect(() => verifyProductionLearningAuthority(tampered)).toThrow("authority_signature_invalid");
    const foreign = structuredClone(PREFLIGHT_AUTHORITY_ENVELOPE);
    foreign.issuer = "caller-controlled-authority";
    expect(() => verifyProductionLearningAuthority(foreign)).toThrow("authority_issuer_not_trusted");
  });

  it("binds manifest identity, impact graph, rollback oracle, and complete manifest digest", () => {
    const manifest = fixture();
    manifest.manifestId = "wrong-manifest";
    manifest.expectedImpactGraph.nodes = ["different"];
    manifest.rollback.oracleId = "different-oracle";
    const run = receipt(fixture());
    const result = evaluateProductionLearningPreflight({ learningCase, repository: repository(), fixture: manifest, receipt: run, authority: authority(run) });
    expect(result.errors).toEqual(expect.arrayContaining([
      "manifestId must match the learning case",
      "expectedImpactGraph nodes must match the learning case",
      "rollback oracleId must match the failing oracle",
      "receipt fixtureManifestDigest must match the complete fixture manifest",
    ]));
  });
});
