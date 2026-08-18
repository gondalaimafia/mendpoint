import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAgentVerifier,
  type VerifierBackend,
  type VerifierEvidencePackInput,
} from "@mendpoint/verifier";
import {
  renderMuseDeepSeekBenchmarkMarkdown,
  runMuseDeepSeekVerifierBenchmark,
  type MuseDeepSeekBenchmarkTask,
} from "./muse-deepseek-verifier.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function task(taskId: string, correct: readonly boolean[]): MuseDeepSeekBenchmarkTask {
  const candidates = correct.map((_, index) => ({
    candidateId: `candidate_${index + 1}`,
    artifactDigest: digest(`${taskId}:${index}`),
    kind: "plan" as const,
    observableOutput: `Observable candidate ${index + 1}`,
    changedPaths: ["src/api.ts"],
    evidenceRefs: ["truth"],
    deterministicCheckIds: [`candidate_check_${index + 1}`],
    hardCriterionResults: [{ criterionId: "correctness", status: "passed" as const, evidenceRefs: ["truth"] }],
  }));
  const pack: VerifierEvidencePackInput = {
    schemaVersion: "2026-08-17.v1",
    tenantId: "tenant_eval",
    missionId: `mission_${taskId}`,
    taskId,
    product: taskId.endsWith("r") ? "regauge" : "fettler",
    repositoryId: `repo_${taskId}`,
    snapshotDigest: digest(`snapshot:${taskId}`),
    objective: `Solve ${taskId}`,
    risk: "high",
    governance: { dataClassification: "internal", requiredRegion: "us", processingRegion: "us", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentId: "consent_eval", consentActive: true },
    allowedChangedPaths: ["src/api.ts"],
    criteria: [{ id: "correctness", title: "Correctness", description: "Matches the sealed answer key.", hard: true, weight: 1 }],
    sources: [{ id: "truth", kind: "verification", digest: digest(`truth:${taskId}`), locator: `answer:${taskId}`, content: "A sealed grader evaluates the selected artifact after selection." }],
    checks: correct.map((_, index) => ({ id: `candidate_check_${index + 1}`, status: "passed", evidenceRefs: ["truth"], candidateIds: [`candidate_${index + 1}`] })),
    candidates,
    assembledAt: "2026-08-17T12:00:00.000Z",
    assemblerVersion: "benchmark-test/1",
  };
  return {
    taskId,
    family: pack.product,
    difficulty: "hard",
    split: "holdout",
    cohortRevision: "0123456789abcdef0123456789abcdef01234567",
    cohortDigest: digest(`cohort:${taskId}`),
    pack,
    correctByCandidateId: Object.fromEntries(candidates.map((candidate, index) => [candidate.candidateId, correct[index]!])),
    generationUsageByCandidateId: Object.fromEntries(candidates.map((candidate) => [candidate.candidateId, { tokens: 100, costUsd: 0.01, latencyMs: 50 }])),
  };
}

function backend(backendId: string, winner: (taskId: string) => string): VerifierBackend {
  return {
    descriptor: { backendId, provider: backendId === "muse-self" ? "mendpoint" : "deepseek", model: backendId === "muse-self" ? "muse-1.2" : "deepseek-v4-flash", backendRevision: "test", mode: backendId === "muse-self" ? "muse_self" : "nonthinking_logprobs" },
    score: async (request) => ({
      requestId: request.requestId,
      criterionId: request.criterion.id,
      scores: Object.fromEntries(request.candidates.map(({ candidateId }) => [candidateId, candidateId === winner(request.taskId) ? 0.95 : 0.2])),
      rawResponseDigest: digest(`${backendId}:${request.requestId}`),
      recognizedProbabilityMass: 1,
      usage: { inputTokens: 20, cachedInputTokens: 2, outputTokens: 4, reasoningTokens: 0, totalTokens: 24 },
      estimatedCostUsd: backendId === "muse-self" ? 0.002 : 0.001,
      latencyMs: backendId === "muse-self" ? 10 : 5,
    }),
  };
}

describe("Muse and DeepSeek verifier benchmark", () => {
  it("reports baseline, self selection, independent selection, oracle, calibration, and economics", async () => {
    const tasks = [task("task_f", [false, true, false]), task("task_r", [true, false, true])];
    const selfVerifier = createAgentVerifier({ enabled: true, rolloutMode: "offline", backend: backend("muse-self", () => "candidate_1"), evaluations: 2, pivots: 1, seed: 0, maximumCandidates: 5 });
    const deepVerifier = createAgentVerifier({ enabled: true, rolloutMode: "offline", backend: backend("deepseek", (taskId) => taskId === "task_f" ? "candidate_2" : "candidate_1"), evaluations: 2, pivots: 1, seed: 0, maximumCandidates: 5 });
    const report = await runMuseDeepSeekVerifierBenchmark({ tasks, candidateCounts: [1, 2, 3], museSelfVerifier: selfVerifier, deepSeekVerifier: deepVerifier, runId: "run_a", observedAt: "2026-08-17T13:00:00.000Z" });
    expect(report.rows.map(({ candidateCount }) => candidateCount)).toEqual([1, 2, 3]);
    const n3 = report.rows[2]!;
    expect(n3.musePassAt1.successes).toBe(1);
    expect(n3.museSelfSelected.successes).toBe(1);
    expect(n3.deepSeekSelected.successes).toBe(2);
    expect(n3.oracle.successes).toBe(2);
    expect(n3.deepSeekSelected.absoluteLift).toBe(0.5);
    expect(n3.deepSeekSelected.incrementalCostPerAdditionalSuccessUsd).toBeGreaterThan(0);
    expect(n3.deepSeekSelected.caughtMuseErrors).toBe(1);
    expect(n3.deepSeekSelected.introducedErrors).toBe(0);
    expect(report.deepSeekCalibration.observationCount).toBeGreaterThan(0);
    expect(report.reportDigest).toMatch(/^sha256:/);
    const markdown = renderMuseDeepSeekBenchmarkMarkdown(report);
    expect(markdown).toContain("Muse Pass@1");
    expect(markdown).toContain("Cost per additional successful task");
    expect(markdown).not.toContain("chain of thought");
  });

  it("requires a sealed holdout cohort and rejects candidate truth leakage or missing outcomes", async () => {
    const invalid = task("task_f", [false, true]);
    await expect(runMuseDeepSeekVerifierBenchmark({ tasks: [{ ...invalid, split: "development" } as unknown as MuseDeepSeekBenchmarkTask], candidateCounts: [2], museSelfVerifier: createAgentVerifier({ enabled: true, rolloutMode: "offline", backend: backend("muse-self", () => "candidate_1"), evaluations: 1, pivots: 1, seed: 0, maximumCandidates: 5 }), deepSeekVerifier: createAgentVerifier({ enabled: true, rolloutMode: "offline", backend: backend("deepseek", () => "candidate_2"), evaluations: 1, pivots: 1, seed: 0, maximumCandidates: 5 }), runId: "run_a", observedAt: "2026-08-17T13:00:00.000Z" }))
      .rejects.toThrow("verifier_benchmark_holdout_required");
    const leaked = { ...invalid, pack: { ...invalid.pack, sources: [{ ...invalid.pack.sources[0]!, content: "candidate_2 is correct" }] } };
    await expect(runMuseDeepSeekVerifierBenchmark({ tasks: [leaked], candidateCounts: [2], museSelfVerifier: createAgentVerifier({ enabled: true, rolloutMode: "offline", backend: backend("muse-self", () => "candidate_1"), evaluations: 1, pivots: 1, seed: 0, maximumCandidates: 5 }), deepSeekVerifier: createAgentVerifier({ enabled: true, rolloutMode: "offline", backend: backend("deepseek", () => "candidate_2"), evaluations: 1, pivots: 1, seed: 0, maximumCandidates: 5 }), runId: "run_a", observedAt: "2026-08-17T13:00:00.000Z" }))
      .rejects.toThrow("verifier_benchmark_answer_key_leak");
  });
});
