import { describe, expect, it } from "vitest";
import {
  validateCaseCatalog,
  validateExecutionReceipt,
  validateRepositoryProvenance,
  validateStagedControlArm,
  type LearningCase,
  type ProductionExecutionReceipt,
  type RepositoryProvenance,
} from "./schema.js";

const SHA = "a".repeat(64);
const REVISION = "b".repeat(40);

function makeCase(
  product: "fettler" | "regauge",
  cohort: "common" | "edge",
  ordinal: number,
): LearningCase {
  const prefix = product === "fettler" ? "FET" : "REG";
  const cohortCode = cohort === "common" ? "C" : "E";
  const id = `${prefix}-${cohortCode}${String(ordinal).padStart(3, "0")}`;
  return {
    schemaVersion: "mendpoint.learning-case.v1",
    id,
    product,
    cohort,
    datasetSplit: ordinal % 5 === 0 ? "holdout" : "development",
    title: `${product} ${cohort} case ${ordinal}`,
    importance: {
      statement: "An official migration guide documents this change pattern.",
      frequencyClaim: "not_claimed",
      sourceIds: [`source-${id}`],
    },
    sources: [
      {
        id: `source-${id}`,
        kind: "official_migration_guide",
        title: "Official migration guide",
        publisher: "Example upstream",
        url: `https://example.invalid/guides/${id}`,
        retrievedAt: "2026-08-28T23:00:00.000Z",
      },
    ],
    repository: {
      provenanceId: "repo-example",
      languages: ["typescript"],
      frameworks: ["node"],
      binding: {
        mode: "native",
        originalResearchCandidate: "repo-example",
        rationale: "The fixture directly exercises the documented repository capability.",
      },
    },
    pattern: {
      family: product === "fettler" ? "api-contract-change" : "runtime-upgrade",
      seededFailure: "A deterministic fixture exposes the target behavior.",
      expectedImpactGraph: ["provider", "client", "caller", "test"],
      evidenceState: "verified",
    },
    expected: {
      diagnosis: "Identify the exact affected surface and preserve unknown evidence.",
      repairOrMigration: "Apply the bounded change inside the allowed edit boundary.",
      oracleIds: [`oracle-${id}`],
      productionAcceptance: [
        "The deterministic oracle passes.",
        "No path outside the allowed edit boundary changes.",
      ],
    },
    fixture: {
      manifestId: `fixture-${id}`,
      mutationId: `mutation-${id}`,
      allowedEditPaths: ["src/**", "test/**"],
      rollbackId: `rollback-${id}`,
      cleanupId: `cleanup-${id}`,
    },
    security: {
      tenantRisk: "bounded",
      risks: ["untrusted_repository_content"],
      requiresDedicatedBenchmarkTenant: true,
    },
    planning: { requirementIds: ["REQ-EVAL-CATALOG"] },
  };
}

function fullCatalog(): LearningCase[] {
  return [
    ...Array.from({ length: 50 }, (_, index) => makeCase("fettler", "common", index + 1)),
    ...Array.from({ length: 25 }, (_, index) => makeCase("fettler", "edge", index + 1)),
    ...Array.from({ length: 50 }, (_, index) => makeCase("regauge", "common", index + 1)),
    ...Array.from({ length: 25 }, (_, index) => makeCase("regauge", "edge", index + 1)),
  ];
}

function repository(): RepositoryProvenance {
  return {
    schemaVersion: "mendpoint.repository-provenance.v1",
    id: "repo-example",
    repositoryUrl: "https://github.com/example/project.git",
    immutableCommit: REVISION,
    license: {
      spdxId: "MIT",
      sourceUrl: "https://github.com/example/project/blob/main/LICENSE",
      textSha256: SHA,
      decision: "approved",
      decidedAt: "2026-08-28T23:00:00.000Z",
      intendedUses: ["evaluation", "governed_learning"],
    },
    languages: ["typescript"],
    frameworks: ["node"],
    dependencyLockfiles: ["package-lock.json"],
    provenanceRetrievedAt: "2026-08-28T23:00:00.000Z",
    dataClassification: "public_source_code",
    contentScreening: {
      secrets: "not_detected",
      personalData: "not_detected",
      generatedCredentials: "not_detected",
      customerData: "not_present",
    },
  };
}

function receipt(): ProductionExecutionReceipt {
  return {
    schemaVersion: "mendpoint.production-learning-receipt.v1",
    caseId: "FET-C001",
    product: "fettler",
    productionRevision: REVISION,
    tenantId: "benchmark-tenant-a",
    repositoryId: "repo-example",
    repositoryCommit: REVISION,
    snapshotDigest: SHA,
    fixtureManifestDigest: SHA,
    graphVersion: "graph-v1",
    policyVersion: "policy-v1",
    model: { provider: "configured", modelId: "model-v1", requestId: "request-1" },
    routerVersion: "router-v1",
    recipeVersion: null,
    consent: {
      decision: "granted",
      purpose: "evaluation",
      evidenceRef: "consent://benchmark-tenant-a/evaluation/v1",
    },
    authorizationRef: "authorization://benchmark-tenant-a/run-1",
    sandbox: {
      kind: "dedicated_benchmark",
      receiptDigest: SHA,
      defaultDenyEgress: true,
    },
    executionDigest: SHA,
    budget: { maximumUsd: 1, maximumLatencyMs: 60_000, maximumAttempts: 1 },
    delivery: {
      mode: "draft_pr_only",
      mergeAllowed: false,
      deploymentAllowed: false,
      openDraftCountForCase: 0,
    },
    advisoryVerifier: {
      name: "deepseek",
      advisoryOnly: true,
      maySelectCandidate: false,
      mayMutateExecution: false,
      mayDeliver: false,
      mayMerge: false,
      mayDeploy: false,
    },
    evidence: {
      diagnosis: "verified",
      repairOrMigration: "unknown",
      verification: "unknown",
      rollback: "unknown",
      production: "unknown",
    },
  };
}

describe("production learning case catalog", () => {
  it("accepts exactly 50 common and 25 edge cases for each product", () => {
    expect(validateCaseCatalog(fullCatalog())).toEqual([]);
  });

  it("rejects an incomplete 149 case catalog instead of treating it as partial success", () => {
    expect(validateCaseCatalog(fullCatalog().slice(0, -1))).toContain(
      "regauge edge count must be exactly 25; received 24",
    );
  });

  it("rejects duplicate case ids even when all cohort counts still add to 150", () => {
    const cases = fullCatalog();
    cases[1] = { ...cases[1]!, id: cases[0]!.id };
    expect(validateCaseCatalog(cases)).toContain("duplicate case id: FET-C001");
  });

  it("requires every importance rationale to cite a primary source without inventing frequency", () => {
    const cases = fullCatalog();
    cases[0] = {
      ...cases[0]!,
      importance: { statement: "Popular migration", frequencyClaim: "high", sourceIds: [] },
    } as unknown as LearningCase;
    expect(validateCaseCatalog(cases)).toEqual(
      expect.arrayContaining([
        "FET-C001 importance.sourceIds must contain at least one source id",
        "FET-C001 importance.frequencyClaim must be not_claimed or source_supported",
      ]),
    );
  });

  it("keeps unknown distinct from verified absence", () => {
    const run = receipt();
    expect(run.evidence.repairOrMigration).toBe("unknown");
    expect(run.evidence.repairOrMigration).not.toBe("verified_absent");
    expect(validateExecutionReceipt(run)).toEqual([]);
  });
});

describe("repository license and provenance", () => {
  it("accepts an immutable permissive repository with screened public data", () => {
    expect(validateRepositoryProvenance(repository())).toEqual([]);
  });

  it("fails closed on a missing commit, license digest, or learning-use decision", () => {
    const value = repository();
    value.immutableCommit = "main";
    value.license.textSha256 = "";
    value.license.intendedUses = ["evaluation"];
    expect(validateRepositoryProvenance(value)).toEqual(
      expect.arrayContaining([
        "immutableCommit must be a 40 character lowercase git sha",
        "license.textSha256 must be a 64 character lowercase sha256",
        "license intendedUses must explicitly include governed_learning",
      ]),
    );
  });

  it("rejects repositories with detected secrets or unknown customer data", () => {
    const value = repository();
    value.contentScreening.secrets = "detected";
    value.contentScreening.customerData = "unknown";
    expect(validateRepositoryProvenance(value)).toEqual(
      expect.arrayContaining([
        "content screening must not report detected secrets",
        "content screening must prove customer data is not present",
      ]),
    );
  });
});

describe("sealed controls and production receipts", () => {
  it("rejects a modeled control arm that receives expected diagnosis or answer key material", () => {
    expect(
      validateStagedControlArm({
        caseId: "FET-C001",
        repositoryPath: "C:/bench/repo",
        inputArtifactRefs: ["snapshot://a"],
        expectedOutcome: "rename the field",
        answerKeyRefs: ["sealed://FET-C001"],
      }),
    ).toEqual(
      expect.arrayContaining([
        "modeled control arm must not contain expectedOutcome",
        "modeled control arm must not contain answerKeyRefs",
      ]),
    );
  });

  it("requires every production authority binding before execution", () => {
    const value = receipt();
    value.graphVersion = "";
    value.authorizationRef = "";
    value.sandbox.receiptDigest = "";
    expect(validateExecutionReceipt(value)).toEqual(
      expect.arrayContaining([
        "graphVersion must be a non-empty string",
        "authorizationRef must be a non-empty string",
        "sandbox.receiptDigest must be a 64 character lowercase sha256",
      ]),
    );
  });

  it("requires sandbox default-deny egress to be the exact boolean true", () => {
    const value = receipt();
    (value.sandbox as unknown as { defaultDenyEgress: unknown }).defaultDenyEgress = "false";
    expect(validateExecutionReceipt(value)).toContain("sandbox defaultDenyEgress must be exactly true");
  });

  it("rejects merge, deployment, second-draft, or advisory-verifier authority", () => {
    const value = receipt();
    value.delivery.mergeAllowed = true;
    value.delivery.deploymentAllowed = true;
    value.delivery.openDraftCountForCase = 1;
    value.advisoryVerifier.maySelectCandidate = true;
    expect(validateExecutionReceipt(value)).toEqual(
      expect.arrayContaining([
        "delivery mergeAllowed must be exactly false",
        "delivery deploymentAllowed must be exactly false",
        "delivery openDraftCountForCase must be 0 before delivery",
        "advisory verifier maySelectCandidate must be exactly false",
      ]),
    );
  });

  it("rejects omitted denial fields and empty advisory or recipe identity", () => {
    const value = receipt() as unknown as Record<string, unknown>;
    const delivery = value.delivery as Record<string, unknown>;
    const advisory = value.advisoryVerifier as Record<string, unknown>;
    delete delivery.mergeAllowed;
    delete advisory.mayDeliver;
    advisory.name = "";
    value.recipeVersion = "";
    expect(validateExecutionReceipt(value as unknown as ProductionExecutionReceipt)).toEqual(expect.arrayContaining([
      "delivery mergeAllowed must be exactly false",
      "advisory verifier mayDeliver must be exactly false",
      "advisoryVerifier.name must be a non-empty string",
      "recipeVersion must be a non-empty string",
    ]));
  });
});
