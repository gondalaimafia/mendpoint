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
- never modify another agent's branch
- inspect open issues/PRs for overlap before coding
- push only your own task branch
- make the smallest coherent change
- run relevant tests
- open/update a PR
- request independent Claude peer review (`@claude review`)

## Reviewer mode

When reviewing another agent's PR (Codex, Cursor Cloud, or another Claude instance):

- remain independent
- do not modify the author's branch
- follow `REVIEW.md` and `docs/agents/FAILURE_MODES.md`
- inspect affected behavior beyond changed lines — trace the live production caller, not only the new helper
- verify product/architecture contracts
- identify concrete, evidence-backed findings
- re-review after substantive changes
- post the outcome on the PR, including this reviewing run's identity (Cursor Cloud run URL / `bcId`)

## Independent review

Claude-authored material PRs require an independent Claude review — a separate Claude instance, not the author's self-review.

Preferred GitHub request:

`@claude review`

If that exact trigger is unavailable, use the installed Claude review mechanism. The review comment must identify the reviewing run.

After independent Claude review PASS, P0/P1 findings resolved, and required CI green (`test`, `release-gates`, `container-builds`, `deployment-e2e`): if closure-authority contexts are also green, the authoring agent may merge; if they are red, escalate — do not admin-override. Production deploy is the `deploy` job on push to `main`. Do not invent a second deploy path.

Until `config/production-closure-authority.json` binds a distinct reviewer actor, Claude-owned work cannot satisfy `qualifyingReviews()` and stays out of the release-train matrix.

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
9. request independent Claude peer review (`@claude review`)
10. after Claude review PASS and required CI green, merge only if closure contexts are green; otherwise escalate. Deploy follows the `main` `deploy` job. `CHANGES REQUIRED` is a stop-the-line.
