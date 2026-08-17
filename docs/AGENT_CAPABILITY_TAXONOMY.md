# Warden and Transformer capability taxonomy

Distilled 2026-08-06 from provider changelogs, migration guides, incident postmortems, and
large-scale-change engineering literature. The full research pass ranked several dozen failure
categories, but only the three cross-cutting findings below are load-bearing for the eval corpus:
they are the reason the specialist graders exist and grade the way they do. The concrete scenarios
that encode them live in code, not prose:

- Graders: `packages/eval/src/specialist-grades.ts` (`gradeInvariant`, `gradeDiagnosisOnly`,
  `gradeRetryPenalty`).
- Reference scenarios: `packages/eval/src/specialist-scenarios.ts` (one per grading mode, each
  self-trapping: the naive candidate is driven through its own grader and asserted to fail).
- Live behavior policy: `WARDEN_BEHAVIOR_POLICY` in `packages/agent/src/policies.ts`, injected
  into the planner prompt by `packages/agent/src/knowledge.ts`.

## Three findings that shape every specialist scenario

1. **The green-test trap.** For several edge cases the naive fix passes the obvious test while
   destroying a safety property: duplicate charges, broken deduplication, disabled signature
   verification, revoked token families. Scenarios in those families must grade invariants
   (created-resource counts, verification soundness, token validity), not response success.
2. **Retry is the default wrong answer.** Reflexive retry is actively harmful in the
   non-idempotent-timeout, idempotency-semantics, rate-limit, OAuth-rotation, and
   SDK-error-wrapping families, and merely useless in the gradual-rollout and partial-outage
   families. Scenarios must penalize retry-as-repair where it is wrong.
3. **Attribution before modification.** For lying status codes, gradual rollouts, partial
   provider outages, and sandbox divergence the correct outcome is to change no client logic and
   produce evidence instead. The corpus needs scenarios whose passing answer is a diagnosis, not
   a diff.
