import type { AdaptiveReviewRisk } from "./adaptive-loop.js";

/**
 * Selective review-tier classifier for Transformer adaptive candidates.
 *
 * Review is ALWAYS mandatory and ALWAYS human: no tier ever auto-applies,
 * auto-merges, or skips human sign-off. Every candidate still becomes a
 * reviewable draft that a human must approve. This classifier only scales the
 * REQUIRED sign-off strength to a candidate's risk/confidence/blast-radius:
 *
 *   - `standard`  : low risk + high confidence + small blast radius. Follows the
 *                   existing single-human-approval path unchanged.
 *   - `escalated` : high risk OR low confidence OR large blast radius. Requires a
 *                   second, distinct human escalation sign-off ON TOP of the
 *                   normal approval before it can be approved and delivered.
 *   - `blocked`   : extreme risk / failed verification. Held: cannot be approved
 *                   or promoted until the blocker clears (e.g. via regeneration).
 *
 * The classifier is pure and deterministic. Its thresholds are configurable and
 * the default policy is DISABLED, so the default reproduces today's behavior
 * exactly: every candidate classifies as `standard` (uniform mandatory single
 * approval). Tiering only ever RAISES the bar; it never lowers it below the
 * current mandatory-review floor.
 */

export type ReviewTier = "standard" | "escalated" | "blocked";

const REVIEW_RISKS: ReadonlySet<AdaptiveReviewRisk> = new Set(["low", "medium", "high"]);

export type ReviewTierClassifierInput = Readonly<{
  /** Aggregate risk of the sealed review evidence. */
  overallRisk: AdaptiveReviewRisk;
  /** Whole-number confidence percentage from 0 through 100. */
  confidence: number;
  /** Number of files the candidate changes (blast radius). */
  changedFileCount: number;
  /**
   * Whether the objective verification that gates the candidate passed. Sealed
   * candidates always converge with a passing verification, so this is true on
   * the live seal path; a false value is never deliverable and always blocks.
   */
  verificationPassed: boolean;
}>;

/**
 * One threshold band. A candidate matches the band when ANY signal is at least
 * as extreme as the band: its risk is listed, its confidence is strictly below
 * `minConfidence`, or its changed-file count is strictly above `maxChangedFiles`.
 */
export type ReviewTierBand = Readonly<{
  risks: readonly AdaptiveReviewRisk[];
  minConfidence: number;
  maxChangedFiles: number;
}>;

export type ReviewTierPolicy = Readonly<{
  /** When false the classifier always returns `standard` (today's behavior). */
  enabled: boolean;
  escalate: ReviewTierBand;
  block: ReviewTierBand;
}>;

/**
 * Default policy: DISABLED. Reproduces today's uniform-mandatory single-approval
 * behavior byte-for-byte — every verified candidate classifies as `standard`.
 */
export const DEFAULT_REVIEW_TIER_POLICY: ReviewTierPolicy = Object.freeze({
  enabled: false,
  escalate: Object.freeze({
    risks: Object.freeze([]) as readonly AdaptiveReviewRisk[],
    minConfidence: 0,
    maxChangedFiles: Number.MAX_SAFE_INTEGER,
  }),
  block: Object.freeze({
    risks: Object.freeze([]) as readonly AdaptiveReviewRisk[],
    minConfidence: 0,
    maxChangedFiles: Number.MAX_SAFE_INTEGER,
  }),
});

/**
 * Recommended enabled preset. Opt-in only; never the default. Documented,
 * deterministic thresholds:
 *   - escalate: overallRisk `high`, OR confidence below 60, OR more than 20 files.
 *   - block: confidence below 25, OR more than 50 files (or failed verification).
 */
export const RECOMMENDED_REVIEW_TIER_POLICY: ReviewTierPolicy = Object.freeze({
  enabled: true,
  escalate: Object.freeze({
    risks: Object.freeze(["high"]) as readonly AdaptiveReviewRisk[],
    minConfidence: 60,
    maxChangedFiles: 20,
  }),
  block: Object.freeze({
    risks: Object.freeze([]) as readonly AdaptiveReviewRisk[],
    minConfidence: 25,
    maxChangedFiles: 50,
  }),
});

function assertConfidence(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) throw new Error(code);
}

function assertMaxFiles(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
}

function assertRisks(risks: readonly AdaptiveReviewRisk[], code: string): void {
  if (!Array.isArray(risks)) throw new Error(code);
  for (const risk of risks) {
    if (!REVIEW_RISKS.has(risk)) throw new Error(code);
  }
}

/**
 * Validate a policy and normalize it into a frozen shape. The `block` band must
 * be at least as extreme as the `escalate` band on every axis, so a candidate
 * can never classify `blocked` on a signal that would not also have escalated.
 */
export function resolveReviewTierPolicy(policy: ReviewTierPolicy): ReviewTierPolicy {
  if (!policy || typeof policy !== "object") throw new Error("review_tier_policy_invalid");
  assertConfidence(policy.escalate.minConfidence, "review_tier_policy_escalate_confidence_invalid");
  assertConfidence(policy.block.minConfidence, "review_tier_policy_block_confidence_invalid");
  assertMaxFiles(policy.escalate.maxChangedFiles, "review_tier_policy_escalate_files_invalid");
  assertMaxFiles(policy.block.maxChangedFiles, "review_tier_policy_block_files_invalid");
  assertRisks(policy.escalate.risks, "review_tier_policy_escalate_risks_invalid");
  assertRisks(policy.block.risks, "review_tier_policy_block_risks_invalid");
  if (policy.block.minConfidence > policy.escalate.minConfidence) {
    throw new Error("review_tier_policy_confidence_not_monotonic");
  }
  if (policy.block.maxChangedFiles < policy.escalate.maxChangedFiles) {
    throw new Error("review_tier_policy_files_not_monotonic");
  }
  return Object.freeze({
    enabled: policy.enabled === true,
    escalate: Object.freeze({
      risks: Object.freeze([...policy.escalate.risks]),
      minConfidence: policy.escalate.minConfidence,
      maxChangedFiles: policy.escalate.maxChangedFiles,
    }),
    block: Object.freeze({
      risks: Object.freeze([...policy.block.risks]),
      minConfidence: policy.block.minConfidence,
      maxChangedFiles: policy.block.maxChangedFiles,
    }),
  });
}

function bandMatches(input: ReviewTierClassifierInput, band: ReviewTierBand): boolean {
  return (
    band.risks.includes(input.overallRisk) ||
    input.confidence < band.minConfidence ||
    input.changedFileCount > band.maxChangedFiles
  );
}

/**
 * Deterministically classify the required review tier. Precedence is
 * blocked > escalated > standard. A failed verification is never deliverable
 * and always blocks. With the default (disabled) policy every verified
 * candidate is `standard`, preserving today's uniform-mandatory approval.
 */
export function classifyReviewTier(
  input: ReviewTierClassifierInput,
  policy: ReviewTierPolicy = DEFAULT_REVIEW_TIER_POLICY,
): ReviewTier {
  if (input.overallRisk === undefined || !REVIEW_RISKS.has(input.overallRisk)) {
    throw new Error("review_tier_risk_invalid");
  }
  assertConfidence(input.confidence, "review_tier_confidence_invalid");
  if (!Number.isSafeInteger(input.changedFileCount) || input.changedFileCount < 1) {
    throw new Error("review_tier_changed_file_count_invalid");
  }
  if (typeof input.verificationPassed !== "boolean") {
    throw new Error("review_tier_verification_invalid");
  }
  // A failing objective verification is never deliverable regardless of policy.
  if (!input.verificationPassed) return "blocked";
  const resolved = resolveReviewTierPolicy(policy);
  if (!resolved.enabled) return "standard";
  if (bandMatches(input, resolved.block)) return "blocked";
  if (bandMatches(input, resolved.escalate)) return "escalated";
  return "standard";
}

const REVIEW_TIERS: ReadonlySet<ReviewTier> = new Set(["standard", "escalated", "blocked"]);

export function isReviewTier(value: unknown): value is ReviewTier {
  return typeof value === "string" && REVIEW_TIERS.has(value as ReviewTier);
}
