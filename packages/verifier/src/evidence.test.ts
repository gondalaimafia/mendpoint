import { describe, expect, it } from "vitest";
import {
  createVerifierEvidencePack,
  filterDeterministicCandidates,
  type VerifierEvidencePackInput,
} from "./index.js";

const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;

function input(): VerifierEvidencePackInput {
  return {
    schemaVersion: "2026-08-17.v1",
    tenantId: "tenant_a",
    missionId: "mission_a",
    taskId: "task_a",
    product: "fettler",
    repositoryId: "repo_a",
    snapshotDigest: digest("a"),
    objective: "Update the payments client without changing unrelated behavior.",
    risk: "high",
    governance: {
      dataClassification: "confidential",
      requiredRegion: "us",
      processingRegion: "us",
      externalModelAllowed: true,
      mayLeaveTenantBoundary: true,
      consentId: "consent_a",
      consentActive: true,
    },
    allowedChangedPaths: ["src/client.ts", "test/client.test.ts"],
    criteria: [
      { id: "requirement_correctness", title: "Requirement correctness", description: "Satisfies the exact task.", hard: true, weight: 1 },
      { id: "verification_strength", title: "Verification strength", description: "Uses meaningful checks.", hard: false, weight: 1 },
    ],
    sources: [{
      id: "source_a",
      kind: "repository_excerpt",
      digest: digest("b"),
      locator: "src/client.ts:1",
      content: "export const endpoint = '/v1/charges';",
    }],
    checks: [
      { id: "tests", status: "passed", evidenceRefs: ["evidence_tests"], candidateIds: null },
      { id: "build", status: "passed", evidenceRefs: ["evidence_build"], candidateIds: null },
    ],
    candidates: [
      {
        candidateId: "candidate_a",
        artifactDigest: digest("c"),
        kind: "patch",
        observableOutput: "Change the exact endpoint and update its focused test.",
        changedPaths: ["src/client.ts", "test/client.test.ts"],
        evidenceRefs: ["source_a", "evidence_tests", "evidence_build"],
        deterministicCheckIds: ["tests", "build"],
        hardCriterionResults: [{ criterionId: "requirement_correctness", status: "passed", evidenceRefs: ["evidence_tests"] }],
      },
      {
        candidateId: "candidate_b",
        artifactDigest: digest("d"),
        kind: "patch",
        observableOutput: "Change the endpoint and an unrelated deployment file.",
        changedPaths: ["src/client.ts", "deploy/prod.yml"],
        evidenceRefs: ["source_a"],
        deterministicCheckIds: ["tests"],
        hardCriterionResults: [{ criterionId: "requirement_correctness", status: "passed", evidenceRefs: ["evidence_tests"] }],
      },
    ],
    assembledAt: "2026-08-17T12:00:00.000Z",
    assemblerVersion: "mendpoint-verifier-evidence/1",
  };
}

describe("verifier evidence", () => {
  it("creates a stable immutable evidence pack and redacts known secrets", () => {
    const raw = input();
    raw.sources[0] = { ...raw.sources[0]!, content: "const api_key = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';" };
    const first = createVerifierEvidencePack(raw);
    const second = createVerifierEvidencePack(input());
    expect(first.sources[0]?.content).toContain("[REDACTED_SECRET]");
    expect(first.packDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second.packDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => ((first.candidates as unknown as Array<unknown>).push({}))).toThrow();
  });

  it("rejects ambiguous secret material and private reasoning before a backend call", () => {
    const secret = input();
    secret.sources[0] = { ...secret.sources[0]!, content: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEf" };
    expect(() => createVerifierEvidencePack(secret)).toThrow("verifier_evidence_source_excluded");
    const reasoning = { ...input(), chainOfThought: "hidden" } as VerifierEvidencePackInput;
    expect(() => createVerifierEvidencePack(reasoning)).toThrow("verifier_private_reasoning_forbidden");
  });

  it("filters deterministic failures and scope violations before model scoring", () => {
    const pack = createVerifierEvidencePack(input());
    const result = filterDeterministicCandidates(pack);
    expect(result.eligible.map((candidate) => candidate.candidateId)).toEqual(["candidate_a"]);
    expect(result.rejected).toEqual([{ candidateId: "candidate_b", reasons: ["changed_path_outside_scope"] }]);
  });

  it("treats every pack level failed check as authoritative even when a candidate omits it", () => {
    const raw = input();
    raw.checks.push({ id: "security", status: "failed", evidenceRefs: ["security_evidence"], candidateIds: null });
    const result = filterDeterministicCandidates(createVerifierEvidencePack(raw));
    expect(result.eligible).toEqual([]);
    expect(result.rejected.every(({ reasons }) => reasons.includes("deterministic_check_failed"))).toBe(true);
  });

  it("rejects only the candidate bound to a candidate specific failed check", () => {
    const raw = input();
    raw.checks.push({
      id: "candidate_b_tests",
      status: "failed",
      evidenceRefs: ["candidate_b_test_evidence"],
      candidateIds: ["candidate_b"],
    });
    raw.candidates[1]!.deterministicCheckIds.push("candidate_b_tests");
    const result = filterDeterministicCandidates(createVerifierEvidencePack(raw));
    expect(result.eligible.map(({ candidateId }) => candidateId)).toEqual(["candidate_a"]);
    expect(result.rejected).toEqual([{
      candidateId: "candidate_b",
      reasons: ["changed_path_outside_scope", "deterministic_check_failed"],
    }]);
  });

  it("rejects tenant egress, residency, and inactive consent before construction", () => {
    for (const governance of [
      { ...input().governance, externalModelAllowed: false },
      { ...input().governance, requiredRegion: "eu" },
      { ...input().governance, consentActive: false },
    ]) {
      expect(() => createVerifierEvidencePack({ ...input(), governance })).toThrow(/verifier_governance_/);
    }
  });

  it("refuses to externally verify restricted classification content even when egress is otherwise authorized", () => {
    const restricted = { ...input().governance, dataClassification: "restricted" as const };
    expect(() => createVerifierEvidencePack({ ...input(), governance: restricted }))
      .toThrow("verifier_governance_restricted_egress_denied");
    // Public classification with the same authority stays admissible, so the
    // restricted case is treated differently rather than blanket denied.
    expect(() => createVerifierEvidencePack({ ...input(), governance: { ...input().governance, dataClassification: "public" as const } }))
      .not.toThrow();
  });
});
