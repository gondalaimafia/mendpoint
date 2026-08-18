import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCompletionVerifierEvidencePack, filterDeterministicCandidates } from "./index.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe("product completion evidence", () => {
  it("creates a three criterion Fettler completion pack bound to deterministic evidence", () => {
    const pack = createCompletionVerifierEvidencePack({
      tenantId: "tenant_a", missionId: "mission_a", taskId: "task_a", product: "fettler", repositoryId: "repo_a", snapshotDigest: digest("snapshot"), objective: "Migrate the API call.", risk: "medium",
      governance: { dataClassification: "confidential", requiredRegion: "us", processingRegion: "us", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentId: "consent_a", consentActive: true },
      governanceEvidenceRef: "approval:external-verifier", allowedChangedPaths: ["src/api.ts"], candidateId: "candidate_a", candidateDigest: digest("candidate"), changedPaths: ["src/api.ts"], observableSummary: "The exact candidate passed target, regression, and security verification.", deterministicEvidenceDigest: digest("verification"), deterministicEvidenceRefs: ["target", "regression", "security"], assembledAt: "2026-08-17T12:00:00.000Z", assemblerVersion: "test/1",
    });
    expect(pack.criteria).toHaveLength(3);
    expect(pack.criteria.map(({ id }) => id)).toEqual(["blast_radius_correctness", "semantic_migration_correctness", "verification_strength"]);
    expect(pack.checks[0]).toMatchObject({ status: "passed", candidateIds: null });
    expect(filterDeterministicCandidates(pack).eligible.map(({ candidateId }) => candidateId)).toEqual(["candidate_a"]);
  });

  it("rejects a changed path outside the exact completion scope", () => {
    expect(() => createCompletionVerifierEvidencePack({
      tenantId: "tenant_a", missionId: "mission_a", taskId: "task_a", product: "regauge", repositoryId: "repo_a", snapshotDigest: digest("snapshot"), objective: "Plan the migration.", risk: "high",
      governance: { dataClassification: "internal", requiredRegion: "us", processingRegion: "us", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentId: "consent_a", consentActive: true }, governanceEvidenceRef: "approval", allowedChangedPaths: ["src/api.ts"], candidateId: "candidate_a", candidateDigest: digest("candidate"), changedPaths: ["deploy/prod.yml"], observableSummary: "Candidate", deterministicEvidenceDigest: digest("verification"), deterministicEvidenceRefs: ["verification"], assembledAt: "2026-08-17T12:00:00.000Z", assemblerVersion: "test/1",
    })).toThrow("verifier_completion_path_outside_scope");
  });
});
