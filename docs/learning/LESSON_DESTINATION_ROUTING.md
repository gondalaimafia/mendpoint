# Lesson destination routing: what reaches a sink, what goes nowhere

Updated: 2026-08-21

The lesson classifier (`classify` in `packages/pipeline/src/learning-event.ts`)
assigns every validated lesson to one of eleven `LearningDestination` values it can
emit. The taxonomy defines a twelfth value, `organization_memory`, that the
classifier never emits and no sink consumes — it names where a tenant convention
belongs (spec §17.4/§17.4.3, ADR-0008) but is vocabulary, not a live route. This
document records which of those destinations actually go anywhere, how the drop is
now made observable, why the two lesson taxonomies in the tree are deliberately
separate, and the upstream work that must land before Organization Memory can be
fed from this pipeline.

It describes the code on this branch, not intended future wiring. In particular,
the `organization_memory` destination existing does **not** mean the routing is
live: the three-part upstream blocker below is unchanged, and nothing is classified
there today.

## The gap this makes visible

**Exactly one destination — `model_weight` — has a downstream sink.** The governed
training corpus reads it at `packages/pipeline/src/learning-operations.ts:707`
(`lesson.destinations.some(({ destination }) => destination === "model_weight")`).
That line is the only consumer of `lesson.destinations` in the repository. A lesson
classified to any of the other ten destinations (`router_policy`, `retrieval`,
`graph`, `parser`, `tooling`, `deterministic_recipe`, `prompt`, `product_logic`,
`calibration`, `no_action`) is computed, stored on the lesson object, and consumed
by nothing. The twelfth value, `organization_memory`, is not even reachable from the
classifier: it has no attribution that maps to it, so it is never emitted and, like
the other ten, has no sink.

Until now that drop was silent: "we routed this lesson to `retrieval`" and "nothing
acted on this lesson" were indistinguishable — the pipeline's dominant defect shape,
where "we did not act on this" reads as "there was nothing to act on."

`packages/pipeline/src/lesson-routing.ts` names the drop, following the house
pattern of `classifyGraphContextDelivery`
(`apps/worker/src/warden-learning-producer.ts:94-140`).

## The two counts, and what each means

### Count 1 — lessons routed to a destination nothing consumes

`summarizeLessonRouting(lesson)` partitions a lesson's destinations by disposition:

- `sink_consumes` — a downstream sink actually reads it (today only `model_weight`);
- `terminal_no_action` — the classifier intentionally routed nowhere (`no_action`);
  this is not a drop;
- `unrouted` — classified here, but nothing consumes it. The formerly-silent drop.

`unroutedCount` is the number of unrouted destinations on a lesson, and
`wentNowhere` is true when a lesson reached no sink and was not the intentional
`no_action` terminal. An operator sums `unroutedCount` and counts `wentNowhere`
lessons to answer "how many lessons did we classify and then drop?"

The single source of truth is `LESSON_DESTINATION_DISPOSITIONS`. A destination may
be marked `sink_consumes` **only** in the same change that adds its real consumer.
The map is deliberately conservative: over-reporting a drop is merely noisy;
under-reporting one re-hides it, so the map fails toward visibility.

### Count 2 — the classifier is effectively a constant function in production

This is the more important number. The eleven-destination taxonomy *looks* like it
discriminates, but the classifier is a 1:1 map from `observedOutcome.attribution`,
and **in production every governed-learning producer hardcodes
`attribution: "model_behavior"`**:

- `apps/worker/src/warden-learning-producer.ts:273` (Warden / Fettler) — hardcoded;
- `apps/worker/src/transformer-governed-learning-producer.ts:136` (Transformer /
  ReGauge) — hardcoded;
- `apps/worker/src/governed-learning-producer.ts:251` (generic base producer) —
  forwards its caller's value, and its only production callers are the two hardcoded
  producers above.

So attribution is never derived from what actually happened. Every lesson arrives
attributed to `model_behavior`, routes to `model_weight`, and the taxonomy's
discrimination is inert before it ever reaches routing.

`assessProductionAttributionDiscrimination()` reports this as
`effectivelyConstant: true` with `constant: "model_behavior"`, and
`GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS` records the exact `file:line` each
attribution is decided at. `apps/worker/src/governed-learning-attribution.test.ts`
reads the producer source and fails if any producer's attribution drifts from that
registry, so the count cannot silently become a lie. The assessment fails closed: if
any production producer forwarded a caller value, `effectivelyConstant` would be
false — it never asserts discrimination that has not been demonstrated.

## Two lesson taxonomies, deliberately separate — do not merge

There are two destination taxonomies in the tree. They overlap in vocabulary and
look like duplication, but they are two layers, not two copies, and one already
derives from the other:

- `packages/pipeline/src/learning-event.ts` — the canonical **intervention**
  vocabulary (`LearningDestination`, spec §17.4): the improvement targets a lesson
  routes to. Eleven are classifier-emittable; the twelfth, `organization_memory`,
  is named vocabulary the classifier never emits. Owned in `packages/pipeline`.
- `evals/classification/destinations.ts` — a **failure-category** taxonomy
  (`MISSING_FACT`, `CONTEXT_FAILURE`, `PREFERENCE`, ...). Each category's
  `permittedInterventions` are `LearningDestination` values, imported via
  `import type { LearningDestination } from "@mendpoint/pipeline"`, with compile-time
  drift tripwires (`evals/classification/destinations.ts:44-52`). Nothing outside
  `evals/classification/` imports it.

The eval taxonomy classifies *why a failure happened*; the pipeline taxonomy names
*the lightest intervention that fixes it*. The failure category maps onto the
intervention vocabulary — it does not restate it. Note also that the eval
`PREFERENCE` category maps to the `model_weight` intervention (preference *tuning*
on real preference data), **not** to Organization Memory. The pipeline taxonomy now
has a memory destination (`organization_memory`), but nothing maps the eval
`PREFERENCE` category onto it and the classifier never emits it; the eval taxonomy
still has no memory destination.

Keep them separate. The apparent duplication is a typed layering, and the type
import already fails to compile if the intervention vocabulary drifts. Merging them
would collapse "why did it fail" into "what do we do about it" and delete that
tripwire.

## Upstream blocker: Organization Memory cannot yet be fed from this pipeline

Organization Memory (`packages/db/src/organization-memory.ts`) is a governed,
tenant-scoped store for organizational conventions. Its public write path,
`recordOrganizationMemoryObservation`, is **already correct and ready to receive**:
it rejects `explicit` sources, forces `status: "MEMORY_CANDIDATE"` (never `ACTIVE`)
and `trainingEligible: false`, counts independent corroboration structurally, and
binds tenant into the record hash. The gap that stops the lesson pipeline feeding it
is entirely **upstream**, and forcing a route now would manufacture organizational
conventions out of one-off fixes. Three things must exist first.

The **destination vocabulary** is now in place and is the only part that changed:
`LearningDestination` has an `organization_memory` value, spec §17.4 lists
`ORGANIZATION_MEMORY`, and §17.4.3 names the Organization Memory store (ADR-0008) as
the tenant-private rules/context form. That is a naming reconciliation, not a route.
The three blockers that keep anything from being classified there are untouched:

1. **An attribution value that means "organizational convention."** The current
   `LearningOutcomeAttribution` vocabulary
   (`model_behavior | router | retrieval | graph | parser | tooling |
   deterministic_recipe | prompt | product_logic | calibration | none`) has no value
   for an enduring organizational preference. A single reviewer correction is
   ambiguous across graph / org-memory / retrieval-harness / recipe / model; the
   vocabulary distinguishes four of those but has no value for the fifth. Naming the
   `organization_memory` *destination* does not supply this *attribution* — the
   classifier is a 1:1 map from attribution, so with no convention attribution the
   destination is never emitted (an attribution value was deliberately deferred: it
   needs a producer that can honestly attest a repeated reviewer correction of a
   non-defect). Reinterpreting an existing one-off-fix attribution
   (`prompt` / `product_logic` / `retrieval`) as a convention is the exact failure to
   avoid.

2. **A producer that emits that value only on genuine evidence** — a reviewer
   *repeatedly* making the same change to a *non-defect*. No producer emits it today;
   all three hardcode or forward `model_behavior` (see Count 2). Adding the
   attribution value without a producer that honestly sets it yields a
   built-never-called sink.

3. **Human correction actually flowing.** The signal that would feed such a producer
   — repeated reviewer correction of a non-defect — largely does not flow today:
   ReGauge blocks regeneration requests, and Fettler carries a single bounded
   rationale forward with no cross-cycle accumulation. Until corrections accumulate
   across cycles, there is nothing to corroborate.

Until all three exist, the honest state is the one this branch ships: the drop is
visible and countable, and Organization Memory is fed by nothing rather than by a
forced, manufactured convention.
