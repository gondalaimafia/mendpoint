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
and **in production both governed-learning producers emit a constant
`attribution: "none"`** — not by hardcoding a literal, but by feeding the shared
deriver a constant input:

- `apps/worker/src/warden-learning-producer.ts` (Warden / Fettler) — calls
  `deriveOutcomeAttribution`, but always passes `verification: "not_verified"`. Its
  authority is always soft because the independent-verifier predicate is
  *unsatisfiable*: no production path writes `assessmentSource: "verifier"`
  (production emits V2 review evidence whose enum is `["planner", "heuristic"]`;
  "verifier" is forbidden there and nothing constructs V1 evidence carrying it).
- `apps/worker/src/transformer-governed-learning-producer.ts` (Transformer /
  ReGauge) — calls `deriveOutcomeAttribution`, but always passes
  `verification: "not_verified"`. It formerly derived `verified` from
  `review.verification.passed === true`, a *tautology*: sealing guarantees
  `passed: true`, so both sides of the comparison traced to the same input and it
  always yielded `model_behavior` — the one attribution that feeds the training
  corpus. That comparison is removed; the seam has no independent verifier and
  cannot honestly attest verification.
- `apps/worker/src/governed-learning-producer.ts` (generic base producer) — forwards
  its caller's value, and its only production callers are the two above.

So `deriveOutcomeAttribution` is honest, but in production it is only ever handed
`not_verified`, and `not_verified -> none`. Every lesson arrives attributed to
`none`, routes to `no_action`, and **nothing reaches `model_weight`: the training
corpus is fed by nothing.** The taxonomy's eleven-way discrimination is real in the
code but latent — it stays dormant until a seam can observe a genuine verification
*outcome*. Two upstream facts keep it dormant, and both are decisions for the owner,
not this pipeline: the review-evidence schema cannot represent a *failed*
verification (`ReviewedVerificationCommandSchema` types `ok`/`exitCode` as the
literals `true`/`0`), so `VerificationOutcome` `"failed"` — and the `retrieval`
attribution it alone reaches, and any real sink built downstream of it — is
unreachable; and both producers admit only a *merged* delivery outcome, so a failure
could not arrive here even if it were representable.

`assessProductionAttributionDiscrimination()` reports `effectivelyConstant: false`
with `constant: null` — but read that literally: it detects ONLY the narrow
degeneracy where every production producer hardcodes the *same literal*, and neither
does now. **It does not, and structurally cannot, detect the degeneracy described
above** — a producer that is evidence-derived in shape yet handed constant evidence
by an unsatisfiable or tautological predicate. Proving that needs cross-file
reasoning about what evidence each run can produce, which a static registry does not
model, so the limitation is stated in the check's own doc rather than falsely
reported as caught. What the check still does honestly: `GOVERNED_LEARNING_PRODUCER_ATTRIBUTIONS`
records the exact `file:line` each attribution is decided at, and
`apps/worker/src/governed-learning-attribution.test.ts` reads the producer source
and fails if any producer slides back to a hardcoded literal — the regression it can
prove.

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
   both production producers can only emit `none` (see Count 2). Adding the
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
