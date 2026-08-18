import { describe, expect, it } from "vitest";
import {
  bradleyTerryWinProbability,
  buildPivotTournamentSchedule,
  decodeFineGrainedReward,
  verifierScoreIdentity,
  VERIFIER_SCORE_SCALE,
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

describe("bradley-terry win probability", () => {
  it("is symmetric around a 0.5 tie and complements across the pair", () => {
    expect(bradleyTerryWinProbability(0.5, 0.5)).toBeCloseTo(0.5, 12);
    expect(bradleyTerryWinProbability(0.8, 0.3) + bradleyTerryWinProbability(0.3, 0.8)).toBeCloseTo(1, 12);
  });

  it("spans past the 0.75 ready_for_review threshold at a decisive separation", () => {
    // The unscaled sigmoid saturated near 0.731 for a full [0,1] separation, so
    // the 0.75 threshold was unreachable. With the domain-derived scale a
    // decisively separated candidate crosses it, and the crossover margin is a
    // real ~0.317 raw-score lead rather than the whole range.
    expect(bradleyTerryWinProbability(1, 0)).toBeGreaterThan(0.75);
    expect(bradleyTerryWinProbability(0.5 + VERIFIER_SCORE_SCALE * Math.log(3) / 2, 0.5 - VERIFIER_SCORE_SCALE * Math.log(3) / 2)).toBeCloseTo(0.75, 6);
    expect(VERIFIER_SCORE_SCALE).toBeCloseTo(Math.sqrt(1 / 12), 12);
  });

  it("validates score bounds and a positive scale", () => {
    expect(() => bradleyTerryWinProbability(1.1, 0)).toThrow("verifier_score_invalid");
    expect(() => bradleyTerryWinProbability(1, 0, 0)).toThrow("verifier_score_scale_invalid");
    expect(() => bradleyTerryWinProbability(1, 0, Number.NaN)).toThrow("verifier_score_scale_invalid");
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
