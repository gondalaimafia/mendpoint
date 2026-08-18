/**
 * Phase 9 — Lesson classifier.
 *
 * Takes a validated failure (a diagnosed root-cause category from the eval
 * taxonomy plus its evidence) and produces its destination + rationale. Rules
 * are deterministic where the evidence supports them; where it does not, the
 * result is an explicit `unknown` that names the missing evidence rather than a
 * guessed destination.
 *
 * Input provenance: a validated failure originates from the failure→eval path
 * (`evals/regression/`, PR #184) and the eval graders (`evals/graders/`). We do
 * NOT import the regression schema (separately owned; reference by id via
 * `ValidatedFailure.id`) and we do NOT reinvent the failure taxonomy — we map
 * from the canonical `FailureCategory` in `../graders/taxonomy.js` (§31.7).
 */
import type { FailureCategory, Severity } from "../graders/taxonomy.js";
import { FAILURE_CATEGORIES } from "../graders/taxonomy.js";
import type { Product } from "../ground-truth/schema.js";
import type {
  DeterministicDestination,
  LessonClassification,
  NonTrainingIntervention,
  TrainingMethod,
  TrainingPrerequisites,
  WeightEligibleDestination,
} from "./destinations.js";
import { trainingPrerequisitesMet } from "./destinations.js";

/**
 * Evidence attached to a validated failure. Every field is auditable and drives
 * a deterministic branch; nothing here is a mood.
 */
export interface FailureEvidence {
  /**
   * The single most important signal: does the evidence indicate a DETERMINISTIC
   * engineering defect (a parser/graph/retriever/tool bug) rather than a genuine
   * model limit? When true, training is off the table even for a model-shaped
   * category. This is how the recall-79.3% class (systematically missed JSON
   * fixtures; per-language 0% recall) is kept from being trained around.
   */
  readonly deterministicDefectSuspected?: boolean;
  /**
   * For symptom categories (`FALSE_POSITIVE` / `FALSE_NEGATIVE`) the diagnosed
   * deeper root-cause category. Without it a symptom cannot be routed — the
   * classifier returns `unknown` rather than guessing.
   */
  readonly diagnosedCause?: FailureCategory;
  /** A capable alternative model exists to route to (enables the light router_policy fix). */
  readonly alternativeModelAvailable?: boolean;
  /** A reviewer expressed a SUBSTANTIVE product preference (not a cosmetic edit). */
  readonly substantivePreference?: boolean;
  /** Known-good prerequisite evidence for any weight-training route. */
  readonly training?: Partial<TrainingPrerequisites>;
  /** Human-auditable references (report lines, run ids, FAIL-/reg- ids). */
  readonly refs?: readonly string[];
}

/**
 * A validated failure to be classified. `category` is the diagnosed root-cause
 * category (a diagnosis pass is expected to have reclassified a raw
 * FALSE_POSITIVE/FALSE_NEGATIVE into a deeper cause where possible).
 */
export interface ValidatedFailure {
  /**
   * Reference by id to the source record — a `RegressionCase` id (`reg-...`) or a
   * `FAILURES.md` id (`FAIL-004`). We link, we do not embed the other team's schema.
   */
  readonly id: string;
  readonly category: FailureCategory;
  readonly severity?: Severity;
  readonly product?: Product;
  readonly evidence?: FailureEvidence;
}

/** How a category is handled. Discriminated on `kind`. */
type CategoryRule =
  | {
      readonly kind: "deterministic";
      readonly destination: DeterministicDestination;
      readonly intervention: NonTrainingIntervention;
      readonly why: string;
    }
  | {
      readonly kind: "weight_eligible";
      readonly destination: WeightEligibleDestination;
      readonly method: TrainingMethod;
      /** The lightest, non-weight fix to try before any training. */
      readonly lightFix: NonTrainingIntervention;
      readonly why: string;
    }
  | {
      readonly kind: "symptom";
      readonly why: string;
    };

/**
 * The TOTAL map from the canonical failure taxonomy to a destination rule.
 * `Record<FailureCategory, ...>` makes totality a compile-time guarantee: adding
 * a category to the taxonomy without handling it here fails to build. A runtime
 * test also enumerates `FAILURE_CATEGORIES` so the guarantee is double-locked.
 */
export const TAXONOMY_MAP: Record<FailureCategory, CategoryRule> = {
  // ---- Deterministic engineering defects. Off-limits to training. ----
  PARSING_FAILURE: {
    kind: "deterministic",
    destination: "TOOL_FAILURE",
    intervention: "parser",
    why: "A parser defect. Fix the parser; do not train a model to compensate (spec §17.4).",
  },
  LANGUAGE_SUPPORT_FAILURE: {
    kind: "deterministic",
    destination: "TOOL_FAILURE",
    intervention: "parser",
    why: "A language/indexer support gap. Extend the parser/indexer; not a model limit.",
  },
  REPOSITORY_MAPPING_FAILURE: {
    kind: "deterministic",
    destination: "GRAPH_FAILURE",
    intervention: "graph",
    why: "The repo was mapped into the graph incorrectly. Fix graph construction.",
  },
  ARCHITECTURE_INFERENCE_FAILURE: {
    kind: "deterministic",
    destination: "GRAPH_FAILURE",
    intervention: "graph",
    why: "Structure was reconstructed wrongly. Fix the deterministic extractor/graph.",
  },
  GRAPH_CONSTRUCTION_FAILURE: {
    kind: "deterministic",
    destination: "GRAPH_FAILURE",
    intervention: "graph",
    why: "The Change Graph mis-built an edge. Fix graph construction.",
  },
  DEPENDENCY_DISCOVERY_FAILURE: {
    kind: "deterministic",
    destination: "GRAPH_FAILURE",
    intervention: "graph",
    why: "A dependency edge was missed. Fix import/call-graph discovery.",
  },
  RETRIEVAL_FAILURE: {
    kind: "deterministic",
    destination: "MISSING_FACT",
    intervention: "retrieval",
    why: "The model never saw the required file. Fix retrieval; never post-train the fact.",
  },
  CONTEXT_SELECTION_FAILURE: {
    kind: "deterministic",
    destination: "CONTEXT_FAILURE",
    intervention: "retrieval",
    why: "Available context was not selected. Fix context assembly/selection.",
  },
  PROMPT_FAILURE: {
    kind: "deterministic",
    destination: "CONTEXT_FAILURE",
    intervention: "prompt",
    why: "The instruction/system policy was wrong. Fix the prompt, not the weights.",
  },
  TOOL_SELECTION_FAILURE: {
    kind: "deterministic",
    destination: "TOOL_FAILURE",
    intervention: "tooling",
    why: "The wrong tool was chosen. Fix the tool policy/FSM floor.",
  },
  TOOL_EXECUTION_FAILURE: {
    kind: "deterministic",
    destination: "TOOL_FAILURE",
    intervention: "tooling",
    why: "A tool failed or errored silently. Fix the tool.",
  },
  ROOT_CAUSE_FAILURE: {
    kind: "deterministic",
    destination: "HARNESS_FAILURE",
    intervention: "product_logic",
    why: "The deterministic diagnosis (regex/KB) was wrong. Fix the analyzer logic.",
  },
  BLAST_RADIUS_FAILURE: {
    kind: "deterministic",
    destination: "GRAPH_FAILURE",
    intervention: "graph",
    why: "Blast radius is graph reachability. Fix the graph, not a model.",
  },
  REMEDIATION_FAILURE: {
    kind: "deterministic",
    destination: "DETERMINISTIC_PATTERN",
    intervention: "deterministic_recipe",
    why: "A known remediation pattern was missing. Extend the recipe/rule table.",
  },
  PATCH_FAILURE: {
    kind: "deterministic",
    destination: "DETERMINISTIC_PATTERN",
    intervention: "deterministic_recipe",
    why: "A patch template was wrong/missing. Fix the deterministic transform.",
  },
  TEST_GENERATION_FAILURE: {
    kind: "deterministic",
    destination: "HARNESS_FAILURE",
    intervention: "product_logic",
    why: "Test files are read-only by design; a failure here is product logic, not a model gap.",
  },
  UX_PRESENTATION_FAILURE: {
    kind: "deterministic",
    destination: "HARNESS_FAILURE",
    intervention: "product_logic",
    why: "Presentation/assembly is deterministic. Fix the product logic.",
  },
  ABSTENTION_FAILURE: {
    kind: "deterministic",
    destination: "DETERMINISTIC_PATTERN",
    intervention: "product_logic",
    why: "Restraint/residual detection is a deterministic fail-closed check. Fix the detector; do not train it.",
  },
  SCALE_FAILURE: {
    kind: "deterministic",
    destination: "TOOL_FAILURE",
    intervention: "tooling",
    why: "The scanner degraded on a large repo. Fix the walker/caches; not a model target.",
  },
  ROBUSTNESS_FAILURE: {
    kind: "deterministic",
    destination: "TOOL_FAILURE",
    intervention: "tooling",
    why: "The scanner crashed on binary/non-UTF-8/symlink input. Harden the tool.",
  },
  COVERAGE_GAP: {
    kind: "deterministic",
    destination: "DETERMINISTIC_PATTERN",
    intervention: "deterministic_recipe",
    why: "No shipped recipe covers the family. Author the recipe; abstention-by-absence is correct until then.",
  },
  HARNESS_LIMITATION: {
    kind: "deterministic",
    destination: "HARNESS_FAILURE",
    intervention: "tooling",
    why: "The harness cannot observe the dimension. Extend the harness to measure it.",
  },

  // ---- Weight-eligible: a genuine model limit MAY be at play. Gated. ----
  MODEL_ROUTING_FAILURE: {
    kind: "weight_eligible",
    destination: "MODEL_LIMIT",
    method: "SFT",
    lightFix: "router_policy",
    why: "A capable model exists but was not routed to. Prefer a router-policy fix over training.",
  },
  MODEL_CAPABILITY_FAILURE: {
    kind: "weight_eligible",
    destination: "MODEL_LIMIT",
    method: "SFT",
    lightFix: "router_policy",
    why: "A genuine capability gap. Route to a stronger model if possible; else SFT/continued-pretrain when gates pass.",
  },
  CONFIDENCE_CALIBRATION_FAILURE: {
    kind: "weight_eligible",
    destination: "OUTPUT_BEHAVIOR",
    method: "SFT",
    lightFix: "calibration",
    why: "Confidence is miscalibrated. This is a statistical fit (calibration), not a training problem by default.",
  },
  REASONING_FAILURE: {
    kind: "weight_eligible",
    destination: "SPECIALIZED_REASONING",
    method: "RL",
    lightFix: "prompt",
    why: "Specialised reasoning gap. Try prompt/context first; RL only when reward and eval are trustworthy.",
  },
  PERFORMANCE_FAILURE: {
    kind: "weight_eligible",
    destination: "LATENCY_COST",
    method: "DISTILLATION",
    lightFix: "product_logic",
    why: "Too slow. Optimise the code or route first; distil only when the slow component is a model.",
  },
  COST_FAILURE: {
    kind: "weight_eligible",
    destination: "LATENCY_COST",
    method: "DISTILLATION",
    lightFix: "router_policy",
    why: "Too expensive. Route to a cheaper model first; distil only when justified.",
  },

  // ---- Symptom categories: need a diagnosed deeper cause, else unknown. ----
  FALSE_POSITIVE: {
    kind: "symptom",
    why: "A false positive is a symptom. Route it via its diagnosed deeper cause, never on its own.",
  },
  FALSE_NEGATIVE: {
    kind: "symptom",
    why: "A false negative is a symptom (often a parser/graph gap). Route it via its diagnosed deeper cause.",
  },
};

function unknown(
  f: ValidatedFailure,
  reason: string,
  missingEvidence: readonly string[],
): LessonClassification {
  return {
    route: "unknown",
    failureId: f.id,
    category: f.category,
    needsHuman: true,
    reason,
    missingEvidence,
  };
}

function resolvePrerequisites(ev: FailureEvidence | undefined): TrainingPrerequisites {
  const t = ev?.training ?? {};
  return {
    evalStable: t.evalStable ?? false,
    rewardTrustworthy: t.rewardTrustworthy ?? false,
    realPreferenceData: t.realPreferenceData ?? false,
    // Any suspected deterministic defect flips this false regardless of what the
    // caller asserted — the never-train-around-a-bug gate cannot be opted out of.
    notADeterministicDefect: (t.notADeterministicDefect ?? false) && ev?.deterministicDefectSuspected !== true,
    governedDataSufficient: t.governedDataSufficient ?? false,
  };
}

/**
 * Classify a validated failure into its destination.
 *
 * The order of operations encodes the policy:
 *   1. A suspected deterministic defect can never become a training route.
 *   2. A substantive, real preference signal routes to preference tuning; a
 *      cosmetic reviewer edit routes to no_action (never trains).
 *   3. Symptom categories require a diagnosed cause, else `unknown`.
 *   4. Deterministic categories route to their engineering fix.
 *   5. Weight-eligible categories take the LIGHTEST justified intervention:
 *      a non-weight fix when one applies, weight training only when its
 *      prerequisites are proven, `unknown` when neither can be justified.
 */
export function classify(f: ValidatedFailure, _depth = 0): LessonClassification {
  const ev = f.evidence;
  const refs = ev?.refs ?? [];
  const rule = TAXONOMY_MAP[f.category];

  // (2) Preference signal — handled before the taxonomy so a reviewer preference
  // is routed by what the data IS, not by the symptom category it rode in on.
  if (ev?.substantivePreference === true) {
    if (ev.deterministicDefectSuspected === true) {
      return unknown(
        f,
        "a preference was expressed but the evidence indicates a deterministic defect; fix the defect, do not preference-tune around it",
        ["deterministic root-cause diagnosis"],
      );
    }
    const prereq = resolvePrerequisites(ev);
    const { ok, missing } = trainingPrerequisitesMet("PREFERENCE_TUNING", prereq);
    if (!prereq.realPreferenceData) {
      return {
        route: "no_action",
        failureId: f.id,
        category: f.category,
        rationale:
          "reviewer edits are cosmetic, not preference data; preference tuning requires real preference data (spec §17.4). No training.",
      };
    }
    if (!ok) {
      return unknown(
        f,
        "preference tuning is indicated but its prerequisites are unproven; refusing to train on faith",
        missing,
      );
    }
    return {
      route: "model_training",
      destination: "PREFERENCE",
      intervention: "model_weight",
      method: "PREFERENCE_TUNING",
      prerequisites: prereq,
      failureId: f.id,
      category: f.category,
      rationale: "Product taste with real preference data. Preference tuning is justified.",
      evidenceRefs: refs,
    };
  }

  if (rule.kind === "symptom") {
    // (3) A symptom must be diagnosed to a deeper cause; we refuse to guess.
    const cause = ev?.diagnosedCause;
    if (!cause || cause === f.category || _depth > 2) {
      return unknown(
        f,
        `${f.category} is a symptom; it needs a diagnosed deeper root-cause category before it can be routed`,
        ["evidence.diagnosedCause"],
      );
    }
    // Re-classify against the diagnosed cause, carrying the rest of the evidence.
    return classify(
      { ...f, category: cause, evidence: { ...ev, diagnosedCause: undefined } },
      _depth + 1,
    );
  }

  if (rule.kind === "deterministic") {
    return {
      route: "deterministic_fix",
      destination: rule.destination,
      intervention: rule.intervention,
      failureId: f.id,
      category: f.category,
      rationale: rule.why,
      evidenceRefs: refs,
    };
  }

  // rule.kind === "weight_eligible"
  // (1) Never train around a suspected deterministic bug, even for a model category.
  if (ev?.deterministicDefectSuspected === true) {
    return unknown(
      f,
      `${f.category} looks model-shaped but the evidence indicates a deterministic engineering defect; diagnose and fix it deterministically rather than training around it`,
      ["deterministic root-cause diagnosis (parser/graph/retriever/tool)"],
    );
  }

  // (5) Prefer the lightest justified intervention: a non-weight fix first.
  const lightApplies =
    rule.lightFix === "router_policy" ? ev?.alternativeModelAvailable === true : true;
  if (lightApplies) {
    return {
      route: "non_training_fix",
      destination: rule.destination,
      intervention: rule.lightFix,
      failureId: f.id,
      category: f.category,
      rationale: `${rule.why} Lightest justified fix: ${rule.lightFix}.`,
      evidenceRefs: refs,
    };
  }

  // No non-weight fix applies; weight training is the only remaining lever — and
  // it is allowed only when its prerequisites are proven.
  const prereq = resolvePrerequisites(ev);
  const { ok, missing } = trainingPrerequisitesMet(rule.method, prereq);
  if (!ok) {
    return unknown(
      f,
      `${f.category}: no non-weight fix applies and ${rule.method} prerequisites are unproven; refusing to train on faith`,
      missing.map(String),
    );
  }
  return {
    route: "model_training",
    destination: rule.destination,
    intervention: "model_weight",
    method: rule.method,
    prerequisites: prereq,
    failureId: f.id,
    category: f.category,
    rationale: `${rule.why} Non-weight fixes exhausted and prerequisites proven; ${rule.method} is justified.`,
    evidenceRefs: refs,
  };
}

/** All failure categories, for exhaustiveness tests and tooling. */
export const ALL_FAILURE_CATEGORIES: readonly FailureCategory[] = FAILURE_CATEGORIES;
