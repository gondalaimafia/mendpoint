# The Mendpoint Stateless-versus-Persistent Context Benchmark

**A methodology paper for the measurement that decides whether the Mission Spaces
programme was worth building. Its integrity matters more than its result.**

- **Commit under description:** `origin/main` @ `bd37545`, worktree branch
  `claude/persistent-context-benchmark`, 2026-08-21.
- **Harness:** `evals/context-benchmark/` (`context-benchmark.ts`, `scenarios.ts`,
  `run.ts`, `context-benchmark.test.ts`).
- **Canonical authority:** `docs/product/mendpoint-product-platform-specification-v3.md`
  §11.21 (representation experiments), §36.1 (no external benchmark result is a
  Mendpoint claim without Mendpoint-specific evidence); `docs/missions/CURRENT_STATE.md`;
  `docs/memory/MEMORY_PRECEDENCE.md`.
- **Gates:** `npm run typecheck` -> exit 0. `npx vitest run packages/pipeline packages/db evals`
  includes `evals/context-benchmark/context-benchmark.test.ts` (22 tests).
- **Related decision:** `docs/adr/0010-persistent-context-benchmark-methodology.md`.

---

## 0. What this is, and what it deliberately is not

This benchmark asks one question: **does inherited persistent context stop an
agent from repeating mistakes the organization has already resolved?** That is
the claim the Mission Spaces programme makes, and everything else is secondary.

Three constraints shaped it, and each is stated here so no reader can miss it.

1. **The compiler now exists, but is gated off and not mission-bound on the live
   path.** This benchmark was designed against main @ `bd37545`, where there was
   no Context Compiler at all: `docs/missions/CURRENT_STATE.md` recorded, checked
   against code, that every model call reconstructed identical, tenant-independent
   context from compiled-in constants. That is now stale. The **Mission Context
   Compiler has merged** (`docs/missions/CONTEXT_COMPILER.md`,
   `packages/pipeline/src/mission-context-compiler.ts`,
   `packages/agent/src/inherited-context.ts`, ADR-0009), and the injection seam
   is in `packages/agent/src/agent.ts`. But it is gated behind
   `MENDPOINT_INHERITED_CONTEXT` (default off), and on the live Fettler dispatch a
   job is not bound to a mission, so the mission-scoped sections report
   `no_mission_bound` and only organization memory can reach the prompt. So the
   benchmark still cannot measure the mission-bound product end to end today; it
   measures the mechanism, and Section 1.1 maps the modeled envelope onto the real
   compiler section by section, naming where they match and where they diverge.

2. **This repository's benchmarks have flattered themselves.** The Graphify
   benchmark's headline advantage was entirely a label leak; an anti-overfitting
   gate could not mathematically fail; metrics returned flattering values on
   empty denominators (`docs/reviews/2026-08-19-claude-review-response.md`). This
   harness is built assuming an adversarial reviewer looking for exactly those.

3. **A null or negative result is acceptable and valuable.** The Graphify
   benchmark's honest answer was zero, and reporting that was worth more than the
   leaked result it replaced. Nothing here was tuned to produce a positive delta.

### Abstract

The harness runs two arms over one fixed cohort of migration tasks. The task, the
agent model, and the grader are identical across arms; the only difference is the
inherited context. It is deterministic and requires no live model. It measures a
**mechanism under a perfect-attention agent model** and reports the result as a
**ceiling**, not as a realized product capability. On the shipped cohort the
persistent arm avoids all three previously-resolved mistakes the stateless arm
repeats, is correct on 11 of 12 hazards against the stateless arm's 5 of 12, and
raises stage-verification success from 0.50 to 0.875. It also pays for the
context: 5583 versus 2015 synthetic tokens, of which a large fraction is
irrelevant, stale, or duplicated. On one scenario a confirmed-but-wrong memory
makes the persistent arm **worse** than the stateless arm. No number here is a
Mendpoint product claim under spec v3 §36.1.

---

## 1. Design

Two arms, held on the same task, model, and grader:

- **Arm `stateless`.** Each task receives only the immediate instruction and
  current files (the "immediate" context bucket).
- **Arm `persistent`.** Each task additionally receives the compiled envelope,
  expressed as `KnowledgeItem`s in the "persistent" bucket: prior mission
  decisions, exceptions, reviewer corrections, verification results, organization
  memory, and the policy envelope.

The unit of measurement is a **hazard**: a decision point in a task where the
agent chooses one option, exactly one of which is correct. The correct option is
never part of the hazard; it lives in a sealed answer key that only the grader
sees.

The agent (`chooseOption`) is a **pure function of `(public hazard, reachable
items)`**. It has no arm parameter and no access to the sealed key. For each
hazard it gathers the non-stale reachable items that share the hazard's
`resolutionKey`, resolves competing items through the **real product precedence
resolver** `resolveOrganizationDecision` (`packages/pipeline`), and follows the
governing layer's recommendation; with no reachable knowledge it falls to a naive
default. That naive default is, for every persistent-only hazard, a wrong option,
because that is what a stateless agent actually does when the resolving knowledge
is not in front of it. It is not a tuning knob; it is the definition of the cost
of statelessness.

Because the agent is arm-blind and truth-blind, **any measured difference between
arms is attributable to inherited context and to nothing else.** That is the
whole point, and Section 3 shows the controls that hold it true.

## 1.1 Reconciliation with the real Mission Context Compiler

The compiler that would build Arm B's envelope now exists on main
(`packages/pipeline/src/mission-context-compiler.ts`, documented in
`docs/missions/CONTEXT_COMPILER.md`). Its conceptual envelope
(`InheritedContextEnvelope`) has sections `missionIdentity`, `task`,
`graphProjection`, `relevantHistory`, `activeDecisions`, `relevantOrgMemory`,
`policyConstraints`, `verificationState`, `unresolvedExceptions`, `evidenceRefs`,
`precedence`, and `bounds`. Reading the modeled envelope against the real one:

**Where they match (and why the ceiling is meaningful):**

- **Precedence is the same code.** The compiler resolves ordering ONLY through
  `resolveOrganizationDecision`, grouping every precedence-participating layer by
  `subjectKey` and calling the resolver once per subject. The benchmark's agent
  does exactly this: its `resolutionKey` is the compiler's `subjectKey`, and it
  groups reachable items by layer and calls the same resolver once per hazard. So
  the agent's choice of governing layer is the compiler's own logic, not a
  reimplementation. The benchmark's "hard policy beats a conflicting confirmed
  memory" and "confirmed memory wins and is named" tests are the same properties
  as the compiler's CONTROL 1 and CONTROL 2.
- **Section-to-layer mapping.** The benchmark's `KnowledgeItem` layers map onto
  real sections: `hard_policy` to `policyConstraints`, `mission_decision` to
  `activeDecisions`, `confirmed_org_memory` / `user_preference` /
  `inferred_candidate` to `relevantOrgMemory` (`applied` vs `overridden`), the
  verification hazard to `verificationState`, and the exemption hazards to
  `unresolvedExceptions`.
- **A confirmed-but-wrong memory reaches the model as applied.** The compiler
  cannot know a confirmed memory is wrong for a task; it places it in
  `relevantOrgMemory.applied` and the renderer injects it. The
  `conflicting-context-harm` scenario is therefore a faithful model of real
  compiler behavior, not an artifact: this is a risk the compiler's bounds and
  precedence do **not** mitigate, which is why the persistent arm's loss there is
  the sharpest finding in this report.
- **Live vs mission-bound reach.** The `memory-oauth-controlled` scenario (org
  memory only) corresponds to what can reach the **live** Fettler prompt today;
  the `regauge-multistage-migration` scenario (decisions, exceptions,
  verification, history) corresponds to the **mission-bound** path, which is
  implemented and covered by `apps/worker/src/mission-context.test.ts` but is not
  yet exercised by the live dispatch (a Fettler job is not mission-bound, so those
  sections report `no_mission_bound`).

**Where the modeled envelope diverges (stated so no reader over-reads the ceiling):**

1. **The absence tri-state is collapsed.** This is the load-bearing divergence.
   The real compiler distinguishes three reasons a section is empty:
   `not_consulted{store_not_available}` (the store was not read),
   `consulted{applied: []}` ("no organization memory applies"), and
   `not_consulted{no_mission_bound}` (the task is not part of a formal mission).
   The benchmark models "context not inherited" as the mere **absence** of a
   `KnowledgeItem` and collapses all three into one "absent". This does not affect
   the outcome metrics (all three yield "the agent lacks the knowledge and falls to
   the naive default"), but any consumer that branches on *why* a section is empty
   is not modeled here, and that distinction is load-bearing in the real compiler.
2. **Bounds and stale-exclusion are not modeled; the inflation scenario overstates
   the real token cost.** The real compiler caps each section at 32 items and the
   rendered body at 32768 bytes, dropping lowest-priority sections first
   (`bounds.promptTruncated`), and **excludes** disabled/rejected/stale/deleted
   memory before rendering. The `context-inflation-control` scenario deliberately
   models an *unselective* envelope that carries stale, irrelevant, and duplicated
   items and grows unbounded, so its token figures are a stress model of what the
   compiler's selection and bounds exist to prevent. In particular the real
   compiler would not carry the stale items at all, and would cap the total. The
   scenario's value is to show why selection and bounds matter, and it does not
   claim the real compiler is unbounded.
3. **Verification currency is a single item, not the real tri-state.** The real
   compiler carries `current_evidence` / `stale_evidence` / `no_current_evidence`
   from `classifyMissionVerificationEvidence` and never presents a
   changed-snapshot verification as current. The benchmark's verification hazard
   models only "the verified variant is known"; it does not model a stale
   verification being correctly withheld.
4. **No distinct graph-projection section.** The real compiler runs the bounded
   `compileFettlerImpactContext` (16 KB cap) for `graphProjection`, reporting
   `not_consulted{graph_version_absent}` on the Fettler path. The benchmark folds
   any graph context into generic items and does not model this section.

The net: the precedence core the ceiling depends on is the real compiler's own
code, so the ceiling is meaningful; the divergences are all in *reporting fidelity*
and *envelope hygiene* (tri-state, bounds, stale-exclusion, graph), and each is
named above rather than left for a reader to discover.

## 2. The cohort

The cohort is deliberately mixed so the harness cannot flatter persistent
context. All four scenarios are synthetic and in-memory (`scenarios.ts`); none is
admitted by directory name.

1. **`regauge-multistage-migration` (4 stages).** A ReGauge internal
   modernization carrying all six required elements: an initial architecture
   decision established by a reviewer correction in stage 1; an exemption
   exception discovered in stage 2; a reviewer correction of the auth abstraction
   in stage 2; a stage-3 dependency on the stage-1 architecture; a stage-2
   verification result that gates stage 3; and an organization timestamp rule
   (a hard policy) in stage 4. The prior resolutions live only in the persistent
   bucket for the later stages, so a stateless agent re-decides from scratch,
   re-migrates the exempt module, and violates the policy it never saw.

2. **`memory-oauth-controlled` (the memory-specific controlled case).** Mission 1:
   a reviewer corrects a direct OAuth implementation to the internal auth client.
   Mission 2: the same organization, a similar task. The persistent arm carries
   the Mission-1 correction as confirmed Organization Memory; the stateless arm
   does not.

3. **`context-inflation-control`.** One real naming-convention hazard buried in
   irrelevant, stale, and duplicated persistent items. Persistent context changes
   no outcome here and inflates tokens: more context must read as cost.

4. **`conflicting-context-harm`.** A confirmed-but-wrong Organization Memory. The
   stateless arm's naive default is correct; the persistent arm follows the
   confirmed memory and is wrong. Persistent context makes the outcome worse.

## 3. Leak-proofing, and how a reviewer verifies it

The central obligation is that Arm `stateless` must not recover, by any route,
information that only Arm `persistent` is supposed to have. Here is exactly what
was done and how to check each claim.

1. **Availability is the single route, and it is a strict filter.**
   `availableItems(task, "stateless")` returns only the immediate bucket; the
   persistent bucket is unreachable to it by construction. *Verify:* the test
   "availableItems(stateless) never returns a persistent item".

2. **Stateless choices are provably independent of the persistent bucket.**
   Strip every persistent item from the cohort and the stateless staged choices
   are byte-identical. So the stateless arm's output is a function of the
   immediate bucket alone, no matter what the persistent bucket contains.
   *Verify:* the test "stateless choices are identical whether or not a persistent
   bucket exists".

3. **The agent never sees the answer key.** Staging (`stageBenchmark`) never
   receives the sealed key; grading against a key with every correct option
   flipped leaves the staged choices byte-identical (only the grade changes).
   So a staged choice cannot depend on the answer — the Graphify closure-over-the
   -key leak cannot occur. *Verify:* the test "staged choices do not depend on the
   sealed key".

4. **Case identifiers carry no signal.** The grader joins by id and canonicalizes
   before hashing. Renaming every scenario/task/hazard/item id and reversing all
   orderings leaves every arm metric identical — so id parity or ordering cannot
   encode a label (the Graphify case-id-parity leak). *Verify:* the test
   "renaming every id and reordering everything leaves the arm metrics identical".

5. **Context placement is the only cause of the delta.** Move the migration
   scenario's persistent items into the immediate bucket, so both arms see
   everything, and the advantage goes to **exactly zero**: no repeats avoided,
   equal correctness. This is the direct analogue of the Graphify finding that
   with labels genuinely withheld the advantage was zero. *Verify:* the test
   "moving every persistent item to the immediate bucket makes the arms
   identical".

6. **An artifact-level leak gate.** Independent of the stager, gate G3 recomputes
   the set of every persistent item id and asserts no stateless staged choice
   reached any of them. It FAILS on a forged staged artifact that injects a
   persistent id into a stateless choice. *Verify:* the test "the leak gate (G3)
   FAILS on a staged artifact where a stateless choice reached a persistent item".

## 4. Metrics

Per arm, aggregated over all hazards. Which are deterministic here and which
would need a live model is stated explicitly.

**Deterministic (measured here):**

- **Repeated mistakes (the headline).** Rate at which previously-resolved
  mistakes are repeated, over the count of previously-resolved hazards.
- **Task correctness.** Correct choices over hazards graded.
- **Migration consistency.** Consistency groups whose choices all match the
  architecture decision, over total groups.
- **Repeated instructions.** Distinct instructions (resolution keys) that had to
  be re-issued.
- **Human corrections.** Wrong choices at a review gate (each needs a correction).
- **Verification success.** Stages whose hazards were all chosen correctly, over
  verifiable stages.
- **Policy violations.** Choices that contradict a governing hard policy, over
  policy-governed hazards.
- **Context tokens** and **retrieval calls.** Synthetic token cost of the
  reachable context, and the number of reachable items consulted.
- **Context quality of the persistent envelope:** relevant, irrelevant, stale,
  conflicting, and duplicated counts. Relevant, irrelevant, and stale partition
  by whether the item matches a hazard and is active; conflicting is a relevant,
  active item that recommends the wrong option (known only to the grader);
  duplicated is an overlay count of exact repeats.

**Requires a live model (reported not-measured here, never zero):** time to
completion, model tokens, cost. `modelCalls` is 0 by construction.

**The zero-denominator rule.** Every rate returns an explicit not-measured with a
reason on a zero denominator, never 1 and never 0. Every gate treats not-measured
as FAIL. This is the direct remedy for the Graphify `d === 0 ? 1` defect.

**More context is not automatically better.** The context-quality breakdown and
the token cost are reported next to the outcome, so a compiler that inflates the
prompt without improving outcomes looks bad, not neutral. Scenario 3 shows this
directly; scenario 4 shows conflicting context being actively harmful.

## 5. The measured result

Run `npx tsx evals/context-benchmark/run.ts`. Full cohort:

| Metric | `stateless` | `persistent` |
|---|---|---|
| Hazards graded | 12 | 12 |
| Task correctness | 5/12 = 0.4167 | 11/12 = 0.9167 |
| **Repeated-mistake rate (headline)** | **3/3 = 1.0000** | **0/3 = 0.0000** |
| Repeated instructions | 3 | 0 |
| Human corrections | 7 | 1 |
| Migration consistency | 0/1 = 0.0000 | 1/1 = 1.0000 |
| Verification success | 4/8 = 0.5000 | 7/8 = 0.8750 |
| Policy violations | 1/1 | 0/1 |
| Context tokens | 2015 | 5583 |
| Retrieval calls | 4 | 19 |
| Time / cost | not-measured | not-measured |

Persistent envelope quality: relevant 7, irrelevant 5, stale 2, conflicting 1,
duplicated 2 (15 items, 3568 tokens).

**Headline, stated plainly.** Under a perfect-attention agent model, on this
cohort, persistent context avoids **3 of 3** previously-resolved mistakes that
the stateless arm repeats. That is the ceiling: the mechanism can, in principle,
eliminate the repeats. It is **not** a claim that a live model would.

**The result is not a clean sweep, by design.**

- The persistent arm is **not perfect**: it loses `conflicting-context-harm`
  (correctness 0/1 there against the stateless arm's 1/1) because it follows a
  confirmed-but-wrong memory. Persistent context can make outcomes worse, and the
  benchmark shows it.
- The persistent arm **pays for context**: 5583 versus 2015 tokens on the full
  cohort. On `context-inflation-control` it pays 3340 tokens against the
  stateless arm's 200 to get one hazard right, and 5 of its 8 persistent items
  are irrelevant, 2 stale, 2 duplicated. More context bought one correct answer
  and a large bill.

### 5.1 The controlled memory case

Grading `memory-oauth-controlled` alone:

| Metric | without org memory (`stateless`) | with confirmed org memory (`persistent`) |
|---|---|---|
| Correct abstraction chosen (Mission 2) | no (direct OAuth) | yes (internal auth client) |
| Repeated-mistake rate | 1/1 = 1.0000 | 0/1 = 0.0000 |
| Human corrections | 1 | 0 |
| Context tokens | 472 | 531 |

The correct abstraction is chosen only with confirmed Organization Memory; the
correction is required again without it; and the context cost of carrying the
confirmed memory is 59 tokens. This is the mechanism the programme is built on,
measured in isolation, with the same not-measured caveat on realization by a live
model.

## 6. What the numbers do and do not support

Under spec v3 §36.1, **no number here is a Mendpoint product claim**, because
there is no Mendpoint-specific live evidence behind it. Specifically:

- **Supported:** *If* a persistent-context system delivers the relevant prior
  resolution into an arm's reachable context, and *if* the agent attends to it,
  then the previously-resolved mistake is not repeated. The harness proves the
  mechanism is coherent, that the advantage is caused only by context placement,
  and that it can be null (scenario 3) or negative (scenario 4).
- **Not supported:** that a live model, given the compiled envelope, actually
  attends to and correctly applies the relevant context; the realized (as opposed
  to ceiling) repeat-avoidance rate; and any time, token, or cost figure. Those
  require a live-model lane that reuses this cohort and sealed key unchanged.
- **Also not established, and not claimed:** that the merged compiler, once
  ungated and mission-bound, realizes any of this on a live model; or that
  persistent context helps on scenarios unlike these. The compiler now exists
  (Section 1.1) but is gated off by default and reports `no_mission_bound` on the
  live Fettler path, so the mission-scoped envelope this benchmark models is not
  yet exercised in production. On a cohort where the resolving knowledge is
  intrinsic to the immediate files, the harness reports zero advantage (Section 3,
  control 5).

## 7. Gates, and proof each can fail

The benchmark defines its own gates (`evaluateGates`); it does not read or move
`evals/readiness-gates.json` or `docs/PRODUCT_REQUIREMENTS.json`. Each gate is
PASS / FAIL / NOT_MEASURED, and NOT_MEASURED counts as FAIL.

| Gate | What it checks | Constructed failing input (test) |
|---|---|---|
| `arm_measured_something` | each arm graded > 0 hazards | a report with an arm's `hazardsGraded` forced to 0 -> NOT_MEASURED |
| `headline_measured` | repeated-mistake rate measured for both arms | the inflation-only sub-cohort (zero previously-resolved hazards) -> NOT_MEASURED |
| `leak_proof` | no stateless choice reached a persistent item | a forged staged artifact injecting a persistent id -> FAIL |
| `context_quality_reconciles` | the four categories partition the persistent total | a report with `irrelevant` inflated by 3 -> FAIL |

An empty cohort throws `context_benchmark_empty_cohort`; a truncated cohort
throws a cohort-digest mismatch; a key missing a hazard's truth throws a key
mismatch. None of these can grade cleanly to a flattering zero.

## 8. Controls and the test that dies if each is deleted

Every control below was verified by reverting the line, watching the named test
fail, and restoring it.

| Control (in `context-benchmark.ts`) | Test that dies |
|---|---|
| `availableItems` stateless bucket filter | "availableItems(stateless) never returns a persistent item" and "stateless choices are identical whether or not a persistent bucket exists" |
| `rate()` returns not-measured on a zero denominator | "rate() returns not-measured..." and "an arm with no previously-resolved mistakes reports repeated-mistake rate not-measured" |
| `classifyContextQuality` conflicting branch | "stale and conflicting are counted as DISTINCT categories" and "conflicting persistent context makes the persistent arm WORSE" |
| `evaluateGates` G3 leak recomputation | "the leak gate (G3) FAILS on a staged artifact where a stateless choice reached a persistent item" |
| `gradeBenchmark` empty-cohort guard | "an empty cohort throws rather than grading cleanly to a flattering zero" |
| cohort/key digest binding | "grading a truncated cohort against the full key throws a digest mismatch" |

## 9. The successor: a live-model lane

The honest next step is a live-model lane that reuses this exact cohort and sealed
key and measures **realized** repeat avoidance rather than the ceiling, plus real
time and cost. It would keep every leak control here unchanged (staging without
the key, arm-blind prompts, id-invariance) and add: a live model behind each arm,
per-arm token and cost capture, and a grader that scores the model's actual
output against the same sealed key. Until that lane runs, the ceiling reported
here is the honest ceiling, and nothing above it may be stated as a product
result.
