import { describe, expect, it } from "vitest";
import type { GovernedLearningLesson, LearningDestination } from "./learning-event.js";
import {
  GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS,
  LESSON_DESTINATION_DISPOSITIONS,
  assessProductionAttributionDiscrimination,
  dispositionForDestination,
  summarizeLessonRouting,
} from "./lesson-routing.js";

function lesson(destinations: readonly LearningDestination[]): Pick<GovernedLearningLesson, "lessonId" | "destinations"> {
  return {
    lessonId: `lesson_${destinations.join("_")}`,
    destinations: destinations.map((destination) => ({ destination, rationale: "test" })),
  };
}

const ALL_DESTINATIONS = Object.keys(LESSON_DESTINATION_DISPOSITIONS) as LearningDestination[];

describe("lesson destination dispositions", () => {
  it("marks model_weight as the only destination a sink consumes", () => {
    const consuming = ALL_DESTINATIONS.filter((d) => dispositionForDestination(d) === "sink_consumes");
    expect(consuming).toEqual(["model_weight"]);
  });

  it("classifies no_action as the intentional terminal, never as a drop", () => {
    expect(dispositionForDestination("no_action")).toBe("terminal_no_action");
  });

  it("classifies every other destination as unrouted so the drop is not silent", () => {
    const unrouted = ALL_DESTINATIONS.filter((d) => dispositionForDestination(d) === "unrouted");
    // Ten sinkless destinations: the twelve minus model_weight (a sink) and
    // no_action (intentional terminal). `organization_memory` is among them — it is
    // named vocabulary with no sink. If a real sink is added without updating the
    // disposition map, this count changes and the test fails loudly.
    expect(unrouted.sort()).toEqual(
      ["calibration", "deterministic_recipe", "graph", "organization_memory", "parser", "product_logic", "prompt", "retrieval", "router_policy", "tooling"],
    );
  });

  it("names organization_memory as an unrouted destination, never a live route", () => {
    // The organization-memory destination exists as vocabulary (spec §17.4, ADR-0008)
    // but has no sink. This control dies if it is prematurely marked sink_consumes
    // without a real consumer — the "the route works" lie the doc warns against.
    expect(dispositionForDestination("organization_memory")).toBe("unrouted");
    const summary = summarizeLessonRouting(lesson(["organization_memory"]));
    expect(summary.reachedSink).toBe(false);
    expect(summary.wentNowhere).toBe(true);
  });

  it("counts a model_weight lesson as reaching a sink and not going nowhere", () => {
    const summary = summarizeLessonRouting(lesson(["model_weight"]));
    expect(summary.reachedSink).toBe(true);
    expect(summary.unroutedCount).toBe(0);
    expect(summary.wentNowhere).toBe(false);
  });

  it("counts a lesson routed to a sinkless destination as unrouted and gone nowhere", () => {
    // This is the control: a `retrieval` lesson today reaches no sink. If the
    // disposition map were weakened to hide that (marking it sink_consumes), this
    // assertion fails.
    const summary = summarizeLessonRouting(lesson(["retrieval"]));
    expect(summary.unrouted).toEqual(["retrieval"]);
    expect(summary.unroutedCount).toBe(1);
    expect(summary.reachedSink).toBe(false);
    expect(summary.wentNowhere).toBe(true);
  });

  it("does not count a pure no_action lesson as gone nowhere", () => {
    const summary = summarizeLessonRouting(lesson(["no_action"]));
    expect(summary.terminal).toEqual(["no_action"]);
    expect(summary.unroutedCount).toBe(0);
    expect(summary.wentNowhere).toBe(false);
  });
});

describe("production attribution discrimination", () => {
  it("reports no hardcoded-same-literal collapse (its narrow scope), NOT that the classifier discriminates", () => {
    // This detects ONLY the same-hardcoded-literal degeneracy, and neither producer
    // hardcodes, so it is false. It does NOT prove the classifier discriminates in
    // production — both producers feed the deriver a constant `not_verified` and
    // always emit `none`, a degeneracy this static check cannot see (see the
    // function's own doc and the module header). The values below are the honest
    // report of the narrow thing it measures.
    const assessment = assessProductionAttributionDiscrimination();
    expect(assessment.productionProducers).toBe(2);
    expect(assessment.hardcodedProductionProducers).toBe(0);
    expect(assessment.distinctProductionConstants).toEqual([]);
    expect(assessment.effectivelyConstant).toBe(false);
    expect(assessment.constant).toBeNull();
  });

  it("is not hardwired to false: an all-hardcoded-same registry still reports constant", () => {
    // Control that the assessment can still detect a genuine degeneracy, so
    // `effectivelyConstant: false` above reflects the code and is not a stuck value.
    const allHardcoded = GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS.map((entry) =>
      entry.role === "production"
        ? { ...entry, attributionSource: "hardcoded_constant" as const, constantValue: "model_behavior" as const }
        : entry,
    );
    const assessment = assessProductionAttributionDiscrimination(allHardcoded);
    expect(assessment.effectivelyConstant).toBe(true);
    expect(assessment.constant).toBe("model_behavior");
  });

  it("fails closed: a single non-hardcoded production producer means we cannot assert degeneracy", () => {
    const mixed = GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS.map((entry) => {
      if (entry.role !== "production") return entry;
      // Make transformer hardcoded so exactly one production producer is derived.
      return entry.producer === "apps/worker/src/transformer-governed-learning-producer.ts"
        ? { ...entry, attributionSource: "hardcoded_constant" as const, constantValue: "model_behavior" as const }
        : entry;
    });
    const assessment = assessProductionAttributionDiscrimination(mixed);
    expect(assessment.effectivelyConstant).toBe(false);
    expect(assessment.constant).toBeNull();
  });

  it("names the exact classification seam for each production producer", () => {
    const references = GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS.filter((e) => e.role === "production").map((e) => e.reference);
    expect(references).toEqual([
      "apps/worker/src/warden-learning-producer.ts:368",
      "apps/worker/src/transformer-governed-learning-producer.ts:161",
    ]);
  });
});
