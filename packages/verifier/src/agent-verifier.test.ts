import { describe, expect, it, vi } from "vitest";
import {
  createAgentVerifier,
  createVerifierEvidencePack,
  resolveVerifierPolicy,
  type VerifierBackend,
  type VerifierBackendScoreInput,
  type VerifierEvidencePackInput,
} from "./index.js";

const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
function packInput(): VerifierEvidencePackInput {
  return {
    schemaVersion: "2026-08-17.v1", tenantId: "tenant_a", missionId: "mission_a", taskId: "task_a",
    product: "regauge", repositoryId: "repo_a", snapshotDigest: digest("a"), objective: "Upgrade the runtime safely.", risk: "high",
    governance: { dataClassification: "confidential", requiredRegion: "us", processingRegion: "us", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentId: "consent_a", consentActive: true },
    allowedChangedPaths: ["package.json"],
    criteria: [{ id: "migration_safety", title: "Migration safety", description: "Preserves exact behavior.", hard: true, weight: 1 }],
    sources: [{ id: "source", kind: "verification", digest: digest("b"), locator: "artifact:test", content: "Tests passed." }],
    checks: [{ id: "tests", status: "passed", evidenceRefs: ["test_evidence"], candidateIds: null }],
    candidates: ["a", "b"].map((id) => ({
      candidateId: `candidate_${id}`, artifactDigest: digest(id), kind: "plan" as const,
      observableOutput: `Plan ${id}`, changedPaths: ["package.json"], evidenceRefs: ["source"], deterministicCheckIds: ["tests"],
      hardCriterionResults: [{ criterionId: "migration_safety", status: "passed" as const, evidenceRefs: ["test_evidence"] }],
    })),
    assembledAt: "2026-08-17T12:00:00.000Z", assemblerVersion: "test/1",
  };
}

const backend: VerifierBackend = {
  descriptor: { backendId: "deepseek", provider: "deepseek", model: "deepseek-v4-flash", backendRevision: "test", mode: "nonthinking_logprobs" },
  score: vi.fn(async (input: VerifierBackendScoreInput) => ({
    requestId: input.requestId,
    scores: Object.fromEntries(input.candidates.map((candidate) => [candidate.candidateId, candidate.candidateId.endsWith("b") ? 0.9 : 0.1])),
    criterionId: input.criterion.id,
    rawResponseDigest: digest("f"),
    recognizedProbabilityMass: 1,
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 0, totalTokens: 12 },
    estimatedCostUsd: 0.001,
    latencyMs: 10,
  })),
};

const verifyInput = (pack = createVerifierEvidencePack(packInput())) => ({
  pack,
  incumbentCandidateId: "candidate_a",
  verificationAttemptId: "attempt_a",
  observedAt: "2026-08-17T12:00:00.000Z",
});

describe("AgentVerifier", () => {
  it("records a shadow recommendation without changing the incumbent", async () => {
    const verifier = createAgentVerifier({ enabled: true, rolloutMode: "shadow", backend, evaluations: 2, pivots: 1, seed: 0, maximumCandidates: 5 });
    const result = await verifier.verify(verifyInput());
    expect(result.status).toBe("verified");
    expect(result.suggestedCandidateId).toBe("candidate_b");
    expect(result.effectiveCandidateId).toBe("candidate_a");
    expect(result.behaviorChanged).toBe(false);
    expect(result.telemetry.rolloutMode).toBe("shadow");
  });

  it("the global kill switch prevents construction, scoring, and behavior changes", async () => {
    const score = vi.fn(backend.score);
    const verifier = createAgentVerifier({ enabled: false, rolloutMode: "selective", backend: { ...backend, score }, evaluations: 2, pivots: 1, seed: 0, maximumCandidates: 5 });
    const result = await verifier.verify(verifyInput());
    expect(result.status).toBe("disabled");
    expect(result.effectiveCandidateId).toBe("candidate_a");
    expect(score).not.toHaveBeenCalled();
  });

  it("requires exact tenant and product authority before selective mode can change selection", async () => {
    const pack = createVerifierEvidencePack(packInput());
    const denied = createAgentVerifier({ enabled: true, rolloutMode: "selective", backend, evaluations: 2, pivots: 1, seed: 0, maximumCandidates: 5 });
    expect((await denied.verify(verifyInput(pack))).effectiveCandidateId).toBe("candidate_a");
    const allowed = createAgentVerifier({
      enabled: true, rolloutMode: "selective", backend, evaluations: 2, pivots: 1, seed: 0, maximumCandidates: 5,
      behaviorChangeAuthority: { tenantIds: ["tenant_a"], products: ["regauge"] },
    });
    const result = await allowed.verify(verifyInput(pack));
    expect(result.effectiveCandidateId).toBe("candidate_b");
    expect(result.behaviorChanged).toBe(true);
  });

  it("rejects malformed or ambiguous behavior change authority before scoring", () => {
    const base = { enabled: true, rolloutMode: "selective" as const, backend, evaluations: 2, pivots: 1, seed: 0, maximumCandidates: 5 };
    expect(() => createAgentVerifier({ ...base, behaviorChangeAuthority: { tenantIds: [], products: ["regauge"] } })).toThrow("verifier_behavior_authority_invalid");
    expect(() => createAgentVerifier({ ...base, behaviorChangeAuthority: { tenantIds: ["tenant_a", "tenant_a"], products: ["regauge"] } })).toThrow("verifier_behavior_authority_invalid");
    expect(() => createAgentVerifier({ ...base, behaviorChangeAuthority: { tenantIds: ["tenant_a"], products: [] } })).toThrow("verifier_behavior_authority_invalid");
    expect(() => createAgentVerifier({
      ...base,
      behaviorChangeAuthority: { tenantIds: ["tenant_a"], products: ["regauge", "regauge"] },
    })).toThrow("verifier_behavior_authority_invalid");
  });

  it("uses only content addressed cached scores and does not call the backend twice", async () => {
    const score = vi.fn(backend.score);
    const cache = new Map<string, Awaited<ReturnType<VerifierBackend["score"]>>>();
    const verifier = createAgentVerifier({ enabled: true, rolloutMode: "shadow", backend: { ...backend, score }, evaluations: 2, pivots: 1, seed: 0, maximumCandidates: 5, scoreCache: { get: (id) => cache.get(id), put: (id, value) => { cache.set(id, value); } } });
    const pack = createVerifierEvidencePack(packInput());
    await verifier.verify(verifyInput(pack));
    const firstCalls = score.mock.calls.length;
    await verifier.verify(verifyInput(pack));
    expect(firstCalls).toBeGreaterThan(0);
    expect(score).toHaveBeenCalledTimes(firstCalls);
  });

  it("fails closed when no deterministic candidate survives", async () => {
    const input = packInput();
    input.checks[0] = { id: "tests", status: "failed", evidenceRefs: ["test_evidence"], candidateIds: null };
    const verifier = createAgentVerifier({ enabled: true, rolloutMode: "shadow", backend, evaluations: 2, pivots: 1, seed: 0, maximumCandidates: 5 });
    const result = await verifier.verify(verifyInput(createVerifierEvidencePack(input)));
    expect(result.status).toBe("no_eligible_candidates");
    expect(result.suggestedCandidateId).toBeNull();
    expect(result.effectiveCandidateId).toBe("candidate_a");
  });
});

describe("verification policy", () => {
  it("routes by risk, budget, failures, eligibility, and rollout authority", () => {
    expect(resolveVerifierPolicy({ risk: "low", rolloutMode: "shadow", eligible: true, candidateCount: 1, priorFailures: 0, remainingBudgetUsd: 1 })).toBe("pass_through");
    expect(resolveVerifierPolicy({ risk: "medium", rolloutMode: "shadow", eligible: true, candidateCount: 1, priorFailures: 0, remainingBudgetUsd: 1 })).toBe("deepseek_verify");
    expect(resolveVerifierPolicy({ risk: "high", rolloutMode: "shadow", eligible: true, candidateCount: 3, priorFailures: 0, remainingBudgetUsd: 1 })).toBe("muse_best_of_n_deepseek");
    expect(resolveVerifierPolicy({ risk: "critical", rolloutMode: "shadow", eligible: true, candidateCount: 3, priorFailures: 0, remainingBudgetUsd: 1 })).toBe("human_escalation");
    expect(resolveVerifierPolicy({ risk: "high", rolloutMode: "shadow", eligible: false, candidateCount: 3, priorFailures: 0, remainingBudgetUsd: 1 })).toBe("human_escalation");
    expect(resolveVerifierPolicy({ risk: "high", rolloutMode: "off", eligible: true, candidateCount: 3, priorFailures: 0, remainingBudgetUsd: 1 })).toBe("pass_through");
  });
});
