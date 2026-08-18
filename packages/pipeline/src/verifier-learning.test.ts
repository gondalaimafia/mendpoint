import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAgentVerifier, createVerifierEvidencePack, type VerifierBackend, type VerifierEvidencePackInput } from "@mendpoint/verifier";
import { createVerifierSoftLearningSignal } from "./verifier-learning.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const backend: VerifierBackend = {
  descriptor: { backendId: "deepseek", provider: "deepseek", model: "deepseek-v4-flash", backendRevision: "test", mode: "nonthinking_logprobs" },
  score: async (input) => ({ requestId: input.requestId, scores: Object.fromEntries(input.candidates.map((candidate) => [candidate.candidateId, candidate.candidateId === "candidate_b" ? 0.9 : 0.1])), criterionId: input.criterion.id, rawResponseDigest: digest("f"), recognizedProbabilityMass: 1, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 0, totalTokens: 12 }, estimatedCostUsd: 0.001, latencyMs: 2 }),
};
function pack(): VerifierEvidencePackInput {
  return {
    schemaVersion: "2026-08-17.v1", tenantId: "tenant_a", missionId: "mission_a", taskId: "task_a", product: "fettler", repositoryId: "repo_a", snapshotDigest: digest("a"), objective: "Migrate the exact API use.", risk: "high",
    governance: { dataClassification: "confidential", requiredRegion: "us", processingRegion: "us", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentId: "consent_a", consentActive: true },
    allowedChangedPaths: ["client.ts"], criteria: [{ id: "correctness", title: "Correctness", description: "Correct.", hard: true, weight: 1 }],
    sources: [{ id: "source", kind: "verification", digest: digest("s"), locator: "test", content: "Tests passed." }],
    checks: [{ id: "tests", status: "passed", evidenceRefs: ["test"], candidateIds: null }],
    candidates: ["a", "b"].map((id) => ({ candidateId: `candidate_${id}`, artifactDigest: digest(id), kind: "plan" as const, observableOutput: `Plan ${id}`, changedPaths: ["client.ts"], evidenceRefs: ["source"], deterministicCheckIds: ["tests"], hardCriterionResults: [{ criterionId: "correctness", status: "passed" as const, evidenceRefs: ["test"] }] })),
    assembledAt: "2026-08-17T12:00:00.000Z", assemblerVersion: "test/1",
  };
}
async function telemetry() {
  const verifier = createAgentVerifier({ enabled: true, rolloutMode: "shadow", backend, evaluations: 2, pivots: 1, seed: 0, maximumCandidates: 5 });
  return (await verifier.verify({ pack: createVerifierEvidencePack(pack()), incumbentCandidateId: "candidate_a", verificationAttemptId: "attempt_a", observedAt: "2026-08-17T12:00:00.000Z" })).telemetry;
}

describe("verifier soft learning signal", () => {
  it("keeps an unlabeled verifier judgment soft and ineligible for model training", async () => {
    const signal = createVerifierSoftLearningSignal({ telemetry: await telemetry(), outcome: null });
    expect(signal.preference).toBeNull();
    expect(signal.modelTrainingEligible).toBe(false);
    expect(signal.softSignalOnly).toBe(true);
    expect(signal.signalDigest).toMatch(/^sha256:/);
  });

  it("creates a preference candidate only after exact deterministic outcome evidence", async () => {
    const signal = createVerifierSoftLearningSignal({
      telemetry: await telemetry(),
      outcome: { authority: "deterministic", winnerCandidateId: "candidate_a", evidenceRefs: ["artifact:test-result"], observedAt: "2026-08-17T13:00:00.000Z" },
    });
    expect(signal.preference).toEqual({ chosenCandidateId: "candidate_a", rejectedCandidateIds: ["candidate_b"], verifierAgreed: false });
    expect(signal.preferenceEligibleForGovernedAdmission).toBe(true);
    expect(signal.modelTrainingEligible).toBe(false);
  });

  it("rejects telemetry tampering and an outcome outside the candidate set", async () => {
    const valid = await telemetry();
    expect(() => createVerifierSoftLearningSignal({ telemetry: { ...valid, candidateScores: { candidate_a: 1 } }, outcome: null }))
      .toThrow("verifier_telemetry_digest_mismatch");
    expect(() => createVerifierSoftLearningSignal({ telemetry: valid, outcome: { authority: "human", winnerCandidateId: "candidate_x", evidenceRefs: ["review"], observedAt: "2026-08-17T13:00:00.000Z" } }))
      .toThrow("verifier_learning_winner_invalid");
  });
});
