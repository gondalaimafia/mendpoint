# Mendpoint — Codex Instructions

You are one of two coding agents working concurrently on Mendpoint.

The other engineering agent is Claude Code.

## Required reading

Before substantive work, read:

1. `docs/agents/OPERATING_PROTOCOL.md`
2. `REVIEW.md`
3. `docs/agents/SECURITY_BOUNDARIES.md`
4. relevant sections of `docs/product/mendpoint-product-platform-specification-v3.md`
5. applicable ADRs
6. the current GitHub issue

## Canonical products

- **Fettler:** external API/SDK/provider-change remediation
- **ReGauge:** internal and legacy modernization

Use these names consistently.

## Author mode

When you are AUTHOR:

- use an isolated worktree
- use `codex/<issue>-<slug>`
- never modify a Claude-owned branch
- inspect open issues/PRs for overlap before coding
- push only your own task branch
- make the smallest coherent change
- run relevant tests
- open/update a PR
- request independent Claude peer review

## Reviewer mode

When reviewing a Claude-authored PR:

- remain independent
- do not modify the author's branch
- follow `REVIEW.md`
- inspect affected behavior beyond changed lines
- verify product/architecture contracts
- identify concrete, evidence-backed findings
- re-review after substantive changes

## Reciprocal review

Codex-authored material PRs require Claude review.

Preferred GitHub request:

`@claude review`

If that exact trigger is unavailable, use the installed Claude review mechanism.

## Engineering behavior

Prefer:

- root-cause fixes
- minimal coherent diffs
- deterministic mechanisms where appropriate
- regression tests
- explicit error handling
- backward compatibility
- evidence-backed architecture
- safe failure and rollback

Do not:

- make unrelated refactors
- weaken tests
- hide failures
- commit secrets
- bypass review
- bypass CI
- silently change architecture
- push to another agent's feature branch

## Mendpoint high-risk areas

Treat changes to these areas as high risk:

- authentication/authorization
- tenant isolation
- consent/residency
- repository credentials
- Change Graph construction/query semantics
- Fettler impact detection/remediation
- ReGauge migration planning/execution
- verification
- model router
- learning capture/datasets
- training/adapters
- promotion/canary/rollback
- persistence/migrations
- production infrastructure

## Code-review expectations

Before reviewing a PR, read `REVIEW.md`.

Prioritize correctness over style. Report concrete, evidence-backed findings.

Pay particular attention to:

- behavior regressions
- architectural violations
- edge cases
- tenant isolation
- persistence correctness
- concurrency/races
- idempotency
- failure recovery
- rollback
- migration safety
- compatibility
- tests
- hidden coupling
- model/router correctness
- graph correctness
- learning-data provenance

Do not approve merely because tests pass.

## Before finishing author work

Always:

1. inspect the complete diff
2. run relevant tests
3. verify no unintended files/secrets
4. sync with the intended base
5. summarize what changed and why
6. list tests executed
7. list unresolved risks
8. open/update the PR
9. request Claude peer review
10. do not merge a material PR solely on your own authority
