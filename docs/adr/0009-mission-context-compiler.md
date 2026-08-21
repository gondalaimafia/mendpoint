# ADR-0009: Compile inherited context instead of rebuilding it every run

- **Status:** Proposed
- **Date:** 2026-08-21
- **Author:** Claude Opus (opus-coder)
- **Supersedes:** none
- **Superseded by:** none

## Context

Every model call in the Fettler agent reconstructs an identical,
tenant-independent system prompt from compiled-in constants. The system message
is `wardenPlaybook()` (`packages/agent/src/agent.ts`), a pure function that takes
no tenant and no arguments, plus a hardcoded tool contract. No tenant context
reaches the prompt: no conventions, no organization memory, no prior mission
decisions, no verification state, no graph evidence.

Meanwhile the pieces to do better already existed but were routed elsewhere or
uncalled: the Organization Memory store (ADR-0008), the single precedence
resolver `resolveOrganizationDecision`, the three durable mission record stores
(decisions, exceptions, verification — PR #261), the one bounded graph projector
`compileFettlerImpactContext` (whose output went into a pull-request body for
humans, never to a model), and `trajectories.context_refs_json` (a schema slot
with zero writers repo-wide).

## Decision

We add the **Mission Context Compiler**: a task-specific compiler that assembles
a **bounded, minimum-sufficient** envelope of inherited context and renders it
for injection at the model seam. Six deliberate choices:

1. **The agent stays DB-free; the envelope is compiled upstream.** The model seam
   holds no database handle, so `@mendpoint/pipeline` compiles the envelope
   (reading the stores) and the agent injects an already-rendered, bounded block.
   The agent owns the untrusted-data framing and a fail-closed integrity check.

2. **Precedence is not reinvented.** Layer ordering
   (`hard policy > mission decision > confirmed org memory > user preference >
   inferred candidate`) is resolved ONLY by `resolveOrganizationDecision`. The
   compiler groups layers by subject and calls the one resolver per subject; it
   never re-derives ordering. A memory a higher layer outranks is recorded as
   `overridden` (never dropped silently) and never placed in `applied` — so
   memory cannot become hidden policy.

3. **Three states throughout.** Each section is `consulted` (results possibly
   empty — "nothing applies") or `not_consulted` with a DISTINCT reason ("the
   store was not read", or "no mission bound"). The two never collapse — the
   repo's dominant defect shape, applied here to an artifact that reaches a model.

4. **Verification carries its validity, decided by one authority.** The compiler
   preserves the three standings emitted by `classifyMissionVerificationEvidence`
   (`current_evidence`, `stale_evidence`, `no_current_evidence` + four absence
   reasons) verbatim. It never re-derives currency and never loosens the
   snapshot-identity relevance rule. Only `current_evidence` renders as current.

5. **Explainability is filled in, not aspired to.** The compiler writes
   `trajectories.context_refs_json` — the previously empty slot — with references
   and digests of the context that was supplied and used. Never chain-of-thought.

6. **Reuse, do not duplicate.** The graph section runs the existing
   `compileFettlerImpactContext`; there is no second graph projector.

Injection into the live Fettler model seam is gated behind a default-off switch
(`MENDPOINT_INHERITED_CONTEXT`). With it unset the prompt is byte-for-byte
today's constant.

## Consequences

- The Fettler agent can, for the first time, receive tenant organization memory
  in its prompt (behind the switch). A Fettler `agent.run` job is not bound to a
  formal `mission` row on current main, so mission-scoped sections report
  `no_mission_bound`; the tenant-scoped organization memory still applies. When a
  Fettler job becomes mission-bound (a separate, acknowledged gap), decisions,
  exceptions, verification, and history light up with no further change here.
- `context_refs_json` gains its first writer.
- The envelope is bounded (32 KB ceiling, 32 items per section, house-style text
  and identifier limits). An unbounded dump is treated as a failure, not a
  fallback.

## Alternatives considered

- **Compile inside the agent.** Rejected: the agent has no DB handle at the seam
  and must stay isolated; a DB dependency there would be a larger, riskier change.
- **Write `context_refs_json` from the ReGauge trajectory writer.** Rejected: the
  ReGauge/transformer path runs deterministic recipes and never receives the
  compiled context, so recording it as "supplied" would claim a receipt that did
  not happen — the same dishonesty the three-state discipline exists to prevent.
- **A second, unbounded graph projection for the model.** Rejected in favour of
  reusing `compileFettlerImpactContext`.
