import { describe, expect, it } from "vitest";
import {
  buildPivotTournamentSchedule,
  decodeFineGrainedReward,
  verifierScoreIdentity,
} from "./index.js";

describe("fine grained verifier reward", () => {
  it("decodes A through T log probabilities into a normalized expectation", () => {
    const score = decodeFineGrainedReward([
      { token: "A", logprob: Math.log(0.75) },
      { token: "T", logprob: Math.log(0.25) },
      { token: "the", logprob: Math.log(0.5) },
    ]);
    expect(score.value).toBeCloseTo(0.75, 8);
    expect(score.recognizedTokenCount).toBe(2);
    expect(score.recognizedProbabilityMass).toBeCloseTo(1, 8);
  });

  it("fails closed when score token probability evidence is absent", () => {
    expect(() => decodeFineGrainedReward([{ token: "the", logprob: -0.1 }]))
      .toThrow("verifier_logprob_score_tokens_missing");
  });
});

describe("pivot tournament schedule", () => {
  it("is seeded, position balanced, and does not duplicate a pivot edge", () => {
    const first = buildPivotTournamentSchedule(["a", "b"], 2, 0);
    const second = buildPivotTournamentSchedule(["a", "b"], 2, 0);
    expect(first).toEqual(second);
    expect(first.ring).toEqual(expect.arrayContaining([
      { candidateAId: "a", candidateBId: "b" },
      { candidateAId: "b", candidateBId: "a" },
    ]));
    expect(first.pivot).toEqual([]);
    expect(first.comparisons).toHaveLength(2);
  });

  it("rejects invalid candidate, pivot, and evaluation counts", () => {
    expect(() => buildPivotTournamentSchedule([], 1, 0)).toThrow("verifier_candidates_required");
    expect(() => buildPivotTournamentSchedule(["a", "b"], 0, 0)).toThrow("verifier_pivots_invalid");
    expect(() => buildPivotTournamentSchedule(["a", "a"], 1, 0)).toThrow("verifier_candidate_duplicate");
  });

  it("content addresses task, candidate, criterion, model, mode, and repetition", () => {
    const base = {
      tenantId: "tenant_a", taskId: "task_a", evidencePackDigest: `sha256:${"a".repeat(64)}`,
      candidateADigest: `sha256:${"b".repeat(64)}`, candidateBDigest: `sha256:${"c".repeat(64)}`,
      criterionDigest: `sha256:${"d".repeat(64)}`, backendId: "deepseek", model: "deepseek-v4-flash",
      backendRevision: "official-chat-completions-v1", mode: "nonthinking_logprobs", repetition: 0,
    } as const;
    const first = verifierScoreIdentity(base);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(verifierScoreIdentity({ ...base, taskId: "task_b" })).not.toBe(first);
    expect(verifierScoreIdentity({ ...base, candidateADigest: `sha256:${"e".repeat(64)}` })).not.toBe(first);
    expect(verifierScoreIdentity({ ...base, model: "deepseek-v4-pro" })).not.toBe(first);
  });
});
