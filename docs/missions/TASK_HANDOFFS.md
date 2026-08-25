# Task handoffs: agent -> human -> agent

What works today, verified against the code. Where a seam is implemented but not
exercised by live dispatch, this document says so plainly rather than implying
more.

## The problem this solves

The Fettler regenerate path (`apps/api/src/warden-candidate-review.ts`) lets a
human review a candidate and ask for a regeneration. Its gating is the strongest
in the repository (OIDC-only, active tenant membership, a non-revoked human trust
principal, with the membership evidence id re-verified *inside* the transaction).
None of that is changed here.

What did not survive the human step was everything the prior attempt learned. A
regenerate carried only the reviewer's rationale (capped at 2000 characters,
string-concatenated onto the goal at `apps/worker/src/cli.ts`), plus the
inherited snapshot binding and allowed paths. Cycle 3 saw only cycle 3's
feedback; cycles 1 and 2 sat in `agent_runs.result_json` of superseded rows that
nothing read. And a rejected approach could be proposed again next cycle.

The design here is small and deliberate: **a handoff writes durable records; a
resume reads the compiled envelope.** Nothing new is stored beyond the three
mission record stores that already exist, and nothing reaches a model except
through the Mission Context Compiler's untrusted-data fence.

## 1 — Task ownership states (`packages/db/src/task-ownership.ts`)

This is a declared **view**, not a fourth state machine. The repository already
enforces two: `agent_runs.status` (a de-facto lifecycle applied ad hoc by
conditional UPDATE, with no declared machine and no CHECK constraint) and the
ten-state Fettler CI cycle machine in `warden-ci-reentry.ts`. The ownership view
adds no stored state and no column. It names the phase a task is in and who owns
it, derived from the statuses those machines already persist.

State mapping (`ownershipStateForAgentRunStatus`):

| `agent_runs.status`     | ownership phase          | holder   |
|-------------------------|--------------------------|----------|
| `queued`                | `agent_assigned`         | agent    |
| `running`               | `agent_working`          | agent    |
| `candidate_ready`       | `human_review_required`  | human    |
| `candidate_superseded`  | `agent_resume`           | agent    |
| `candidate_approved` / `no_action` / `ok` | `complete`  | terminal |
| `candidate_rejected`    | `blocked`                | terminal |
| `candidate_expired` / `candidate_corrupt` / `failed` | `failed` | terminal |
| `cancelled`             | `cancelled`              | terminal |
| *(anything else)*       | `unknown`                | indeterminate |

CI cycle statuses map through `ownershipStateForCiCycleStatus` (a `paused` cycle
is `escalated` to a human; `exhausted` is a terminal `blocked`).

**Fail closed.** An unrecognized status is `unknown` / `indeterminate`, never a
benign owner. "We could not determine ownership" must never read as "the agent
may proceed." A declared allowed-transition table (`assertTaskOwnershipTransition`)
enforces that `agent_resume` is only reachable **after** a human or terminal step
(`human_review_required`, `blocked`, `failed`, `escalated`) — a run still
`agent_working` was never handed to a human and so cannot be "resumed".

## 2 — What a handoff preserves (`packages/db/src/mission-handoff.ts`)

A handoff is written as durable records composed over the existing stores — no
new store:

- `openTaskHandoff` raises a **blocking** `mission_exception` carrying an explicit
  `HandoffReason` (a closed enum: `graph_incomplete`, `high_risk_change`,
  `ambiguous_requirement`, `policy_exception`, `verification_failure`,
  `architecture_decision_required`) **and the specific question** the human must
  answer. "Please review" forces reconstruction; "should service B migrate before
  or after service A, given this dependency" does not. A handoff that cannot name
  its reason, or omits the question, is refused (fail closed). Binding the
  exception to the snapshot it was observed against means that if the mission
  later moves past that snapshot the exception goes **stale** (surfaced for
  re-affirmation) rather than silently blocking forever.
- `resolveTaskHandoff` closes the blocker **and** records the human's answer as a
  durable `mission_decision`, atomically. So the same question is not asked again,
  and a later task inherits the answer.

The agent's work-so-far is preserved by **reference** (trajectory ref, candidate
digest, evidence ids) on the decision — never by copying model reasoning.

## 3 — How resume differs from today's fresh session

Today's regenerate creates a new `agent.run` with a fresh session id and a goal
string with the rationale concatenated on. The resume side now reads the
**compiled envelope** instead:

- `apps/worker/src/cli.ts` calls `resolveResumeContext` on the live Fettler
  `agent.run` path. Unbound jobs still require the default-off
  `MENDPOINT_INHERITED_CONTEXT` switch. A job that names a `missionId` (carried
  forward across a regenerate via the payload spread) compiles even with that
  switch unset, so a mission-bound resume reads decisions, exceptions,
  verification, and history — not only organization memory, and not a
  concatenated string — and persists `context_refs_json` on the trajectory.
  Injection happens only on a `loaded` standing. `context_not_loaded` and
  `not_resumable` fail closed (skip injection, log the reason) rather than
  compiling as if there were no mission.
- `apps/worker/src/mission-resume.ts` (`resolveResumeContext`) is the resume-side
  orchestration: it applies the ownership guard, resolves the mission, compiles
  the envelope, and returns a standing that keeps **four absences distinct**:

  | standing | meaning |
  |---|---|
  | `loaded` | inherited content is present; carries the bounded injection + refs |
  | `no_prior_context` | the stores were consulted and genuinely hold nothing |
  | `no_mission_bound` | the task is not part of a formal mission |
  | `context_not_loaded` | a store we meant to read did not load, or a claimed mission id did not resolve, or the compile threw |
  | `not_resumable` | the run's status is not an agent-owned phase (incl. unknown) |

  `context_not_loaded` and `not_resumable` are the fail-closed cases: "we did not
  load it" never collapses into the reassuring "there is nothing to load".

## 4 — Stop repeating rejected approaches and resolved questions

- A rejected approach is recorded as an **active** `mission_decision`
  (`recordReviewerDirective`). Distinct per-cycle scopes keep every cycle's
  directive active at once, so cycle 3 still sees cycle 1's — the compiler surfaces
  all active decisions in `activeDecisions`.
- A resolved question's blocking exception is closed, so
  `evaluateMissionExceptions` no longer surfaces it and the compiler's
  `unresolvedExceptions` excludes it. It is not asked again.

**Suppression is never absolute.** `reviseDecisionOnNewEvidence` supersedes a
prior decision — dropping it out of the active set — but **requires non-empty new
evidence**, so revision is a deliberate, evidenced act, not a silent reversal.
This follows the verification staleness precedent: current evidence is
distinguished from evidence since invalidated, rather than treating all past
evidence as permanent. A genuinely changed circumstance lets an agent revisit;
an unchanged one does not.

## What is and is not live

- The **resume seam** (`resolveResumeContext` on Fettler `agent.run`) is wired
  into the live Fettler dispatch. Unbound jobs stay behind
  `MENDPOINT_INHERITED_CONTEXT`; bound Missions compile and inject without
  flipping that global switch.
- On current main a Fettler `agent.run` job is **not** bound to a `mission` row
  (its payload carries no campaign or mission id). So on the live Fettler repair
  path the resume carries **tenant organization memory only**, and the
  mission-scoped sections honestly report `no_mission_bound`. Binding a Fettler
  job to a mission is a separate, acknowledged gap; this work does **not**
  fabricate a binding to make the resume path look complete.
- The **first real caller** of the mission decision store is the mission-bound
  regenerate branch of `warden-candidate-review.ts`: when (and only when) the
  regenerate is part of a formal mission, the reviewer directive is recorded as a
  durable decision. With no mission it is skipped — nothing is fabricated.
- The **ReGauge / transformer** path runs deterministic recipes and never reaches
  the model seam, so it is deliberately not wired to write context refs or
  decisions here. ReGauge regeneration remains blocked by an owner decision
  (`apps/worker/src/transformer-adaptive-regeneration.ts`); this work does not
  touch it.

Reviewer- and agent-authored text (`question`, `directive`, resolution notes) is
**untrusted data** throughout. It is stored verbatim and only ever reaches a
model inside `renderInheritedContextSystemBlock`'s explicit data fence, so an
imperative sentence inside it reads to the model as quoted data, never an
instruction.

## Tests (each dies when its control is deleted)

| Control | Test | Dies if you delete |
|---|---|---|
| Unrecognized status is `unknown`, never agent-owned | `task-ownership.test.ts` CONTROL A | the `default: return "unknown"` arm |
| Resume eligible only after a human/terminal step | `task-ownership.test.ts` CONTROL B | `human_review_required -> agent_resume` in the transition table |
| A resolved question is not re-asked | `mission-handoff.test.ts` "question resolved ... not re-asked" | the `resolveMissionException` call in `resolveTaskHandoff` |
| A rejected approach stays active through later cycles | `mission-handoff.test.ts` "rejected in cycle 1 ... through cycle 3" | the `recordMissionDecision` call in `recordReviewerDirective` |
| Revisiting requires new evidence (not absolute) | `mission-handoff.test.ts` "changed circumstance ... only with new evidence" | the evidence guard in `reviseDecisionOnNewEvidence` |
| `context_not_loaded` distinct from `no_prior_context` | `mission-resume.test.ts` CONTROL (store scan) + "four ... distinct" | the `store_not_available` scan in `classifyResumeStanding` |
| A resumed run reads the earlier decision from the envelope | `mission-resume.test.ts` "reads the earlier decision" | the mission pass-through in `resolveResumeContext` |
| Bound Missions compile without `MENDPOINT_INHERITED_CONTEXT`, and an explicit `0` still suppresses | `inherited-context.test.ts` CONTROL (bound compile + kill switch) + `agent.test.ts` inherited-context injection seam | `inheritedContextShouldCompile` + the seam gate in `agent.ts` |
| Instruction-like reviewer text framed as data at the seam | `mission-resume.test.ts` CONTROL (seam) | the fence/header in `renderInheritedContextSystemBlock` |
| Reviewer directive recorded only when mission-bound | `warden-candidate-review.test.ts` "records the reviewer directive ..." / "no fabrication" | the `recordReviewerDirective` call in the regenerate branch |
