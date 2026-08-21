// Lesson routing observability.
//
// The lesson classifier (`classify` in `learning-event.ts`) assigns every
// validated lesson to a `LearningDestination`. Exactly one of those eleven
// destinations — `model_weight` — is actually consumed downstream: the governed
// training corpus reads it at `learning-operations.ts:707`. A lesson classified
// to any of the other ten is computed, stored on the lesson object, and then
// consumed by nothing. Historically that drop was silent: "we routed this
// lesson to `retrieval`" and "nothing acted on this lesson" were indistinguishable.
//
// This module names the drop so it becomes observable and countable, following
// the house pattern of `classifyGraphContextDelivery`
// (`apps/worker/src/warden-learning-producer.ts:94-140`), which keeps "no context
// was supplied" distinguishable from "we captured nothing". Two facts are made
// visible here:
//
//   1. Per lesson: which of its destinations reach a sink, which are the
//      intentional `no_action` terminal, and which are UNROUTED — classified to a
//      destination nothing consumes (`summarizeLessonRouting`).
//   2. Across the pipeline: that in production the classifier is effectively a
//      CONSTANT function, because every governed-learning producer hardcodes
//      `attribution: "model_behavior"` rather than deriving it from the observed
//      outcome (`assessProductionAttributionDiscrimination`). This is the more
//      important number: without it, a reader of the eleven-destination taxonomy
//      would believe the system discriminates before routing. It does not, yet.
//
// See `docs/learning/LESSON_DESTINATION_ROUTING.md` for what each count means, the
// two-taxonomy layering decision, and the upstream blocker that must be closed
// before Organization Memory can be fed from this pipeline.

import type { GovernedLearningLesson, LearningDestination, LearningOutcomeAttribution } from "./learning-event.js";

/**
 * The honest three-state disposition of a single lesson destination. A null
 * disposition is never inferred: every `LearningDestination` maps to exactly one
 * of these, and "we did not act on this" (`unrouted`) can never be read as
 * "there was nothing to act on" (`terminal_no_action`).
 */
export type LessonDestinationDisposition =
  // A downstream sink actually consumes lessons at this destination.
  | "sink_consumes"
  // `no_action`: the classifier intentionally routed nowhere. Not a drop.
  | "terminal_no_action"
  // Classified here, but nothing consumes it. The formerly-silent drop, now named.
  | "unrouted";

/**
 * Source of truth for which destinations have a real downstream sink.
 *
 * A destination may be marked `sink_consumes` ONLY when a consumer genuinely reads
 * it. Today that is `model_weight` alone, consumed by the governed training corpus
 * (`learning-operations.ts:707`). When a real sink is added for another
 * destination, flip its entry here in the same change that adds the consumer — and
 * never the other way round. Over-reporting a drop (leaving a newly-sunk
 * destination as `unrouted`) is merely noisy; under-reporting one (marking an
 * unconsumed destination `sink_consumes`) re-hides the drop, so the map is
 * deliberately conservative and fails toward visibility.
 */
export const LESSON_DESTINATION_DISPOSITIONS: Readonly<Record<LearningDestination, LessonDestinationDisposition>> =
  Object.freeze({
    model_weight: "sink_consumes",
    no_action: "terminal_no_action",
    router_policy: "unrouted",
    retrieval: "unrouted",
    graph: "unrouted",
    parser: "unrouted",
    tooling: "unrouted",
    deterministic_recipe: "unrouted",
    prompt: "unrouted",
    product_logic: "unrouted",
    calibration: "unrouted",
  });

/** The disposition of a single destination. Total: every destination has one. */
export function dispositionForDestination(destination: LearningDestination): LessonDestinationDisposition {
  return LESSON_DESTINATION_DISPOSITIONS[destination];
}

/**
 * A countable routing summary for one lesson. `wentNowhere` is the per-lesson
 * signal an operator counts to answer "how many lessons did we classify and then
 * drop?" — it is true only when the lesson reached no sink AND was not the
 * intentional `no_action` terminal.
 */
export type LessonRoutingSummary = Readonly<{
  lessonId: string;
  sinkConsumes: readonly LearningDestination[];
  terminal: readonly LearningDestination[];
  unrouted: readonly LearningDestination[];
  unroutedCount: number;
  reachedSink: boolean;
  wentNowhere: boolean;
}>;

/**
 * Classify where a lesson's destinations actually go. Pure and total; derives the
 * disposition of every destination on the lesson and partitions them. Does not
 * mutate the lesson or depend on any external state, so a monitor can call it on a
 * stream of lessons and sum `unroutedCount` / count `wentNowhere` without side
 * effects.
 */
export function summarizeLessonRouting(
  lesson: Pick<GovernedLearningLesson, "lessonId" | "destinations">,
): LessonRoutingSummary {
  const sinkConsumes: LearningDestination[] = [];
  const terminal: LearningDestination[] = [];
  const unrouted: LearningDestination[] = [];
  for (const { destination } of lesson.destinations) {
    switch (dispositionForDestination(destination)) {
      case "sink_consumes":
        sinkConsumes.push(destination);
        break;
      case "terminal_no_action":
        terminal.push(destination);
        break;
      case "unrouted":
        unrouted.push(destination);
        break;
    }
  }
  const reachedSink = sinkConsumes.length > 0;
  return Object.freeze({
    lessonId: lesson.lessonId,
    sinkConsumes: Object.freeze(sinkConsumes),
    terminal: Object.freeze(terminal),
    unrouted: Object.freeze(unrouted),
    unroutedCount: unrouted.length,
    reachedSink,
    // Classified to a destination nothing consumes, and reached no sink at all.
    // A lesson that is purely `no_action` did not go nowhere by accident; it was
    // intentionally routed nowhere, so it is not counted here.
    wentNowhere: !reachedSink && unrouted.length > 0,
  });
}

/** How a governed-learning producer decides the outcome `attribution` it emits. */
export type ProducerAttributionSource =
  // The producer emits a compile-time constant, ignoring what actually happened.
  | "hardcoded_constant"
  // The producer forwards an attribution chosen by its caller.
  | "caller_supplied";

/**
 * A governed-learning producer and how it sets `observedOutcome.attribution`.
 * `reference` is the exact `file:line` the classifier's discrimination is decided
 * at. The two production producers hardcode a constant; the generic base producer
 * forwards its caller's value (and its only production callers are the two
 * hardcoded ones). `governed-learning-attribution.test.ts` in `apps/worker` reads
 * these source files and fails if a producer's attribution drifts from this
 * registry, so the count below cannot silently become a lie.
 */
export type GovernedLearningProducerAttribution = Readonly<{
  producer: string;
  role: "production" | "generic";
  attributionSource: ProducerAttributionSource;
  constantValue: LearningOutcomeAttribution | null;
  reference: string;
}>;

export const GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS: readonly GovernedLearningProducerAttribution[] = Object.freeze([
  Object.freeze({
    producer: "apps/worker/src/warden-learning-producer.ts",
    role: "production" as const,
    attributionSource: "hardcoded_constant" as const,
    constantValue: "model_behavior" as const,
    reference: "apps/worker/src/warden-learning-producer.ts:273",
  }),
  Object.freeze({
    producer: "apps/worker/src/transformer-governed-learning-producer.ts",
    role: "production" as const,
    attributionSource: "hardcoded_constant" as const,
    constantValue: "model_behavior" as const,
    reference: "apps/worker/src/transformer-governed-learning-producer.ts:136",
  }),
  Object.freeze({
    producer: "apps/worker/src/governed-learning-producer.ts",
    role: "generic" as const,
    attributionSource: "caller_supplied" as const,
    constantValue: null,
    reference: "apps/worker/src/governed-learning-producer.ts:251",
  }),
]);

/**
 * The honest assessment of whether the classifier discriminates in production.
 * `effectivelyConstant` is true only when EVERY production producer hardcodes the
 * SAME single attribution, so the eleven-way taxonomy collapses to one branch
 * before it ever reaches routing. It fails closed: if any production producer
 * forwarded a caller value, we could not prove the input is degenerate, so
 * `effectivelyConstant` would be false — never asserting discrimination that has
 * not been demonstrated.
 */
export type ProductionAttributionDiscrimination = Readonly<{
  productionProducers: number;
  hardcodedProductionProducers: number;
  distinctProductionConstants: readonly LearningOutcomeAttribution[];
  effectivelyConstant: boolean;
  constant: LearningOutcomeAttribution | null;
}>;

export function assessProductionAttributionDiscrimination(
  registry: readonly GovernedLearningProducerAttribution[] = GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS,
): ProductionAttributionDiscrimination {
  const production = registry.filter((entry) => entry.role === "production");
  const hardcoded = production.filter((entry) => entry.attributionSource === "hardcoded_constant");
  const distinct = [
    ...new Set(
      hardcoded
        .map((entry) => entry.constantValue)
        .filter((value): value is LearningOutcomeAttribution => value !== null),
    ),
  ];
  const effectivelyConstant =
    production.length > 0 && hardcoded.length === production.length && distinct.length === 1;
  return Object.freeze({
    productionProducers: production.length,
    hardcodedProductionProducers: hardcoded.length,
    distinctProductionConstants: Object.freeze(distinct),
    effectivelyConstant,
    constant: effectivelyConstant ? distinct[0]! : null,
  });
}
