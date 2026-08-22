// Lesson routing observability.
//
// The lesson classifier (`classify` in `learning-event.ts`) assigns every
// validated lesson to one of the eleven `LearningDestination` values it can emit.
// (The taxonomy defines a twelfth, `organization_memory`, that names where a
// tenant convention belongs — spec §17.4/§17.4.3, ADR-0008 — but the classifier
// never emits it and nothing consumes it; it is vocabulary, not a live route.)
// Two destinations have a downstream sink, but nothing routes to either in
// production today (see fact 2 below). `model_weight` is read by the governed
// training corpus at `learning-operations.ts:849`; `retrieval` is read by the
// retrieval context-gap sink — `admitGovernedLearningEvent` projects a
// retrieval-attributed lesson into `retrieval_context_gaps`
// (`packages/db/src/retrieval-context-gap.ts`) and `computeRetrievalContextGaps`
// serves it at `/metrics/outcomes/retrieval-gaps`. Both are live code with real
// consumers that are fed nothing yet: every production lesson is attributed `none`,
// so it routes to `no_action`. A lesson classified to any of the other nine
// reachable destinations is computed, stored on the lesson object, and consumed by
// nothing. Naming the drop keeps "we routed this to `retrieval`" distinguishable
// from "nothing acted on it" for the day the flow opens.
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
//   2. Across the pipeline: whether the classifier collapses to a CONSTANT because
//      every production producer hardcodes the SAME attribution literal
//      (`assessProductionAttributionDiscrimination`). Read its scope precisely:
//      that is the ONLY degeneracy this static check can see, and it reports
//      `effectivelyConstant: false` today because neither production producer
//      hardcodes a literal — both call `deriveOutcomeAttribution`. But `false` here
//      does NOT mean the classifier discriminates in practice. It does not: both
//      producers feed the deriver a constant `not_verified` (Warden's independent
//      verifier is unsatisfiable; ReGauge's "passed" flag is tautological and it
//      has no verifier), so both always emit `none` -> `no_action`, and no
//      production lesson ever reaches `model_weight`. That degeneracy — a producer
//      evidence-derived in SHAPE but handed constant evidence — is invisible to
//      this check, because proving it needs cross-file reasoning about what
//      evidence each run can actually produce, which a static registry cannot do.
//      See `assessProductionAttributionDiscrimination` and the doc's Count 2.
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
 * it. Today that is `model_weight`, consumed by the governed training corpus
 * (`learning-operations.ts:849`), and `retrieval`, consumed by the retrieval
 * context-gap sink (`computeRetrievalContextGaps` in
 * `packages/db/src/retrieval-context-gap.ts`, served at
 * `/metrics/outcomes/retrieval-gaps`). When a real sink is added for another
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
    // A retrieval-attributed lesson (verification failed AND required context
    // confirmed absent, spec 17.4.2) is now consumed by the retrieval context-gap
    // sink: `admitGovernedLearningEvent` projects it into `retrieval_context_gaps`
    // and `computeRetrievalContextGaps` serves it at `/metrics/outcomes/retrieval-gaps`.
    // Flipped from `unrouted` in the same change that added that consumer.
    retrieval: "sink_consumes",
    graph: "unrouted",
    parser: "unrouted",
    tooling: "unrouted",
    deterministic_recipe: "unrouted",
    prompt: "unrouted",
    product_logic: "unrouted",
    calibration: "unrouted",
    // Named in the taxonomy (spec §17.4, ADR-0008) but not a live route: `classify`
    // never emits it and no sink consumes it. `unrouted` is the honest disposition —
    // its existence as a value must not read as a working route. See the upstream
    // blocker in docs/learning/LESSON_DESTINATION_ROUTING.md.
    organization_memory: "unrouted",
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
  | "caller_supplied"
  // The producer derives the attribution from evidence the run actually produced
  // (verification outcome, graph-context delivery) via `deriveOutcomeAttribution`.
  | "evidence_derived";

/**
 * A governed-learning producer and how it sets `observedOutcome.attribution`.
 * `reference` is the exact `file:line` the classifier's discrimination is decided
 * at. The two production producers now DERIVE attribution from run evidence; the
 * generic base producer forwards its caller's value (and its only production
 * callers are the two derived ones). `governed-learning-attribution.test.ts` in
 * `apps/worker` reads these source files and fails if a producer's attribution
 * drifts from this registry — including a regression back to a hardcoded constant
 * — so the assessment below cannot silently become a lie.
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
    attributionSource: "evidence_derived" as const,
    constantValue: null,
    reference: "apps/worker/src/warden-learning-producer.ts:368",
  }),
  Object.freeze({
    producer: "apps/worker/src/transformer-governed-learning-producer.ts",
    role: "production" as const,
    attributionSource: "evidence_derived" as const,
    constantValue: null,
    reference: "apps/worker/src/transformer-governed-learning-producer.ts:161",
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
 * A NARROW, honest assessment with a limit this comment states plainly so the
 * result is not over-read. `effectivelyConstant` is true only when EVERY production
 * producer hardcodes the SAME single attribution LITERAL, the one degeneracy a
 * static registry can prove. It fails closed: if any production producer derives
 * its attribution from evidence (`evidence_derived`) or forwards a caller value
 * (`caller_supplied`), this cannot prove the input is degenerate, so
 * `effectivelyConstant` is false. Both production producers are `evidence_derived`,
 * so it reports false.
 *
 * `effectivelyConstant: false` therefore does NOT mean the classifier discriminates
 * in production, and this check must not be read as though it would catch that. It
 * would not, and cannot: a producer that is `evidence_derived` in shape can still
 * be constant in practice by handing `deriveOutcomeAttribution` a constant input —
 * an unsatisfiable predicate (Warden's independent-verifier check, which no
 * production evidence can satisfy) or a tautological one (ReGauge's former
 * `passed === true`, guaranteed by sealing). BOTH production producers are that
 * case today: each feeds a constant `not_verified` and so always emits `none`, and
 * no production lesson reaches `model_weight`. Detecting that class needs cross-file
 * reasoning about what evidence each run can actually produce, which this registry
 * does not model — so it is documented here rather than falsely reported as caught.
 * The check retains real value as the regression guard against a producer sliding
 * BACK to a hardcoded literal (`governed-learning-attribution.test.ts`).
 */
export type ProductionAttributionDiscrimination = Readonly<{
  productionProducers: number;
  hardcodedProductionProducers: number;
  distinctProductionConstants: readonly LearningOutcomeAttribution[];
  // True only for the same-hardcoded-literal collapse above; false does NOT imply
  // the classifier discriminates in production. See the type doc.
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
