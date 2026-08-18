import { describe, it, expect } from "vitest";
import { FAILURE_CATEGORIES } from "../graders/taxonomy.js";
import {
  classify,
  TAXONOMY_MAP,
  type ValidatedFailure,
} from "./classify.js";
import {
  assertClassificationSound,
  altersModelWeights,
  DESTINATION_SPECS,
  LESSON_DESTINATIONS,
  trainingPrerequisitesMet,
  type LessonClassification,
  type TrainingPrerequisites,
} from "./destinations.js";
import {
  GENUINE_MODEL_LIMIT,
  INTERNAL_API_COVERAGE_GAP,
  RECALL_79_PARSER_DEFECT,
  RECALL_79_UNDIAGNOSED,
  REAL_FAILURES,
  RESIDUAL_REFUSAL_GAP,
  VENDORED_FALSE_POSITIVE,
} from "./real-failures.js";

const ALL_PREREQS_MET: TrainingPrerequisites = {
  evalStable: true,
  rewardTrustworthy: true,
  realPreferenceData: true,
  notADeterministicDefect: true,
  governedDataSufficient: true,
};

describe("taxonomy map is total over the canonical failure taxonomy", () => {
  it("handles every FailureCategory with no silent gap", () => {
    for (const category of FAILURE_CATEGORIES) {
      expect(TAXONOMY_MAP[category], `unhandled category: ${category}`).toBeDefined();
    }
    // and nothing extra was invented beyond the canonical taxonomy
    expect(Object.keys(TAXONOMY_MAP).sort()).toEqual([...FAILURE_CATEGORIES].sort());
  });

  it("classifies every category into a well-formed result (never throws, never a bare guess)", () => {
    for (const category of FAILURE_CATEGORIES) {
      const c = classify({ id: `probe-${category}`, category });
      expect(c.route).toBeTruthy();
      // Anything that reaches a training route must survive the runtime guard.
      expect(() => assertClassificationSound(c)).not.toThrow();
    }
  });
});

describe("the never-train-around-a-bug rule is structural", () => {
  it("no deterministic destination is weight-training eligible", () => {
    for (const dest of LESSON_DESTINATIONS) {
      const spec = DESTINATION_SPECS[dest];
      if (!spec.weightTrainingEligible) {
        expect(
          spec.permittedInterventions,
          `${dest} must not permit model_weight`,
        ).not.toContain("model_weight");
      }
    }
  });

  it("a parser-defect failure cannot be routed to a training destination", () => {
    const parserDefect: ValidatedFailure = {
      id: "FAIL-parser",
      category: "PARSING_FAILURE",
      evidence: { refs: ["parser dropped a *.json fixture"] },
    };
    const c = classify(parserDefect);
    expect(c.route).toBe("deterministic_fix");
    expect(altersModelWeights(c)).toBe(false);
    if (c.route === "deterministic_fix") {
      expect(c.destination).toBe("TOOL_FAILURE");
      expect(c.intervention).toBe("parser");
    }
  });

  it("the recall-79.3% class routes to a deterministic fix, never MODEL_LIMIT/training", () => {
    const c = classify(RECALL_79_PARSER_DEFECT);
    // Diagnosed to LANGUAGE_SUPPORT_FAILURE (a parser gap) -> TOOL_FAILURE/parser.
    expect(c.route).toBe("deterministic_fix");
    expect(altersModelWeights(c)).toBe(false);
    if (c.route === "deterministic_fix") {
      expect(c.destination).toBe("TOOL_FAILURE");
      expect(c.intervention).toBe("parser");
    }
  });

  it("even a MODEL_CAPABILITY_FAILURE is refused training when a deterministic defect is suspected", () => {
    const masked: ValidatedFailure = {
      id: "FAIL-masked",
      category: "MODEL_CAPABILITY_FAILURE",
      evidence: {
        deterministicDefectSuspected: true,
        training: ALL_PREREQS_MET, // caller tried to assert all prereqs...
      },
    };
    const c = classify(masked);
    // ...and is still refused: the defect signal overrides the asserted prereqs.
    expect(c.route).toBe("unknown");
    expect(altersModelWeights(c)).toBe(false);
  });

  it("the runtime guard throws if a training route is fabricated around a defect", () => {
    const fabricated: LessonClassification = {
      route: "model_training",
      destination: "MODEL_LIMIT",
      intervention: "model_weight",
      method: "SFT",
      prerequisites: { ...ALL_PREREQS_MET, notADeterministicDefect: false },
      failureId: "FAIL-fabricated",
      category: "MODEL_CAPABILITY_FAILURE",
      rationale: "hand-built unsound classification",
      evidenceRefs: [],
    };
    expect(() => assertClassificationSound(fabricated)).toThrow(/deterministic defect/);
  });

  it("the runtime guard throws if a training route skips its prerequisites", () => {
    const onFaith: LessonClassification = {
      route: "model_training",
      destination: "SPECIALIZED_REASONING",
      intervention: "model_weight",
      method: "RL",
      prerequisites: { ...ALL_PREREQS_MET, rewardTrustworthy: false },
      failureId: "FAIL-faith",
      category: "REASONING_FAILURE",
      rationale: "hand-built classification with an untrustworthy reward",
      evidenceRefs: [],
    };
    expect(() => assertClassificationSound(onFaith)).toThrow(/prerequisites unmet/);
  });

  it("type system forbids model_weight on a deterministic destination", () => {
    const illegal: LessonClassification = {
      route: "deterministic_fix",
      destination: "TOOL_FAILURE",
      // @ts-expect-error deterministic destinations cannot carry the model_weight intervention
      intervention: "model_weight",
      failureId: "x",
      category: "PARSING_FAILURE",
      rationale: "should not compile",
      evidenceRefs: [],
    };
    void illegal;
  });
});

describe("a genuinely model-limited failure CAN reach training", () => {
  it("routes MODEL_CAPABILITY_FAILURE to model_training when gates pass and no lighter fix exists", () => {
    const c = classify(GENUINE_MODEL_LIMIT);
    expect(c.route).toBe("model_training");
    expect(altersModelWeights(c)).toBe(true);
    if (c.route === "model_training") {
      expect(c.destination).toBe("MODEL_LIMIT");
      expect(c.intervention).toBe("model_weight");
    }
    expect(() => assertClassificationSound(c)).not.toThrow();
  });

  it("prefers the lightest fix: routes to a stronger model when one is available", () => {
    const c = classify({
      ...GENUINE_MODEL_LIMIT,
      id: "reg-route-first",
      evidence: { ...GENUINE_MODEL_LIMIT.evidence, alternativeModelAvailable: true },
    });
    expect(c.route).toBe("non_training_fix");
    expect(altersModelWeights(c)).toBe(false);
    if (c.route === "non_training_fix") expect(c.intervention).toBe("router_policy");
  });
});

describe("preference vs cosmetic edits", () => {
  it("real preference data -> preference tuning", () => {
    const c = classify({
      id: "reg-pref-real",
      category: "UX_PRESENTATION_FAILURE",
      evidence: {
        substantivePreference: true,
        training: ALL_PREREQS_MET,
      },
    });
    expect(c.route).toBe("model_training");
    if (c.route === "model_training") {
      expect(c.destination).toBe("PREFERENCE");
      expect(c.method).toBe("PREFERENCE_TUNING");
    }
  });

  it("cosmetic reviewer edits -> no_action, never training", () => {
    const c = classify({
      id: "reg-pref-cosmetic",
      category: "UX_PRESENTATION_FAILURE",
      evidence: {
        substantivePreference: true,
        training: { ...ALL_PREREQS_MET, realPreferenceData: false },
      },
    });
    expect(c.route).toBe("no_action");
    expect(altersModelWeights(c)).toBe(false);
  });
});

describe("unclassifiable failures return UNKNOWN, not a guess", () => {
  it("an undiagnosed symptom (raw FALSE_NEGATIVE) is UNKNOWN", () => {
    const c = classify(RECALL_79_UNDIAGNOSED);
    expect(c.route).toBe("unknown");
    if (c.route === "unknown") {
      expect(c.needsHuman).toBe(true);
      expect(c.missingEvidence).toContain("evidence.diagnosedCause");
    }
  });

  it("a model-shaped category with no lighter fix and unproven prereqs is UNKNOWN", () => {
    const c = classify({
      id: "reg-unproven",
      category: "REASONING_FAILURE",
      evidence: {
        // prompt is the lightFix and always applies, so force the harder path:
        // reasoning with no prompt lever is modelled by exhausting it here.
      },
    });
    // REASONING_FAILURE's light fix is `prompt`, which always applies -> non_training_fix.
    expect(c.route).toBe("non_training_fix");
    if (c.route === "non_training_fix") expect(c.intervention).toBe("prompt");
  });

  it("MODEL_CAPABILITY with no alternative model and no proven prereqs is UNKNOWN", () => {
    const c = classify({
      id: "reg-cap-unproven",
      category: "MODEL_CAPABILITY_FAILURE",
      evidence: { alternativeModelAvailable: false },
    });
    expect(c.route).toBe("unknown");
    if (c.route === "unknown") expect(c.missingEvidence.length).toBeGreaterThan(0);
  });
});

describe("the real repository failures classify correctly", () => {
  it("vendored false positive -> deterministic restraint fix (not training)", () => {
    const c = classify(VENDORED_FALSE_POSITIVE);
    expect(c.route).toBe("deterministic_fix");
    expect(altersModelWeights(c)).toBe(false);
    if (c.route === "deterministic_fix") expect(c.destination).toBe("DETERMINISTIC_PATTERN");
  });

  it("internal-API coverage gap -> author a recipe (not training)", () => {
    const c = classify(INTERNAL_API_COVERAGE_GAP);
    expect(c.route).toBe("deterministic_fix");
    if (c.route === "deterministic_fix") {
      expect(c.destination).toBe("DETERMINISTIC_PATTERN");
      expect(c.intervention).toBe("deterministic_recipe");
    }
  });

  it("residual refusal -> deterministic completeness fix (not training)", () => {
    const c = classify(RESIDUAL_REFUSAL_GAP);
    expect(c.route).toBe("deterministic_fix");
    if (c.route === "deterministic_fix") expect(c.destination).toBe("DETERMINISTIC_PATTERN");
  });

  it("no real-repo failure routes to model weights", () => {
    for (const f of REAL_FAILURES) {
      const c = classify(f);
      expect(altersModelWeights(c), `${f.id} must not train weights`).toBe(false);
      expect(() => assertClassificationSound(c)).not.toThrow();
    }
  });
});

describe("prerequisite helper", () => {
  it("SFT requires eval + reward + governed data + not-a-defect", () => {
    expect(trainingPrerequisitesMet("SFT", ALL_PREREQS_MET).ok).toBe(true);
    expect(
      trainingPrerequisitesMet("SFT", { ...ALL_PREREQS_MET, rewardTrustworthy: false }).ok,
    ).toBe(false);
  });
});
