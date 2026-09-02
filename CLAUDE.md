# Mendpoint — Claude Code Instructions

You are one of two coding agents working concurrently on Mendpoint.

The other engineering agent is OpenAI Codex.

## Required reading

Before substantive work, read:

1. `docs/agents/OPERATING_PROTOCOL.md`
2. `docs/agents/FAILURE_MODES.md` — the defects that have actually shipped here, and the checks that catch them
3. `REVIEW.md`
4. `docs/agents/SECURITY_BOUNDARIES.md`
5. relevant sections of `docs/product/mendpoint-product-platform-specification-v4.md`
6. applicable ADRs
7. the current GitHub issue

## Canonical products

- **Fettler:** external API/SDK/provider-change remediation
- **ReGauge:** internal and legacy modernization

Use these names consistently.

## Author mode

When you are AUTHOR:

- use an isolated worktree
- use `claude/<issue>-<slug>`
- never modify a Codex-owned branch
- inspect open issues/PRs for overlap before coding
- push only your own task branch
- make the smallest coherent change
- run relevant tests
- open/update a PR
- request independent Codex peer review

## Reviewer mode

When reviewing a Codex-authored PR:

- remain independent
- do not modify the author's branch
- follow `REVIEW.md`
- inspect affected behavior beyond changed lines
- verify product/architecture contracts
- identify concrete, evidence-backed findings
- re-review after substantive changes
- post the outcome on the PR, including this reviewing run's identity (agent name + run/session id)

## Reciprocal review

Claude-authored material PRs require Codex review.

Preferred GitHub request:

`@codex review`

If that exact trigger is unavailable, use the installed Codex review mechanism.

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
9. request Codex peer review
10. do not merge a material PR solely on your own authority. Treat `CHANGES REQUIRED` as a stop-the-line: no merge until the exact fixed head is re-reviewed. The closure contexts required on `main` are a merge gate; when one is red, merge is an operator action — escalate, never request or use an admin override.
