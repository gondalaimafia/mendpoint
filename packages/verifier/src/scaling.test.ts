import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentVerifier,
  runMuseBestOfNPlans,
  type MusePlanGenerator,
  type VerifierBackend,
  type VerifierEvidencePackInput,
} from "./index.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function basePack(): Omit<VerifierEvidencePackInput, "candidates" | "checks"> {
  return {
    schemaVersion: "2026-08-17.v1",
    tenantId: "tenant_a",
    missionId: "mission_a",
    taskId: "task_a",
    product: "regauge",
    repositoryId: "repo_a",
    snapshotDigest: digest("snapshot"),
    objective: "Plan the bounded migration.",
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
    allowedChangedPaths: ["src/api.ts"],
    criteria: [{
      id: "migration_safety",
      title: "Migration safety",
      description: "The migration is bounded and reversible.",
      hard: true,
      weight: 1,
    }],
    sources: [{
      id: "architecture",
      kind: "graph",
      digest: digest("graph"),
      locator: "graph:repo_a",
      content: "api depends on the legacy adapter",
    }],
    assembledAt: "2026-08-17T12:00:00.000Z",
    assemblerVersion: "test/1",
  };
}

describe("Muse Best of N plan scaling", () => {
  it("generates isolated Muse plans, filters failures, and lets the verifier rank only survivors", async () => {
    const workspaces: string[] = [];
    const generate: MusePlanGenerator["generate"] = async (request) => {
      workspaces.push(request.workspaceId);
      const failed = request.ordinal === 1;
      return {
        workspaceId: request.workspaceId,
        candidate: {
          candidateId: request.candidateId,
          artifactDigest: digest(request.candidateId),
          kind: "plan",
          observableOutput: `Observable plan ${request.ordinal}`,
          changedPaths: ["src/api.ts"],
          evidenceRefs: ["architecture", `check_${request.ordinal}`],
          deterministicCheckIds: [`check_${request.ordinal}`],
          hardCriterionResults: [{
            criterionId: "migration_safety",
            status: failed ? "failed" : "passed",
            evidenceRefs: [`check_${request.ordinal}`],
          }],
        },
        checks: [{
          id: `check_${request.ordinal}`,
          status: failed ? "failed" : "passed",
          evidenceRefs: [`check_${request.ordinal}`],
        }],
      };
    };
    const generator: MusePlanGenerator = {
      descriptor: { provider: "mendpoint", model: "muse-1.2", revision: "muse-1.2-test" },
      generate: vi.fn(generate),
    };
    const seenCandidates: string[][] = [];
    const backend: VerifierBackend = {
      descriptor: { backendId: "deepseek", provider: "deepseek", model: "deepseek-v4-flash", backendRevision: "test", mode: "nonthinking_logprobs" },
      score: async (request) => {
        seenCandidates.push(request.candidates.map(({ candidateId }) => candidateId));
        return {
          requestId: request.requestId,
          criterionId: request.criterion.id,
          scores: Object.fromEntries(request.candidates.map(({ candidateId }) => [candidateId, candidateId.endsWith("3") ? 0.95 : 0.25])),
          rawResponseDigest: digest(request.requestId),
          recognizedProbabilityMass: 1,
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 0, totalTokens: 12 },
          estimatedCostUsd: 0.001,
          latencyMs: 1,
        };
      },
    };
    const result = await runMuseBestOfNPlans({
      basePack: basePack(),
      globalChecks: [],
      candidateCount: 3,
      incumbentOrdinal: 0,
      generationAttemptId: "generation_a",
      generator,
      verifier: createAgentVerifier({ enabled: true, rolloutMode: "shadow", backend, evaluations: 2, pivots: 1, seed: 0, maximumCandidates: 5 }),
      observedAt: "2026-08-17T12:01:00.000Z",
    });
    expect(new Set(workspaces).size).toBe(3);
    expect(result.generatedBy).toEqual({ provider: "mendpoint", model: "muse-1.2", revision: "muse-1.2-test" });
    expect(result.verifierResult.suggestedCandidateId).toBe("muse_plan_3");
    expect(result.verifierResult.effectiveCandidateId).toBe("muse_plan_1");
    expect(result.filteredOut).toEqual([{ candidateId: "muse_plan_2", reasons: ["deterministic_check_failed", "hard_criterion_failed"] }]);
    expect(seenCandidates.flat()).not.toContain("muse_plan_2");
  });

  it("rejects a non Muse generator and a generator that reuses a workspace", async () => {
    const invalidModel = {
      descriptor: { provider: "deepseek", model: "deepseek-v4-flash", revision: "bad" },
      generate: async () => { throw new Error("unreachable"); },
    } as unknown as MusePlanGenerator;
    const verifier = createAgentVerifier({
      enabled: false,
      rolloutMode: "off",
      backend: { descriptor: { backendId: "noop", provider: "none", model: "none", backendRevision: "none", mode: "muse_self" }, score: async () => { throw new Error("unreachable"); } },
      evaluations: 1,
      pivots: 1,
      seed: 0,
      maximumCandidates: 5,
    });
    await expect(runMuseBestOfNPlans({ basePack: basePack(), globalChecks: [], candidateCount: 2, incumbentOrdinal: 0, generationAttemptId: "generation_a", generator: invalidModel, verifier, observedAt: "2026-08-17T12:01:00.000Z" }))
      .rejects.toThrow("verifier_muse_generator_required");

    const reused: MusePlanGenerator = {
      descriptor: { provider: "mendpoint", model: "muse-1.2", revision: "test" },
      generate: async (request) => ({
        workspaceId: "same_workspace",
        candidate: { candidateId: request.candidateId, artifactDigest: digest(request.candidateId), kind: "plan", observableOutput: "Plan", changedPaths: ["src/api.ts"], evidenceRefs: ["check"], deterministicCheckIds: ["check"], hardCriterionResults: [{ criterionId: "migration_safety", status: "passed", evidenceRefs: ["check"] }] },
        checks: [{ id: "check", status: "passed", evidenceRefs: ["check"] }],
      }),
    };
    await expect(runMuseBestOfNPlans({ basePack: basePack(), globalChecks: [], candidateCount: 2, incumbentOrdinal: 0, generationAttemptId: "generation_a", generator: reused, verifier, observedAt: "2026-08-17T12:01:00.000Z" }))
      .rejects.toThrow("verifier_candidate_workspace_mismatch");
  });
});
