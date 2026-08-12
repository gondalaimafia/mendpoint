import { describe, expect, it } from "vitest";
import {
  classifyReviewTier,
  resolveReviewTierPolicy,
  isReviewTier,
  DEFAULT_REVIEW_TIER_POLICY,
  RECOMMENDED_REVIEW_TIER_POLICY,
  type ReviewTierClassifierInput,
} from "./review-tier.js";

function input(overrides: Partial<ReviewTierClassifierInput> = {}): ReviewTierClassifierInput {
  return {
    overallRisk: "low",
    confidence: 90,
    changedFileCount: 3,
    verificationPassed: true,
    ...overrides,
  };
}

describe("classifyReviewTier", () => {
  it("defaults to standard for every verified candidate (uniform mandatory approval)", () => {
    // Default policy is disabled: even a high-risk, low-confidence, large candidate
    // stays standard, so enabling nothing reproduces today's behavior exactly.
    expect(classifyReviewTier(input())).toBe("standard");
    expect(
      classifyReviewTier(input({ overallRisk: "high", confidence: 0, changedFileCount: 5_000 })),
    ).toBe("standard");
    // Passing the explicit default policy is identical to omitting it.
    expect(classifyReviewTier(input(), DEFAULT_REVIEW_TIER_POLICY)).toBe("standard");
  });

  it("classifies low-risk high-confidence as standard under the recommended policy", () => {
    expect(
      classifyReviewTier(
        input({ overallRisk: "low", confidence: 95, changedFileCount: 2 }),
        RECOMMENDED_REVIEW_TIER_POLICY,
      ),
    ).toBe("standard");
  });

  it("escalates on high risk, low confidence, or large blast radius", () => {
    expect(
      classifyReviewTier(input({ overallRisk: "high", confidence: 95 }), RECOMMENDED_REVIEW_TIER_POLICY),
    ).toBe("escalated");
    expect(
      classifyReviewTier(input({ overallRisk: "low", confidence: 50 }), RECOMMENDED_REVIEW_TIER_POLICY),
    ).toBe("escalated");
    expect(
      classifyReviewTier(
        input({ overallRisk: "low", confidence: 95, changedFileCount: 21 }),
        RECOMMENDED_REVIEW_TIER_POLICY,
      ),
    ).toBe("escalated");
  });

  it("blocks on extreme low confidence, extreme blast radius, or failed verification", () => {
    expect(
      classifyReviewTier(input({ confidence: 10 }), RECOMMENDED_REVIEW_TIER_POLICY),
    ).toBe("blocked");
    expect(
      classifyReviewTier(input({ changedFileCount: 51 }), RECOMMENDED_REVIEW_TIER_POLICY),
    ).toBe("blocked");
    // A failed verification is never deliverable regardless of policy (even default).
    expect(classifyReviewTier(input({ verificationPassed: false }))).toBe("blocked");
    expect(
      classifyReviewTier(input({ verificationPassed: false }), RECOMMENDED_REVIEW_TIER_POLICY),
    ).toBe("blocked");
  });

  it("rejects invalid classifier inputs", () => {
    expect(() => classifyReviewTier(input({ confidence: 101 }))).toThrow("review_tier_confidence_invalid");
    expect(() => classifyReviewTier(input({ confidence: -1 }))).toThrow("review_tier_confidence_invalid");
    expect(() => classifyReviewTier(input({ changedFileCount: 0 }))).toThrow(
      "review_tier_changed_file_count_invalid",
    );
    expect(() =>
      classifyReviewTier(input({ overallRisk: "critical" as unknown as "high" })),
    ).toThrow("review_tier_risk_invalid");
  });
});

describe("resolveReviewTierPolicy", () => {
  it("accepts the shipped presets", () => {
    expect(resolveReviewTierPolicy(DEFAULT_REVIEW_TIER_POLICY).enabled).toBe(false);
    expect(resolveReviewTierPolicy(RECOMMENDED_REVIEW_TIER_POLICY).enabled).toBe(true);
  });

  it("requires the block band to be at least as extreme as the escalate band", () => {
    expect(() =>
      resolveReviewTierPolicy({
        enabled: true,
        escalate: { risks: [], minConfidence: 20, maxChangedFiles: 20 },
        block: { risks: [], minConfidence: 60, maxChangedFiles: 50 },
      }),
    ).toThrow("review_tier_policy_confidence_not_monotonic");
    expect(() =>
      resolveReviewTierPolicy({
        enabled: true,
        escalate: { risks: [], minConfidence: 20, maxChangedFiles: 50 },
        block: { risks: [], minConfidence: 10, maxChangedFiles: 20 },
      }),
    ).toThrow("review_tier_policy_files_not_monotonic");
  });

  it("rejects out-of-range thresholds", () => {
    expect(() =>
      resolveReviewTierPolicy({
        enabled: true,
        escalate: { risks: [], minConfidence: 200, maxChangedFiles: 20 },
        block: { risks: [], minConfidence: 10, maxChangedFiles: 50 },
      }),
    ).toThrow("review_tier_policy_escalate_confidence_invalid");
  });
});

describe("isReviewTier", () => {
  it("recognizes only the three tiers", () => {
    expect(isReviewTier("standard")).toBe(true);
    expect(isReviewTier("escalated")).toBe(true);
    expect(isReviewTier("blocked")).toBe(true);
    expect(isReviewTier("approved")).toBe(false);
    expect(isReviewTier(undefined)).toBe(false);
  });
});
