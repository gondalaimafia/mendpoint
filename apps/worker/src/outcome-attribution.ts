import type { LearningOutcomeAttribution } from "@mendpoint/pipeline";
import type { VerificationOutcome } from "@mendpoint/repair";
import type { GraphContextDelivery } from "./warden-learning-producer.js";

/**
 * The evidence a producer actually gathered about a run, reduced to the two
 * orthogonal facts that decide `observedOutcome.attribution`: whether objective
 * verification concluded (and with what result), and what the run's captured
 * trajectory says about whether the model was supplied the context it needed.
 *
 * Both fields carry their honest third state so "we did not check" and "we did
 * not observe" can never collapse into a reassuring answer: `verification` is the
 * three-state {@link VerificationOutcome} (`not_verified` is NOT a failure), and
 * `contextDelivery` is the three-state {@link GraphContextDelivery} (`unrecorded`
 * is NOT "no context was supplied").
 */
export type OutcomeAttributionEvidence = Readonly<{
  verification: VerificationOutcome;
  contextDelivery: GraphContextDelivery;
}>;

/**
 * Derive `observedOutcome.attribution` from evidence the run actually produced,
 * never from a constant.
 *
 * The one rule that governs this function: `model_behavior` is the ONLY
 * attribution that feeds the training corpus (it is the only one `classify` can
 * route to `model_weight`, which `eligibleForModelTraining` gates on), so a wrong
 * `model_behavior` does not merely mislabel a record — it teaches the model its
 * own correct behaviour was wrong. Therefore `model_behavior` is emitted ONLY
 * when the evidence positively confirms the model's behaviour is what the lesson
 * is about, and every case the evidence cannot resolve returns `none`
 * (undetermined) rather than guessing `model_behavior`. High precision, low
 * coverage, fail closed.
 *
 * The three cases it classifies confidently:
 *
 *   - verification `verified` -> `model_behavior`. Objective verification
 *     concluded the model's action is correct; reinforcing it is the lesson.
 *     Context delivery does not narrow this: a verified success stands on its own
 *     whether or not graph context was supplied.
 *   - `failed` + `recorded_present` -> `model_behavior`. The model was supplied
 *     the context it needed and still produced a wrong action, so the failure is
 *     genuinely the model's.
 *   - `failed` + `recorded_absent` -> `retrieval`. Required context was not
 *     supplied to the model (spec 17.4.2: a miss must not be blamed on the model
 *     until Mendpoint has confirmed the context "was supplied to the model"), so
 *     the salient fact is the missing context, not the model. `retrieval` has no
 *     training sink, so this never feeds the corpus regardless.
 *
 * Everything else is undetermined and returns `none`:
 *
 *   - `not_verified` -> nothing objective was established about the run, so it is
 *     no statement about the model at all.
 *   - `failed` + `unrecorded` -> no observation of what the model was given, so a
 *     model failure cannot be told apart from a retrieval gap.
 */
export function deriveOutcomeAttribution(
  evidence: OutcomeAttributionEvidence,
): LearningOutcomeAttribution {
  if (evidence.verification === "not_verified") return "none";
  if (evidence.verification === "verified") return "model_behavior";
  // evidence.verification === "failed": the model's proposed action was
  // objectively wrong. Whose fault turns on whether the model was supplied the
  // context it needed.
  switch (evidence.contextDelivery) {
    case "recorded_present":
      return "model_behavior";
    case "recorded_absent":
      return "retrieval";
    case "unrecorded":
      return "none";
  }
}
