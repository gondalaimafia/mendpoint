/**
 * Phase 9 — Lesson destination taxonomy and the structural never-train-around-a-bug guard.
 *
 * A validated failure has a DESTINATION: the lightest intervention that actually
 * fixes it. This module defines the eleven destinations, the intervention each
 * routes to, and — the point of the phase — makes it *structurally impossible*
 * to route a deterministic engineering defect to model training.
 *
 * The improvement policy (spec §17.4, and OWN_VS_RENT.md §T4/§T7/§T12):
 *   - missing facts        → retrieval / graph / memory   (NEVER post-train a fact)
 *   - wrong/unstable output → SFT, when justified
 *   - product taste        → preference tuning, only with REAL preference data
 *   - specialised capability → RL, only when reward + eval are trustworthy
 *   - too slow / expensive  → distillation (or route to another model)
 *   - deterministic repeat  → a recipe / rules / program transformation, NOT a model
 *   - a deterministic bug   → FIX THE BUG. Parser broken → fix the parser. Graph
 *     misses an import → fix the graph. Retriever omitted a file → fix retrieval.
 *     Tool failed silently → fix the tool. This class is off-limits to training.
 *
 * The intervention vocabulary is NOT reinvented here: it is the canonical
 * §17.4 `LearningDestination` owned by Codex in `packages/pipeline`. We derive
 * the training / non-training partitions from it with `Extract`/`Exclude`, so if
 * that canonical union changes, this file follows (or fails to compile, which is
 * the intended signal). §31.7: no duplicate canonical implementation.
 */
import type { LearningDestination } from "@mendpoint/pipeline";

/**
 * The canonical improvement-target vocabulary (spec §17.4), re-exported under a
 * local name for readability. Single source of truth: `@mendpoint/pipeline`.
 */
export type Intervention = LearningDestination;

/**
 * The one intervention that alters model weights. SFT, RL, preference tuning and
 * distillation all land here — they all produce new weights. This is the lever
 * the never-train-around-a-bug rule fences off.
 */
export type WeightTrainingIntervention = Extract<Intervention, "model_weight">;

/** Every intervention that does NOT alter model weights. */
export type NonTrainingIntervention = Exclude<Intervention, "model_weight">;

/**
 * If the canonical union ever stops containing "model_weight", these become
 * `never` and every construction site below fails to compile. That is the
 * anti-drift tripwire, encoded in the type system rather than a comment.
 */
type _AssertWeightInterventionExists = WeightTrainingIntervention extends never
  ? "ERROR: canonical LearningDestination no longer contains 'model_weight'"
  : true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertWeightInterventionExists: _AssertWeightInterventionExists = true;

/** The eleven lesson destinations (the program's taxonomy). */
export const LESSON_DESTINATIONS = [
  "MISSING_FACT",
  "CONTEXT_FAILURE",
  "HARNESS_FAILURE",
  "TOOL_FAILURE",
  "GRAPH_FAILURE",
  "OUTPUT_BEHAVIOR",
  "PREFERENCE",
  "SPECIALIZED_REASONING",
  "LATENCY_COST",
  "DETERMINISTIC_PATTERN",
  "MODEL_LIMIT",
] as const;

export type LessonDestination = (typeof LESSON_DESTINATIONS)[number];

/**
 * Destinations whose fix is a deterministic engineering change. Weight training
 * is NOT a permitted intervention for any of them — that exclusion is enforced
 * below at the type level, not by convention.
 */
export type DeterministicDestination =
  | "MISSING_FACT"
  | "CONTEXT_FAILURE"
  | "HARNESS_FAILURE"
  | "TOOL_FAILURE"
  | "GRAPH_FAILURE"
  | "DETERMINISTIC_PATTERN";

/**
 * Destinations where a genuine model limit is on the table, so weight training
 * MAY (subject to gates) be the right lever. Even here the classifier prefers
 * the lightest justified fix and refuses to train without prerequisites.
 */
export type WeightEligibleDestination =
  | "OUTPUT_BEHAVIOR"
  | "PREFERENCE"
  | "SPECIALIZED_REASONING"
  | "LATENCY_COST"
  | "MODEL_LIMIT";

/** The two partitions must exactly tile the eleven destinations. */
type _AssertDestinationPartition =
  DeterministicDestination | WeightEligibleDestination extends LessonDestination
    ? LessonDestination extends DeterministicDestination | WeightEligibleDestination
      ? true
      : "ERROR: some LessonDestination is in neither partition"
    : "ERROR: a partition names a destination that does not exist";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertDestinationPartition: _AssertDestinationPartition = true;

/** A weight-training method. Each is a distinct kind of weight change. */
export type TrainingMethod =
  | "SFT"
  | "PREFERENCE_TUNING"
  | "RL"
  | "DISTILLATION"
  | "CONTINUED_PRETRAIN";

/**
 * The evidence that must exist before weight training is allowed. Every field is
 * a claim about the data, not a knob to flip on faith: the classifier only emits
 * a `model_training` route when the method's required subset is proven.
 */
export interface TrainingPrerequisites {
  /** The eval is stable enough to detect a regression the training might cause. */
  readonly evalStable: boolean;
  /** The reward / label the training optimises against is trustworthy. */
  readonly rewardTrustworthy: boolean;
  /** Real preference data exists (NOT cosmetic reviewer edits). */
  readonly realPreferenceData: boolean;
  /**
   * The failure is NOT a deterministic engineering defect wearing a model
   * costume. This is the never-train-around-a-bug gate.
   */
  readonly notADeterministicDefect: boolean;
  /** Enough governed, consented examples exist to train on. */
  readonly governedDataSufficient: boolean;
}

/** Which prerequisites each training method requires. */
export function requiredPrerequisites(
  method: TrainingMethod,
): ReadonlyArray<keyof TrainingPrerequisites> {
  switch (method) {
    case "SFT":
      return ["notADeterministicDefect", "governedDataSufficient", "evalStable", "rewardTrustworthy"];
    case "RL":
      return ["notADeterministicDefect", "governedDataSufficient", "evalStable", "rewardTrustworthy"];
    case "PREFERENCE_TUNING":
      return ["notADeterministicDefect", "governedDataSufficient", "realPreferenceData"];
    case "DISTILLATION":
      return ["notADeterministicDefect", "governedDataSufficient", "evalStable"];
    case "CONTINUED_PRETRAIN":
      return ["notADeterministicDefect", "governedDataSufficient"];
  }
}

/** Are the method's prerequisites all satisfied? Returns the unmet ones. */
export function trainingPrerequisitesMet(
  method: TrainingMethod,
  p: TrainingPrerequisites,
): { ok: boolean; missing: ReadonlyArray<keyof TrainingPrerequisites> } {
  const missing = requiredPrerequisites(method).filter((k) => !p[k]);
  return { ok: missing.length === 0, missing };
}

/**
 * A destination's static contract: whether weight training is even eligible, the
 * interventions it permits, and the one-line policy that governs it.
 */
export interface DestinationSpec {
  readonly destination: LessonDestination;
  readonly weightTrainingEligible: boolean;
  readonly permittedInterventions: readonly Intervention[];
  readonly policy: string;
}

export const DESTINATION_SPECS: Record<LessonDestination, DestinationSpec> = {
  MISSING_FACT: {
    destination: "MISSING_FACT",
    weightTrainingEligible: false,
    permittedInterventions: ["retrieval", "graph"],
    policy: "A fact was missing from context. Fix retrieval/graph/memory. Never post-train a fact.",
  },
  CONTEXT_FAILURE: {
    destination: "CONTEXT_FAILURE",
    weightTrainingEligible: false,
    permittedInterventions: ["retrieval", "prompt"],
    policy: "The right context was available but not assembled/selected. Fix context assembly or the prompt.",
  },
  HARNESS_FAILURE: {
    destination: "HARNESS_FAILURE",
    weightTrainingEligible: false,
    permittedInterventions: ["tooling", "product_logic"],
    policy: "The harness or product surface failed or could not observe the dimension. Fix the harness/product logic.",
  },
  TOOL_FAILURE: {
    destination: "TOOL_FAILURE",
    weightTrainingEligible: false,
    permittedInterventions: ["tooling", "parser"],
    policy: "A deterministic tool/parser failed. Fix the tool or parser. Not a model target.",
  },
  GRAPH_FAILURE: {
    destination: "GRAPH_FAILURE",
    weightTrainingEligible: false,
    permittedInterventions: ["graph"],
    policy: "The Change Graph missed or mis-built an edge. Fix graph construction. Not a model target.",
  },
  DETERMINISTIC_PATTERN: {
    destination: "DETERMINISTIC_PATTERN",
    weightTrainingEligible: false,
    permittedInterventions: ["deterministic_recipe", "product_logic"],
    policy: "A repeated deterministic transformation. Encode a recipe/rule/program transform, not a model.",
  },
  OUTPUT_BEHAVIOR: {
    destination: "OUTPUT_BEHAVIOR",
    weightTrainingEligible: true,
    permittedInterventions: ["calibration", "prompt", "model_weight"],
    policy: "Wrong output format or unstable behaviour. Prefer calibration/prompt; SFT only when justified.",
  },
  PREFERENCE: {
    destination: "PREFERENCE",
    weightTrainingEligible: true,
    permittedInterventions: ["model_weight"],
    policy: "Product taste. Preference tuning only with real preference data, never cosmetic reviewer edits.",
  },
  SPECIALIZED_REASONING: {
    destination: "SPECIALIZED_REASONING",
    weightTrainingEligible: true,
    permittedInterventions: ["prompt", "model_weight"],
    policy: "Specialised domain capability. Try prompt/context first; RL only when reward and eval are trustworthy.",
  },
  LATENCY_COST: {
    destination: "LATENCY_COST",
    weightTrainingEligible: true,
    permittedInterventions: ["router_policy", "product_logic", "model_weight"],
    policy: "Too slow or too expensive. Prefer routing/product_logic; distillation only when the slow part is a model.",
  },
  MODEL_LIMIT: {
    destination: "MODEL_LIMIT",
    weightTrainingEligible: true,
    permittedInterventions: ["router_policy", "model_weight"],
    policy: "A genuine model limit. Prefer routing to a capable model; SFT/continued-pretrain only when gates pass.",
  },
};

/**
 * A classified destination for a validated failure. Discriminated on `route`.
 *
 * The structural guard lives in these field types:
 *   - `model_weight` (WeightTrainingIntervention) appears ONLY in `ModelTraining`.
 *   - `ModelTraining.destination` is a `WeightEligibleDestination`, so a
 *     DeterministicDestination (TOOL/GRAPH/MISSING_FACT/CONTEXT/HARNESS/
 *     DETERMINISTIC_PATTERN) can never be represented as a training route.
 *   - `DeterministicFix.intervention` and `NonTrainingFix.intervention` are
 *     `NonTrainingIntervention`, so `model_weight` is unassignable there.
 * A parser defect can therefore never be spelled as "train a model" — it is a
 * type error, caught at compile time, not a lint someone can ignore.
 */
export interface DeterministicFix {
  readonly route: "deterministic_fix";
  readonly destination: DeterministicDestination;
  readonly intervention: NonTrainingIntervention;
  readonly failureId: string;
  readonly category: string;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}

export interface NonTrainingFix {
  readonly route: "non_training_fix";
  readonly destination: WeightEligibleDestination;
  readonly intervention: NonTrainingIntervention;
  readonly failureId: string;
  readonly category: string;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}

export interface ModelTraining {
  readonly route: "model_training";
  readonly destination: WeightEligibleDestination;
  readonly intervention: WeightTrainingIntervention;
  readonly method: TrainingMethod;
  readonly prerequisites: TrainingPrerequisites;
  readonly failureId: string;
  readonly category: string;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}

export interface NoAction {
  readonly route: "no_action";
  readonly failureId: string;
  readonly category: string;
  readonly rationale: string;
}

export interface UnknownClassification {
  readonly route: "unknown";
  readonly failureId: string;
  readonly category: string;
  readonly needsHuman: true;
  readonly reason: string;
  readonly missingEvidence: readonly string[];
}

export type LessonClassification =
  | DeterministicFix
  | NonTrainingFix
  | ModelTraining
  | NoAction
  | UnknownClassification;

/** Does this classification alter model weights? */
export function altersModelWeights(c: LessonClassification): boolean {
  return c.route === "model_training";
}

/**
 * Runtime validated-transition guard. The types already make an unsound
 * classification unspellable in normal code; this is the belt-and-suspenders
 * check that also holds against `as any`, JSON round-trips, and future edits.
 * Throws on any classification that violates the never-train-around-a-bug rule
 * or emits a training route without satisfied prerequisites.
 */
export function assertClassificationSound(c: LessonClassification): void {
  if (c.route !== "model_training") return;

  if (DESTINATION_SPECS[c.destination].weightTrainingEligible !== true) {
    throw new Error(
      `unsound classification for ${c.failureId}: model_training targets ${c.destination}, which is not weight-training eligible`,
    );
  }
  // Cast through string: the static type is already the `model_weight` literal,
  // so this guards only the `as any` / JSON-round-trip path, not normal code.
  if ((c.intervention as string) !== "model_weight") {
    throw new Error(
      `unsound classification for ${c.failureId}: model_training must use the model_weight intervention`,
    );
  }
  if (!c.prerequisites.notADeterministicDefect) {
    throw new Error(
      `refusing to train around a deterministic defect for ${c.failureId}: fix the parser/graph/retriever/tool instead`,
    );
  }
  const { ok, missing } = trainingPrerequisitesMet(c.method, c.prerequisites);
  if (!ok) {
    throw new Error(
      `refusing to train on faith for ${c.failureId}: ${c.method} prerequisites unmet: ${missing.join(", ")}`,
    );
  }
}
