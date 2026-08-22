import { describe, expect, it, vi } from "vitest";
import {
  buildVerifierCalibrationReport,
  criteriaForProduct,
  createMuseSelfVerifierBackend,
  resolveVerifierRuntimeConfig,
  trackVerifierProgress,
  type VerifierBackendScoreInput,
} from "./index.js";

const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;

describe("verifier runtime configuration", () => {
  it("is off by default and does not inspect the credential", () => {
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      get(target, key: string) {
        if (key === "DEEPSEEK_API_KEY") throw new Error("credential_read");
        return target[key];
      },
    });
    expect(resolveVerifierRuntimeConfig(env)).toEqual({ enabled: false, rolloutMode: "off" });
  });

  it("resolves an exact versioned production advisory configuration without carrying a secret", () => {
    const config = resolveVerifierRuntimeConfig({
      DEEPSEEK_VERIFIER_ENABLED: "true",
      MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE: "advisory",
      MENDPOINT_AGENT_VERIFIER_EVALUATIONS: "4",
      MENDPOINT_AGENT_VERIFIER_PIVOTS: "2",
      MENDPOINT_AGENT_VERIFIER_SCORING_MODE: "nonthinking_logprobs",
      MENDPOINT_AGENT_VERIFIER_MAXIMUM_CANDIDATES: "5",
      MENDPOINT_AGENT_VERIFIER_MAXIMUM_COST_USD: "0.10",
      MENDPOINT_AGENT_VERIFIER_TIMEOUT_MS: "30000",
      MENDPOINT_AGENT_VERIFIER_MAXIMUM_RETRIES: "1",
    });
    expect(config).toMatchObject({
      enabled: true, rolloutMode: "advisory", provider: "deepseek", model: "deepseek-v4-flash",
      evaluations: 4, pivots: 2, scoringMode: "nonthinking_logprobs", credentialEnvName: "DEEPSEEK_API_KEY", maximumCostUsd: 0.10,
    });
    expect(JSON.stringify(config)).not.toContain("apiKey");
  });

  it("requires an explicit rollout when external verification is enabled", () => {
    expect(() => resolveVerifierRuntimeConfig({ DEEPSEEK_VERIFIER_ENABLED: "true" }))
      .toThrow("verifier_config_rollout_required");
  });
});

describe("criteria and progress", () => {
  it("selects three focused product criteria", () => {
    const fettler = criteriaForProduct("fettler").map(({ id }) => id);
    const regauge = criteriaForProduct("regauge").map(({ id }) => id);
    expect(fettler).toContain("semantic_migration_correctness");
    expect(fettler).toContain("blast_radius_correctness");
    expect(regauge).toContain("architecture_correctness");
    expect(regauge).toContain("behavior_preservation");
    expect(fettler).toContain("verification_strength");
    expect(fettler).toHaveLength(3);
    expect(regauge).toHaveLength(3);
  });

  it("scores only observable checkpoint prefixes and returns a stable progress curve", async () => {
    const score = vi.fn(async (input: VerifierBackendScoreInput) => ({
      requestId: input.requestId,
      scores: { [input.candidates[0]!.candidateId]: input.candidates[0]!.observableOutput.includes("Tests passed") ? 0.9 : 0.2 },
      criterionId: input.criterion.id,
      rawResponseDigest: digest("f"),
      recognizedProbabilityMass: 1,
      usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, totalTokens: 6 },
      estimatedCostUsd: 0.0001,
      latencyMs: 1,
    }));
    const backend = { descriptor: { backendId: "test", provider: "test", model: "test", backendRevision: "1", mode: "muse_self" as const }, score };
    const result = await trackVerifierProgress({
      backend,
      tenantId: "tenant_a",
      taskId: "task_a",
      evidencePackDigest: digest("a"),
      trustedTask: "Fix the exact endpoint.",
      trustedEvidence: "The test command is node check.mjs.",
      criteria: [{ id: "verification_strength", title: "Verification strength", description: "Uses the exact check.", hard: false, weight: 1 }],
      steps: [
        { stepId: "step_1", kind: "observation", summary: "Read the failing source.", evidenceRefs: ["source"] },
        { stepId: "step_2", kind: "verification", summary: "Tests passed with node check.mjs.", evidenceRefs: ["test"] },
      ],
      checkpointStepIds: ["step_1", "step_2"],
      evaluations: 1,
    });
    expect(result.checkpoints.map(({ score: value }) => value)).toEqual([0.2, 0.9]);
    expect(result.state).toBe("complete");
    expect(score).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("chainOfThought");
  });
});

describe("Muse self verifier control", () => {
  it("normalizes an injected Muse scorer without making it a generator", async () => {
    const backend = createMuseSelfVerifierBackend({
      model: "muse-spark-1.2-contributor",
      backendRevision: "test",
      invoke: async (input) => ({ scores: { [input.candidates[0]!.candidateId]: 0.7 }, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, totalTokens: 11 }, estimatedCostUsd: 0.01, latencyMs: 2, responseDigest: digest("e") }),
    });
    const result = await backend.score({
      requestId: "request", tenantId: "tenant", taskId: "task", evidencePackDigest: digest("a"),
      criterion: { id: "correctness", title: "Correctness", description: "Correct.", hard: false, weight: 1 },
      candidates: [{ candidateId: "candidate", artifactDigest: digest("b"), observableOutput: "Plan", changedPaths: [] }],
      trustedTask: "Task", trustedEvidence: "Evidence", repetition: 0,
    });
    expect(backend.descriptor.mode).toBe("muse_self");
    expect(result.scores.candidate).toBe(0.7);
  });
});

describe("verifier calibration", () => {
  it("reports Brier score, expected calibration error, and false confidence", () => {
    const report = buildVerifierCalibrationReport([
      { observationId: "a", product: "fettler", taskFamily: "sdk_migration", score: 0.9, correct: true },
      { observationId: "b", product: "fettler", taskFamily: "sdk_migration", score: 0.9, correct: false },
      { observationId: "c", product: "regauge", taskFamily: "runtime_upgrade", score: 0.2, correct: false },
    ]);
    expect(report.observationCount).toBe(3);
    expect(report.brierScore).toBeGreaterThan(0);
    expect(report.expectedCalibrationError).toBeGreaterThan(0);
    expect(report.falseConfidenceObservationIds).toEqual(["b"]);
    expect(report.reportDigest).toMatch(/^sha256:/);
  });
});
